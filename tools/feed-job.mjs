#!/usr/bin/env node
/**
 * The feed agent's run: build the blocklist, sign it, publish it — bounded,
 * exclusive, observable and pinned.
 *
 *   node tools/feed-job.mjs              # a manual refresh: publish now, from origin/main
 *   node tools/feed-job.mjs --agent      # what launchd runs: --if-stale --follow
 *   node tools/feed-job.mjs --if-stale   # publish only when the served feed is older than its interval
 *   node tools/feed-job.mjs --follow     # fast-forward this (agent-owned) checkout to origin/main first
 *   node tools/feed-job.mjs --unpinned   # emergency: publish from a checkout not at origin/main (recorded)
 *
 * What each property answers (the lifecycle audit, raw/okolos.md):
 *
 *   - bounded (F4, LC-02, LC-03): every stage is a child in its own process group
 *     with a deadline, and the whole run has a watchdog far shorter than the
 *     twelve-hour interval. A hung run used to stay "running" and launchd skips
 *     every later interval while a job runs — protection updates stopped silently.
 *   - exclusive (LC-03): one lock shared with every manual entry point; the stages
 *     inherit it. Two overlapping runs used to sign two different `N+1` feeds.
 *   - observable (F3, LC-12): a durable, rotated, owner-only log in
 *     ~/Library/Logs/Okolos and a status record per run with the failure count, in
 *     place of a `/tmp` file wiped at every boot. A failure is retried with backoff
 *     inside the run instead of waiting twelve hours.
 *   - pinned (F2): it publishes only from a clean checkout at origin/main. The agent
 *     runs from its own checkout (~/.okolos/agent-checkout) and fast-forwards it;
 *     a developer's clone on a feature branch is refused rather than run against
 *     production.
 *   - least secret (F2): the Cloudflare token reaches only the publish step. The
 *     secret runner (`OKOLOS_SECRET_RUNNER`, a JSON argv the installer writes)
 *     wraps that step alone, and an inherited token is stripped from every other.
 *   - a login is not a publish: with --if-stale a run whose served feed is younger
 *     than its interval records "skipped" and ends. RunAtLoad used to publish a new
 *     version at every login.
 */
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { killAllGroups, runBounded } from './feed/bounded.mjs'
import { acquireLock, LockHeldError } from './feed/lock.mjs'
import { capFile, cleanLine, openLog } from './feed/log.mjs'
import { feedPaths } from './feed/paths.mjs'
import { DEFAULT_WORKER, readServed } from './feed/served.mjs'
import { writeStatus } from './feed/status.mjs'
import { directoriesIn } from './tree.mjs'

const REPO = path.resolve(import.meta.dirname, '..')

/** The agent's interval, as the plist states it (ADR-0010: the source's own cycle). */
export const INTERVAL_MS = 12 * 60 * 60 * 1000
/** A served feed younger than this is fresh: an hour under the interval, so a scheduled run is never skipped. */
export const STALE_AFTER_MS = INTERVAL_MS - 60 * 60 * 1000
/** The whole run, every retry included. Far under the interval, so launchd never skips a slot. */
export const WATCHDOG_MS = 30 * 60 * 1000

export const DEADLINES = {
  git: 90_000,
  install: 10 * 60_000,
  ingest: 3 * 60_000,
  publish: 6 * 60_000,
}

/** Exit codes a host can tell apart. */
export const EXIT = { ok: 0, failed: 1, lockHeld: 75, watchdog: 124, signal: 143 }

/** Variables that carry the Cloudflare credential; never handed to a stage that does not publish. */
const SECRET_VARIABLES = ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_API_KEY']

function withoutSecrets(env) {
  const copy = { ...env }
  for (const name of SECRET_VARIABLES) delete copy[name]
  return copy
}

/**
 * Removes what older versions and dead runs left in the temp directory.
 *
 * Older publishes wrote fixed names into $TMPDIR and never removed them; current
 * ones use a private `okolos-feed-*` directory removed in `finally`, so one older
 * than a day belongs to a run that was killed. Returns the names removed.
 */
