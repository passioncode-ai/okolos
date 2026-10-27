#!/usr/bin/env node
/**
 * The feed agent's entry point: what launchd starts, from outside the checkout (B-159).
 *
 *   node ~/.okolos/bin/feed-agent/bootstrap.mjs     # what the plist runs
 *
 * The plist used to run `cd ~/.okolos/agent-checkout && exec node tools/feed-job.mjs`.
 * From 2026-10-09 to 2026-10-26 that folder was gone (B-149; who removed it is
 * B-150): every run died in the shell with `cd: … No such file or directory`, the
 * job never started, `feed-status.json` was never written, `consecutiveFailures`
 * stayed 0, and production served a seventeen-day-old feed with nothing raising
 * an alarm. The failure lived in the one place nothing recorded.
 *
 * So the plist now starts this file, which the installer copies to
 * ~/.okolos/bin/feed-agent together with the modules it imports (BOOTSTRAP_FILES;
 * nothing from outside tools/feed, so the copy runs without the checkout). It:
 *
 *   1. checks the checkout (present, holds tools/feed-job.mjs, a git work tree of
 *      its own); a broken one is moved to `<checkout>.broken` as evidence;
 *   2. recreates a missing or broken one at origin/main, as ADR-0017 describes it:
 *      a detached worktree of the clone the installer ran from, or, when that
 *      clone is gone too, a clone of its origin; then installs the publish tools;
 *   3. runs the job from it, telling it whether the checkout was recovered, so
 *      the job's record carries `recoveredCheckout: true` (B-150's evidence);
 *   4. writes the status record itself on every path the job cannot: stage
 *      `checkout` when recovery fails, stage `job` when the job died without
 *      writing its own. Each counts towards `consecutiveFailures`.
 *
 * It holds the run lock only while it repairs the checkout and releases it before
 * the job starts, because the job takes the same lock. The job keeps its own
 * deadlines, watchdog and "skipped when the served feed is under 11 h old" rule;
 * this file adds a backstop deadline over the whole job and nothing else.
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, realpathSync, renameSync, rmSync } from 'node:fs'
import path from 'node:path'

import { killAllGroups, runBounded } from './bounded.mjs'
import { isEntry } from './entry.mjs'
import { acquireLock, LockHeldError } from './lock.mjs'
import { capFile, cleanLine, openLog } from './log.mjs'
import { feedPaths } from './paths.mjs'
import { readStatus, writeStatus } from './status.mjs'

/** What the installer copies beside launchd: this file and every module it imports. */
export const BOOTSTRAP_FILES = ['bootstrap.mjs', 'bounded.mjs', 'entry.mjs', 'lock.mjs', 'log.mjs', 'paths.mjs', 'status.mjs']

/** The same codes as tools/feed-job.mjs (a test holds them equal), so a host reads one table. */
export const EXIT = { ok: 0, failed: 1, lockHeld: 75, watchdog: 124, signal: 143 }

/** Per child, as the job and the installer bound the same commands. */
export const RECOVERY_DEADLINES = { git: 90_000, worktree: 120_000, clone: 5 * 60_000, install: 10 * 60_000 }

/** The job's own watchdog is thirty minutes; this only catches a job that ignores it. */
export const JOB_DEADLINE_MS = 35 * 60_000

/** How many of the job's last output lines are kept to name a failure. */
export const JOB_TAIL_LINES = 50

// A line that starts with an error's name ("TypeError: …", "Error [ERR_…]: …") or
// says "error:". Not any line containing "Error": Node prints the throwing source
// line above the error, and that line usually names the error class too.
const ERROR_LINE = /^(?:Uncaught\s+)?[\w.]*(?:Error|Exception)\b|\berror:/

/**
 * The line that says why: the first one in `lines` that reads as an error, else
 * the last non-empty one. A Node crash ends with "Node.js v<version>", which
 * names nothing; the TypeError above it does.
 */
