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
 * the job starts, because the job takes the same lock. One deadline covers the
 * whole run, repair included (RUN_DEADLINE_MS, 45 minutes from the start): a
 * repair still going at the deadline is stopped and recorded; the job gets what
 * is left, as its watchdog (at most its own thirty minutes, JOB_GRACE_MS before
 * the deadline) and as a backstop at the deadline itself. The job keeps its own
 * per-stage deadlines and the "skipped when the served feed is under 11 h old"
 * rule.
 */
import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'

import { killAllGroups, runBounded, withoutSecrets } from './bounded.mjs'
import { isMain } from './is-main.mjs'
import { acquireLock, LockHeldError } from './lock.mjs'
import { capFile, cleanLine, openLog } from './log.mjs'
import { feedPaths } from './paths.mjs'
import { offMainFacts, readStatus, stampRunId, writeStatus } from './status.mjs'

/** What the installer copies beside launchd: this file and every module it imports. */
export const BOOTSTRAP_FILES = ['bootstrap.mjs', 'bounded.mjs', 'is-main.mjs', 'lock.mjs', 'log.mjs', 'paths.mjs', 'status.mjs']

/**
 * Where each installed file comes from, relative to tools/. All from tools/feed,
 * except the main-module check: tools/is-main.mjs is the one implementation, and
 * tools/feed/is-main.mjs only re-exports it inside the repo.
 */
export const BOOTSTRAP_SOURCES = Object.fromEntries(
  BOOTSTRAP_FILES.map((file) => [file, file === 'is-main.mjs' ? 'is-main.mjs' : `feed/${file}`]),
)

/** The same codes as tools/feed-job.mjs (a test holds them equal), so a host reads one table. */
export const EXIT = { ok: 0, failed: 1, lockHeld: 75, watchdog: 124, signal: 143 }

/** Per child, as the job and the installer bound the same commands. */
export const RECOVERY_DEADLINES = { git: 90_000, worktree: 120_000, clone: 5 * 60_000, install: 10 * 60_000 }

/**
 * The whole run, checkout repair and job together. The repair's own per-step
 * deadlines add up to at most 21 minutes (the clone path: 90 s + 5 min + 90 s +
 * 10 min + 90 s, after a 90 s health check); in the ordinary run there is no
 * repair and the job keeps its full thirty-minute watchdog.
 */
export const RUN_DEADLINE_MS = 45 * 60_000

/** Room between the job's watchdog and the run's deadline, for the job to record its own failure. */
export const JOB_GRACE_MS = 2 * 60_000

/** The job's own watchdog (tools/feed-job.mjs WATCHDOG_MS; a test holds them equal). */
const JOB_WATCHDOG_MS = 30 * 60_000

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