export function sweepLeftovers(tmp = tmpdir(), now = Date.now()) {
  const removed = []
  for (const name of ['okolos-feed-signed.json', 'okolos-feed-publish.sql']) {
    if (!existsSync(path.join(tmp, name))) continue
    rmSync(path.join(tmp, name), { force: true })
    removed.push(name)
  }
  let directories = []
  try {
    directories = directoriesIn(tmp)
  } catch {
    return removed
  }
  for (const name of directories) {
    if (!name.startsWith('okolos-feed-')) continue
    const dir = path.join(tmp, name)
    try {
      if (now - statSync(dir).mtimeMs <= 24 * 60 * 60 * 1000) continue
    } catch {
      continue
    }
    rmSync(dir, { recursive: true, force: true })
    removed.push(name)
  }
  return removed
}

function describeFailure(result) {
  if (result.timedOut) return 'timed out; its process group was killed'
  if (result.error) return `could not start: ${result.error}`
  const said = cleanLine((result.stderr || result.stdout || '').trim().split('\n').at(-1) ?? '')
  return `exited ${result.code ?? result.signal}${said ? ` — ${said}` : ''}`
}

/** The secret runner's argv, or null when there is none. Throws on one it cannot read. */
function secretRunner(env) {
  const raw = env.OKOLOS_SECRET_RUNNER
  if (!raw) return null
  let argv
  try {
    argv = JSON.parse(raw)
  } catch {
    throw new Error('OKOLOS_SECRET_RUNNER is not a JSON array of words; reinstall the agent')
  }
  if (!Array.isArray(argv) || argv.length === 0 || argv.some((word) => typeof word !== 'string')) {
    throw new Error('OKOLOS_SECRET_RUNNER must be a non-empty JSON array of strings; reinstall the agent')
  }
  return argv
}

/** Thrown inside the run to end it at a named stage with a reason. */
class StageFailure extends Error {
  constructor(stage, reason, exit = EXIT.failed) {
    super(reason)
    this.stage = stage
    this.exit = exit
  }
}

/**
 * One run. Returns the status record it wrote (or, for a refused lock, the record
 * it did not write). Every external effect is a parameter.
 */