export function reasonFrom(lines) {
  const kept = lines.map((line) => cleanLine(line).trim()).filter((line) => line !== '')
  return kept.find((line) => ERROR_LINE.test(line)) ?? kept.at(-1) ?? ''
}

const SECRET_VARIABLES = ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_API_KEY']

function quietEnv(env) {
  const copy = { ...env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o ConnectTimeout=15' }
  for (const name of SECRET_VARIABLES) delete copy[name]
  return copy
}

function describe(result) {
  if (result.timedOut) return 'timed out; its process group was killed'
  if (result.error) return `could not start: ${result.error}`
  const said = cleanLine((result.stderr || result.stdout || '').trim().split('\n').at(-1) ?? '')
  return `exited ${result.code ?? result.signal}${said ? ` — ${said}` : ''}`
}

/** The canonical spelling: `.native` expands Windows 8.3 short names and forward slashes, as git prints them. */
function real(file) {
  try {
    return realpathSync.native(file)
  } catch {
    return path.resolve(file)
  }
}

/**
 * `{ state: 'ok' }`, `{ state: 'missing', reason }` or `{ state: 'broken', reason }`.
 * Broken: the folder is there, but it lacks the job, or git cannot read it, or git
 * says it belongs to some other work tree (a folder inside another repository).
 */
export async function checkoutHealth({ checkout, tool = runBounded, env = process.env }) {
  if (!existsSync(checkout)) return { state: 'missing', reason: `${checkout} does not exist` }
  if (!existsSync(path.join(checkout, 'tools', 'feed-job.mjs'))) {
    return { state: 'broken', reason: 'it has no tools/feed-job.mjs' }
  }
  const top = await tool('git', ['-C', checkout, 'rev-parse', '--show-toplevel'], {
    env: quietEnv(env),
    timeoutMs: RECOVERY_DEADLINES.git,
  })
  if (top.code !== 0) return { state: 'broken', reason: `git cannot read it: ${describe(top)}` }
  const owner = top.stdout.trim()
  if (real(owner) !== real(checkout)) return { state: 'broken', reason: `git places it inside ${owner}, not a work tree of its own` }
  return { state: 'ok' }
}

/**
 * Recreates the checkout at origin/main: a detached worktree of `sourceRepo` when
 * that clone is still a repository, else a clone of `origin`. Then the publish
 * tools only. Returns `{ how, commit }`; throws a sentence naming the step that
 * failed.
 */
export async function recoverCheckout({ checkout, sourceRepo, origin, tool = runBounded, env = process.env }) {
  const quiet = quietEnv(env)
  const git = (args, timeoutMs = RECOVERY_DEADLINES.git) => tool('git', args, { env: quiet, timeoutMs })
  const must = (label, result) => {
    if (result.code !== 0) throw new Error(`${label}: ${describe(result)}`)
    return result
  }

  const sourceUsable =
    Boolean(sourceRepo) && existsSync(sourceRepo) && (await git(['-C', sourceRepo, 'rev-parse', '--git-dir'])).code === 0

  let how
  if (sourceUsable) {
    // A folder deleted under git still has its worktree entry; `add` refuses that
    // path ("missing but already registered") until the entry is pruned.
    must('git worktree prune', await git(['-C', sourceRepo, 'worktree', 'prune']))
    must('git fetch', await git(['-C', sourceRepo, 'fetch', '--quiet', 'origin', 'main']))
    must(
      'git worktree add',
      await git(['-C', sourceRepo, 'worktree', 'add', '--detach', checkout, 'origin/main'], RECOVERY_DEADLINES.worktree),
    )
    how = `a worktree of ${sourceRepo}`
  } else if (origin) {
    mkdirSync(path.dirname(checkout), { recursive: true })
    must('git clone', await git(['clone', '--quiet', '--no-checkout', origin, checkout], RECOVERY_DEADLINES.clone))
    must('git checkout', await git(['-C', checkout, 'checkout', '--quiet', '--detach', 'origin/main']))
    how = `a clone of ${origin}`
  } else {
    throw new Error(
      `no source to recreate it from: the clone it was installed from (${sourceRepo || 'none recorded'}) is not a ` +
        `repository and no origin URL is recorded. Run pnpm feed:agent from a clone of the repository.`,
    )
  }

  if (!existsSync(path.join(checkout, 'tools', 'feed-job.mjs'))) {
    throw new Error(`${how} at origin/main has no tools/feed-job.mjs`)
  }
  // No token here: the install talks to the registry.
  must(
    'pnpm install',
    await tool('pnpm', ['install', '--frozen-lockfile', '--filter', '@okolos/proxy'], {
      cwd: checkout,
      env: quiet,
      timeoutMs: RECOVERY_DEADLINES.install,
    }),
  )
  const commit = must('git rev-parse', await git(['-C', checkout, 'rev-parse', 'HEAD'])).stdout.trim()
  return { how, commit }
}

/**
 * One agent run: repair the checkout if it needs it, run the job, and make sure a
 * record exists for how it ended. Returns `{ exit, record }`; `record` is null
 * only when another run held the lock (that record is the other run's).
 */
export async function runAgent({
  paths = feedPaths(),
  env = process.env,
  tool = runBounded,
  run = runBounded,
  node = process.execPath,
  now = Date.now,
  log,
  runId = randomUUID(),
  jobDeadlineMs = JOB_DEADLINE_MS,
  onStage = () => {},
  // The bootstrap's stderr is launchd's StandardErrorPath (feed.launchd.log).
  relay = (line) => process.stderr.write(`${line}\n`),
} = {}) {
  const iso = () => new Date(now()).toISOString()
  const startedAt = iso()
  const checkout = paths.agentCheckout

  let write = log
  if (!write) {
    capFile(paths.launchdLog)
    const file = openLog(paths.log, { now })
    write = (line) => file.write(line)
  }

  let recovered = null
  const fail = (stage, exit, reason) => {
    write(`failed in ${stage}: ${reason}`)
    return writeStatus(paths.status, {
      startedAt,
      at: iso(),
      outcome: 'failed',
      stage,
      exit,
      reason,
      runId,
      recoveredCheckout: Boolean(recovered),
      ...(recovered ? { recovery: recovered } : {}),
    })
  }

  write('── checkout')
  onStage('checkout')
  let lock
  try {
    lock = acquireLock(paths.lock)
  } catch (cause) {
    if (cause instanceof LockHeldError) {
      write(`refused: ${cause.message}`)
      return { exit: EXIT.lockHeld, record: null }
    }
    return { exit: EXIT.failed, record: fail('checkout', EXIT.failed, `could not take the run lock: ${cause.message}`) }
  }

  try {
    const health = await checkoutHealth({ checkout, tool, env })
    if (health.state !== 'ok') {
      const what = health.state === 'missing' ? 'is missing' : `is broken (${health.reason})`
      write(`checkout: ${checkout} ${what}; recreating it at origin/main`)
      if (health.state === 'broken') {
        const aside = `${checkout}.broken`
        rmSync(aside, { recursive: true, force: true })
        renameSync(checkout, aside)
        write(`   moved the broken checkout to ${aside}`)
      }
      let done
      try {
        done = await recoverCheckout({ checkout, sourceRepo: env.OKOLOS_SOURCE_REPO, origin: env.OKOLOS_ORIGIN_URL, tool, env })
      } catch (cause) {
        throw new Error(`the checkout ${what} and could not be recreated: ${cause.message}`)
      }
      recovered = health.state === 'missing' ? 'missing' : `broken: ${health.reason}`
      write(`checkout: recreated ${checkout} as ${done.how} at ${done.commit.slice(0, 7)} (recoveredCheckout: true)`)
    }
  } catch (cause) {
    recovered = null
    return { exit: EXIT.failed, record: fail('checkout', EXIT.failed, cause instanceof Error ? cause.message : String(cause)) }
  } finally {
    lock.release()
  }

  write('── job')
  onStage('job')
  const spawnedAt = iso()
  const jobEnv = { ...env, OKOLOS_RUN_ID: runId }
  if (recovered) jobEnv.OKOLOS_RECOVERED_CHECKOUT = recovered
  else delete jobEnv.OKOLOS_RECOVERED_CHECKOUT
  // What the job prints (a crash's error and stack, mostly: its own lines go to
  // feed.log directly) is passed on to launchd's log and feed.log as it arrives,
  // and the last JOB_TAIL_LINES are kept to name the failure.
  const tail = []
  const result = await run(node, [path.join(checkout, 'tools', 'feed-job.mjs'), '--agent'], {
    cwd: checkout,
    env: jobEnv,
    timeoutMs: jobDeadlineMs,
    onLine: (_stream, line) => {
      relay(line)
      write(`   ${line}`)
      tail.push(line)
      if (tail.length > JOB_TAIL_LINES) tail.shift()
    },
  })

  const after = readStatus(paths.status)
  // A job from before this change writes no runId; its record is still its own
  // when it was written after the job started.
  const own = after && (after.runId === runId || (!after.runId && typeof after.at === 'string' && after.at >= spawnedAt))
  if (own) return { exit: result.code ?? EXIT.failed, record: after }
  if (result.code === EXIT.lockHeld) {
    write('refused: the job found another feed run holding the lock')
    return { exit: EXIT.lockHeld, record: null }
  }
  if (result.timedOut) {
    return {
      exit: EXIT.watchdog,
      record: fail('job', EXIT.watchdog, `the job passed ${Math.round(jobDeadlineMs / 1000)} s and its process group was killed`),
    }
  }
  const exit = result.code && result.code !== 0 ? result.code : EXIT.failed
  const said = reasonFrom(tail)
  const how = said ? `exited ${result.code ?? result.signal} — ${said}` : describe(result)
  return { exit, record: fail('job', exit, `the job ${how} without writing its record`) }
}

/** On SIGTERM/SIGINT: stop the job's group, and record the stop unless the job already did. */
function onSignal(signal, current) {
  void (async () => {
    await killAllGroups(5000)
    try {
      const paths = feedPaths()
      if (readStatus(paths.status)?.runId !== current.runId) {
        writeStatus(paths.status, {
          startedAt: current.startedAt,
          at: new Date().toISOString(),
          outcome: 'failed',
          stage: current.stage,
          exit: EXIT.signal,
          reason: `stopped by ${signal}`,
          runId: current.runId,
          recoveredCheckout: false,
        })
      }
    } finally {
      process.exit(EXIT.signal)
    }
  })()
}

async function main() {
  const current = { stage: 'start', runId: randomUUID(), startedAt: new Date().toISOString() }
  process.on('SIGTERM', () => onSignal('SIGTERM', current))
  process.on('SIGINT', () => onSignal('SIGINT', current))
  const { exit, record } = await runAgent({
    runId: current.runId,
    onStage: (stage) => {
      current.stage = stage
    },
  })
  // One line in launchd's own log too, where the silent failure used to be.
  if (record && exit !== EXIT.ok) {
    console.error(`feed-agent: ${record.outcome} in ${record.stage}: ${record.reason ?? `exit ${exit}`} (see ${feedPaths().log})`)
  }
  process.exit(exit)
}

if (isEntry(process.argv[1], import.meta.filename)) {
  main().catch((cause) => {
    console.error(`feed-agent: ${cause instanceof Error ? cause.stack : String(cause)}`)
    // Best effort: a crash here (an unwritable log folder, say) still counts.
    try {
      writeStatus(feedPaths().status, {
        startedAt: new Date().toISOString(),
        at: new Date().toISOString(),
        outcome: 'failed',
        stage: 'bootstrap',
        exit: EXIT.failed,
        reason: cleanLine(cause instanceof Error ? cause.message : String(cause)),
        recoveredCheckout: false,
      })
    } catch {
      // Nothing left to write to; launchd's log holds the line above.
    }
    process.exit(EXIT.failed)
  })
}