function quietEnv(env) {
  return { ...withoutSecrets(env), GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o ConnectTimeout=15' }
}

function describe(result) {
  if (result.timedOut) return 'timed out; its process group was killed'
  if (result.error) return `could not start: ${result.error}`
  const said = cleanLine((result.stderr || result.stdout || '').trim().split('\n').at(-1) ?? '')
  return `exited ${result.code ?? result.signal}${said ? ` — ${said}` : ''}`
}

/**
 * The canonical spelling. On Windows `.native` expands 8.3 short names
 * (RUNNER~1), which git never prints; elsewhere the ordinary realpath, as node
 * itself resolves paths.
 */
const realpath = process.platform === 'win32' ? realpathSync.native : realpathSync

function real(file) {
  try {
    return realpath(file)
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
  // The launch line in the plist passes its own id, so it can tell whether this
  // run wrote a record (B-159, fix round 2).
  runId = env.OKOLOS_LAUNCH_ID || randomUUID(),
  runDeadlineMs = RUN_DEADLINE_MS,
  onStage = () => {},
  onRecovered = () => {},
  // The signal that is stopping this run, or null. A failure it causes (the job or
  // a repair step killed under it) is recorded as the stop it is.
  stopped = () => null,
  // The bootstrap's stderr is launchd's StandardErrorPath (feed.launchd.log).
  relay = (line) => process.stderr.write(`${line}\n`),
} = {}) {
  const iso = () => new Date(now()).toISOString()
  const startedAt = iso()
  const deadlineAt = now() + runDeadlineMs
  const checkout = paths.agentCheckout

  let write = log
  if (!write) {
    capFile(paths.launchdLog)
    const file = openLog(paths.log, { now })
    write = (line) => file.write(line)
  }

  let recovered = null
  /** Records the run's failure and returns `{ exit, record }`; a stop by signal wins over what it broke. */
  const fail = (stage, exit, reason) => {
    const signal = stopped()
    if (signal) {
      // The feed.log line for a stop is onSignal's, written once whoever records the stop.
      return { exit: EXIT.signal, record: writeStatus(paths.status, signalRecord({ stage, runId, startedAt, recovered }, signal, iso(), env)) }
    }
    write(`failed in ${stage}: ${reason}`)
    return {
      exit,
      record: writeStatus(paths.status, {
        startedAt,
        at: iso(),
        outcome: 'failed',
        stage,
        exit,
        reason,
        runId,
        recoveredCheckout: Boolean(recovered),
        ...(recovered ? { recovery: recovered } : {}),
        ...offMainFacts(env),
      }),
    }
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
    return fail('checkout', EXIT.failed, `could not take the run lock: ${cause.message}`)
  }

  // Past the deadline the repair starts no further child: its current one is killed.
  let aborted = false
  const guarded = (command, args, options) =>
    aborted
      ? Promise.resolve({ code: null, signal: null, stdout: '', stderr: '', timedOut: true })
      : tool(command, args, options)

  /** The repair; resolves `{ ok: true }` or `{ error }`, never rejects. */
  async function repair() {
    try {
      const health = await checkoutHealth({ checkout, tool: guarded, env })
      if (health.state === 'ok') return { ok: true }
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
        done = await recoverCheckout({ checkout, sourceRepo: env.OKOLOS_SOURCE_REPO, origin: env.OKOLOS_ORIGIN_URL, tool: guarded, env })
      } catch (cause) {
        return { error: `the checkout ${what} and could not be recreated: ${cause.message}` }
      }
      if (aborted) return { error: 'the run deadline passed' }
      recovered = health.state === 'missing' ? 'missing' : `broken: ${health.reason}`
      onRecovered(recovered)
      write(`checkout: recreated ${checkout} as ${done.how} at ${done.commit.slice(0, 7)} (recoveredCheckout: true)`)
      return { ok: true }
    } catch (cause) {
      return { error: cause instanceof Error ? cause.message : String(cause) }
    }
  }

  let timer
  try {
    const outcome = await Promise.race([
      repair(),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ deadline: true }), Math.max(0, deadlineAt - now()))
      }),
    ])
    if (outcome.deadline) {
      aborted = true
      await killAllGroups(5000)
      recovered = null
      const seconds = Math.round(runDeadlineMs / 1000)
      return fail('checkout', EXIT.watchdog, `the run's deadline (${seconds} s) passed while repairing the checkout; its children were killed`)
    }
    if (outcome.error) {
      recovered = null
      return fail('checkout', EXIT.failed, outcome.error)
    }
  } finally {
    clearTimeout(timer)
    lock.release()
  }

  write('── job')
  onStage('job')
  const spawnedAt = iso()
  // What is left of the run: the job's watchdog fires JOB_GRACE_MS before the
  // deadline, so the job records its own failure; the backstop is the deadline.
  const left = Math.max(1, deadlineAt - now())
  const watchdog = Math.max(1, Math.min(JOB_WATCHDOG_MS, left - JOB_GRACE_MS))
  const jobEnv = { ...env, OKOLOS_RUN_ID: runId, OKOLOS_WATCHDOG_MS: String(watchdog) }
  if (recovered) jobEnv.OKOLOS_RECOVERED_CHECKOUT = recovered
  else delete jobEnv.OKOLOS_RECOVERED_CHECKOUT
  // What the job prints (a crash's error and stack, mostly: its own lines go to
  // feed.log directly) is passed on to launchd's log and feed.log as it arrives,
  // and the last JOB_TAIL_LINES are kept to name the failure.
  const tail = []
  const result = await run(node, [path.join(checkout, 'tools', 'feed-job.mjs'), '--agent'], {
    cwd: checkout,
    env: jobEnv,
    timeoutMs: left,
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
  // One rule for "this run wrote a record": it carries this run's id. A record
  // adopted from such a job is stamped with it, or the launch line would find no
  // record of its id, write its own and count the one failure twice. Such a job
  // does not know an install off origin/main either, so the mark goes in too.
  if (own) return { exit: result.code ?? EXIT.failed, record: after.runId === runId ? after : stampRunId(paths.status, runId, offMainFacts(env)) }
  if (result.code === EXIT.lockHeld) {
    write('refused: the job found another feed run holding the lock')
    return { exit: EXIT.lockHeld, record: null }
  }
  if (result.timedOut) {
    return fail('job', EXIT.watchdog, `the run's deadline (${Math.round(runDeadlineMs / 1000)} s) passed during the job; its process group was killed`)
  }
  const exit = result.code && result.code !== 0 ? result.code : EXIT.failed
  const said = reasonFrom(tail)
  const how = said ? `exited ${result.code ?? result.signal} — ${said}` : describe(result)
  return fail('job', exit, `the job ${how} without writing its record`)
}

/**
 * The record of a run stopped by `signal`; a checkout recovered before the stop,
 * and an install made off origin/main, stay recorded.
 */
export function signalRecord(current, signal, at, env = process.env) {
  return {
    startedAt: current.startedAt,
    at,
    outcome: 'failed',
    stage: current.stage,
    exit: EXIT.signal,
    reason: `stopped by ${signal}`,
    runId: current.runId,
    recoveredCheckout: Boolean(current.recovered),
    ...(current.recovered ? { recovery: current.recovered } : {}),
    ...offMainFacts(env),
  }
}

/**
 * The record of the bootstrap's own crash (stage bootstrap): best effort, from
 * what the environment still says.
 */
export function crashRecord(cause, at = new Date().toISOString(), env = process.env) {
  return {
    startedAt: at,
    at,
    outcome: 'failed',
    stage: 'bootstrap',
    exit: EXIT.failed,
    reason: cleanLine(cause instanceof Error ? cause.message : String(cause)),
    ...(env.OKOLOS_LAUNCH_ID ? { runId: env.OKOLOS_LAUNCH_ID } : {}),
    recoveredCheckout: false,
    ...offMainFacts(env),
  }
}

/**
 * Whether feed.log already has `text` on a line stamped at or after `since` (this run's start).
 * Reads only the last 64 KB: a run writes a few dozen lines.
 */
function loggedSince(file, since, text) {
  let tail
  try {
    const size = statSync(file).size
    const fd = openSync(file, 'r')
    try {
      const length = Math.min(size, 64 * 1024)
      const buffer = Buffer.alloc(length)
      readSync(fd, buffer, 0, length, size - length)
      tail = buffer.toString('utf8')
    } finally {
      closeSync(fd)
    }
  } catch {
    return false
  }
  return tail.split(/\r?\n/).some((line) => line.slice(0, 24) >= since && line.includes(text))
}

/**
 * On SIGTERM/SIGINT: mark the run as stopping (runAgent then records what the stop
 * broke as the stop), stop the job's group, record the stop unless this run's
 * record is already written, and exit 143. Returns the promise main waits on, so
 * main never exits with its own code under it.
 */
function onSignal(signal, current) {
  if (current.stopping) return current.stopping
  current.signal = signal
  current.stopping = (async () => {
    await killAllGroups(5000)
    try {
      const paths = feedPaths()
      const own = readStatus(paths.status)
      const record = own?.runId === current.runId ? own : signalRecord(current, signal, new Date().toISOString())
      if (record !== own) writeStatus(paths.status, record)
      // One line in feed.log and the same one line in launchd's own log as any failed run,
      // whichever of the job or the bootstrap recorded the stop (AGENTS.md, the failure table).
      try {
        // The job names its own stops in feed.log when a stage it was running answers the
        // signal; the bootstrap adds the line only when this run's tail does not have it.
        if (!loggedSince(paths.log, current.startedAt, `stopped by ${signal}`)) {
          openLog(paths.log).write(`stopped by ${signal} in ${record.stage}`)
        }
      } catch {
        // feed.log unwritable: the record and launchd's line below still say it.
      }
      console.error(`feed-agent: ${record.outcome} in ${record.stage}: ${record.reason ?? `stopped by ${signal}`} (see ${paths.log})`)
    } finally {
      process.exit(EXIT.signal)
    }
  })()
  return current.stopping
}

async function main() {
  const current = {
    stage: 'start',
    runId: process.env.OKOLOS_LAUNCH_ID || randomUUID(),
    startedAt: new Date().toISOString(),
    recovered: null,
    signal: null,
    stopping: null,
  }
  process.on('SIGTERM', () => onSignal('SIGTERM', current))
  process.on('SIGINT', () => onSignal('SIGINT', current))
  const { exit, record } = await runAgent({
    runId: current.runId,
    onStage: (stage) => {
      current.stage = stage
    },
    onRecovered: (what) => {
      current.recovered = what
    },
    stopped: () => current.signal,
  })
  // A stop ends the process from onSignal, after the job's group is gone.
  if (current.stopping) await current.stopping
  // One line in launchd's own log too, where the silent failure used to be.
  if (record && exit !== EXIT.ok) {
    console.error(`feed-agent: ${record.outcome} in ${record.stage}: ${record.reason ?? `exit ${exit}`} (see ${feedPaths().log})`)
  }
  process.exit(exit)
}

if (isMain(import.meta.filename)) {
  main().catch((cause) => {
    console.error(`feed-agent: ${cause instanceof Error ? cause.stack : String(cause)}`)
    // Best effort: a crash here (an unwritable log folder, say) still counts.
    try {
      writeStatus(feedPaths().status, crashRecord(cause))
    } catch {
      // Nothing left to write to; launchd's log holds the line above.
    }
    process.exit(EXIT.failed)
  })
}