export async function runJob({
  root = REPO,
  paths = feedPaths(),
  env = process.env,
  flags = {},
  run = runBounded,
  tool = runBounded,
  fetchImpl = fetch,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  watchdogMs = WATCHDOG_MS,
  graceMs = 5000,
  retries = { attempts: 3, backoffMs: [30_000, 120_000] },
  log,
  node = process.execPath,
  tmp = tmpdir(),
  onStage = () => {},
} = {}) {
  const iso = () => new Date(now()).toISOString()
  const startedAt = iso()

  // The log first, so even a refused lock leaves a line.
  let write = log
  if (!write) {
    capFile(paths.launchdLog)
    const file = openLog(paths.log, { now })
    write = (line) => {
      file.write(line)
      if (process.stdout.isTTY) console.log(cleanLine(line))
    }
  }

  let lock
  try {
    lock = acquireLock(paths.lock)
  } catch (cause) {
    if (!(cause instanceof LockHeldError)) throw cause
    write(`refused: ${cause.message}`)
    // Not written to the status file: that record belongs to the run holding the lock.
    return { startedAt, at: iso(), outcome: 'refused', stage: 'lock', exit: EXIT.lockHeld, reason: cause.message }
  }

  let stage = 'start'
  let aborted = false
  const facts = { commit: null, pinned: true, version: undefined, entries: undefined }
  const setStage = (next) => {
    stage = next
    onStage(next)
    write(`── ${next}`)
  }
  const finish = (record) => writeStatus(paths.status, { startedAt, at: iso(), ...facts, ...record })

  const stageEnv = { ...withoutSecrets(env), OKOLOS_FEED_LOCK: lock.token }
  const gitEnv = {
    ...withoutSecrets(env),
    GIT_TERMINAL_PROMPT: '0',
    GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o ConnectTimeout=15',
  }
  const git = (args) => tool('git', ['-C', root, ...args], { env: gitEnv, timeoutMs: DEADLINES.git })
  const echo = (_stream, line) => write(`   ${line}`)

  /** Runs `attempt` until it exits 0, with backoff between tries; returns the last result. */
  async function withRetries(name, attempt) {
    let result
    for (let index = 0; index < retries.attempts; index += 1) {
      if (aborted) break
      result = await attempt()
      if (result.code === 0) return result
      write(`${name}: ${describeFailure(result)} (attempt ${index + 1} of ${retries.attempts})`)
      if (index < retries.attempts - 1 && !aborted) {
        await sleep(retries.backoffMs[index] ?? retries.backoffMs.at(-1) ?? 0)
      }
    }
    return result
  }

  async function stages() {
    setStage('sweep')
    for (const name of sweepLeftovers(tmp, now())) write(`   removed a leftover: ${name}`)

    setStage('config')
    let runner
    try {
      runner = secretRunner(env)
    } catch (cause) {
      throw new StageFailure('config', cause.message)
    }

    setStage('pin')
    const fetched = await withRetries('git fetch', () => git(['fetch', '--quiet', 'origin', 'main']))
    if (fetched?.code !== 0) throw new StageFailure('pin', `git fetch: ${describeFailure(fetched)}`)
    const dirty = await git(['status', '--porcelain', '--untracked-files=no'])
    if (dirty.code !== 0) throw new StageFailure('pin', `git status: ${describeFailure(dirty)}`)
    if (dirty.stdout.trim() !== '') {
      throw new StageFailure('pin', `the checkout has local changes, so it is not origin/main: ${dirty.stdout.trim().split('\n').join('; ')}`)
    }
    const head = (await git(['rev-parse', 'HEAD'])).stdout.trim()
    const target = (await git(['rev-parse', 'origin/main'])).stdout.trim()
    if (!/^[0-9a-f]{40}$/.test(head) || !/^[0-9a-f]{40}$/.test(target)) {
      throw new StageFailure('pin', 'could not read HEAD or origin/main')
    }
    facts.commit = head
    if (head !== target) {
      if (flags.follow) {
        const depsMoved =
          (await git(['diff', '--quiet', head, target, '--', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'apps/proxy/package.json'])).code !== 0
        const checkout = await git(['checkout', '--quiet', '--detach', target])
        if (checkout.code !== 0) throw new StageFailure('pin', `git checkout: ${describeFailure(checkout)}`)
        facts.commit = target
        write(`   fast-forwarded ${head.slice(0, 7)} → ${target.slice(0, 7)}`)
        const wrangler = path.join(root, 'apps/proxy/node_modules/.bin/wrangler')
        if (depsMoved || !existsSync(wrangler)) {
          // No token here: the install talks to the registry, and nothing that does
          // holds the production credential.
          const installed = await tool('pnpm', ['install', '--frozen-lockfile', '--filter', '@okolos/proxy'], {
            cwd: root,
            env: withoutSecrets(env),
            timeoutMs: DEADLINES.install,
            onLine: echo,
          })
          if (installed.code !== 0) throw new StageFailure('pin', `pnpm install: ${describeFailure(installed)}`)
        }
      } else if (flags.unpinned) {
        facts.pinned = false
        write(`   UNPINNED: publishing from ${head.slice(0, 7)}, not origin/main ${target.slice(0, 7)} — recorded in the status`)
      } else {
        throw new StageFailure(
          'pin',
          `HEAD ${head.slice(0, 7)} is not origin/main ${target.slice(0, 7)}: production publishes run only from ` +
            `origin/main (F2). Land the change first, or let the agent publish from its own checkout; ` +
            `--unpinned overrides for an emergency and is recorded.`,
        )
      }
    }

    if (flags.ifStale) {
      setStage('fresh')
      try {
        const served = await readServed({ base: env.OKOLOS_WORKER_URL ?? DEFAULT_WORKER, fetchImpl })
        const at = served.state === 'served' && served.updatedAt ? Date.parse(served.updatedAt) : NaN
        if (Number.isFinite(at) && now() - at < STALE_AFTER_MS) {
          const hours = ((now() - at) / 3_600_000).toFixed(1)
          write(`   the served feed v${served.version} is ${hours} h old — younger than its interval, nothing to do`)
          return { outcome: 'skipped', stage: 'fresh', exit: EXIT.ok, reason: `served feed is ${hours} h old` }
        }
      } catch (cause) {
        // Not fatal here: the ingest asks the same question and retries it.
        write(`   could not read the served feed (${cause.message}); refreshing anyway`)
      }
    }

    setStage('ingest')
    const ingested = await withRetries('ingest', () =>
      run(node, [path.join(root, 'tools/ingest.mjs'), '--out', paths.feed], {
        cwd: root,
        env: stageEnv,
        timeoutMs: DEADLINES.ingest,
        graceMs,
        onLine: echo,
      }),
    )
    if (ingested?.code !== 0) throw new StageFailure('ingest', describeFailure(ingested ?? {}))
    try {
      const body = JSON.parse(readFileSync(paths.feed, 'utf8')).body
      facts.version = body.version
      facts.entries = body.entries.length
    } catch (cause) {
      throw new StageFailure('ingest', `the ingest wrote no readable feed: ${cause.message}`)
    }

    setStage('publish')
    const command = [...(runner ?? []), node, path.join(root, 'tools/publish-feed.mjs'), paths.feed]
    const published = await withRetries('publish', () =>
      run(command[0], command.slice(1), {
        cwd: root,
        // The one stage that may hold the credential: inherited, or set by the runner.
        env: {
          ...env,
          OKOLOS_FEED_LOCK: lock.token,
          WRANGLER_SEND_METRICS: 'false',
          // Wrangler's error logs went to a shared global folder, never rotated (47
          // files by 2026-10-03). Here they sit with the product's own, and the
          // pinned wrangler removes its logs older than thirty days itself.
          WRANGLER_LOG_PATH: path.join(paths.logs, 'wrangler'),
        },
        timeoutMs: DEADLINES.publish,
        graceMs,
        onLine: echo,
      }),
    )
    if (published?.code !== 0) throw new StageFailure('publish', describeFailure(published ?? {}))

    return { outcome: 'published', stage: 'done', exit: EXIT.ok }
  }

  let timer
  const watchdog = new Promise((resolve) => {
    timer = setTimeout(() => resolve('watchdog'), watchdogMs)
  })
  try {
    const outcome = await Promise.race([
      stages().then(
        (record) => ({ record }),
        (cause) => ({ cause }),
      ),
      watchdog.then(() => ({ watchdog: true })),
    ])
    if (outcome.watchdog) {
      aborted = true
      write(`watchdog: the run passed ${Math.round(watchdogMs / 1000)} s in stage ${stage}; killing its children`)
      await killAllGroups(graceMs)
      return finish({ outcome: 'failed', stage, exit: EXIT.watchdog, reason: `watchdog: over ${Math.round(watchdogMs / 1000)} s` })
    }
    if (outcome.cause) {
      const cause = outcome.cause
      const failedStage = cause instanceof StageFailure ? cause.stage : stage
      write(`failed in ${failedStage}: ${cause.message}`)
      return finish({ outcome: 'failed', stage: failedStage, exit: cause.exit ?? EXIT.failed, reason: cause.message })
    }
    write(`${outcome.record.outcome}${facts.version ? ` v${facts.version}, ${facts.entries} entries` : ''}`)
    return finish(outcome.record)
  } finally {
    clearTimeout(timer)
    lock.release()
  }
}

/** Ends the run on SIGTERM/SIGINT the same way the watchdog does: children killed, status written. */
function onSignal(signal, current) {
  void (async () => {
    await killAllGroups(2000)
    try {
      writeStatus(feedPaths().status, {
        startedAt: current.startedAt,
        at: new Date().toISOString(),
        outcome: 'failed',
        stage: current.stage,
        exit: EXIT.signal,
        reason: `stopped by ${signal}`,
      })
    } finally {
      process.exit(EXIT.signal)
    }
  })()
}

async function main() {
  const argv = process.argv.slice(2)
  const agent = argv.includes('--agent')
  const current = { stage: 'start', startedAt: new Date().toISOString() }
  process.on('SIGTERM', () => onSignal('SIGTERM', current))
  process.on('SIGINT', () => onSignal('SIGINT', current))
  const record = await runJob({
    flags: {
      ifStale: agent || argv.includes('--if-stale'),
      follow: agent || argv.includes('--follow'),
      unpinned: argv.includes('--unpinned'),
    },
    onStage: (stage) => {
      current.stage = stage
    },
  })
  process.exit(record.exit)
}

if (import.meta.filename === process.argv[1]) {
  main().catch((cause) => {
    console.error(`feed-job: ${cause instanceof Error ? cause.stack : String(cause)}`)
    process.exit(EXIT.failed)
  })
}
