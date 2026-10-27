import { spawn } from 'node:child_process'

/**
 * A child process with an owner, a deadline and a process group (LC-02).
 *
 * Every child is started in a group of its own (`detached: true`), so the group id
 * is the child's pid and one signal reaches everything it started — wrangler under
 * pnpm under node included. At the deadline the group gets SIGTERM, then SIGKILL
 * after a grace; when the child exits on its own the group is still signalled, so a
 * grandchild that outlived its parent does not survive as an orphan (ppid 1).
 *
 * The result is returned, never thrown: the caller decides what a failure means,
 * and a stage that needs its exit code should not have to parse an exception.
 *
 * Windows has no process groups to signal: `process.kill(-pid)` throws there, and
 * `detached` opens a console of its own instead. So on win32 the child is not
 * detached, and the tree under it is ended with `taskkill /PID <pid> /T` (SIGTERM)
 * then `/T /F` (SIGKILL), spawned without a shell (B-162). What Windows cannot do is
 * find the children of a parent that has already exited, so the sweep after a
 * normal exit is POSIX-only; a PID is reused there quickly, and `taskkill` on a
 * reused one would end an unrelated process.
 */

/**
 * Variables that carry the Cloudflare credential. Only the publish step, behind
 * the secret runner, may see one; every other child (git, pnpm install, the
 * ingest) gets `withoutSecrets(env)`. One list for the job, the bootstrap and the
 * installer (every installer child goes through its `installerEnv`). The bootstrap
 * hands the job itself the whole environment: publish inherits it through the job.
 */
export const SECRET_VARIABLES = ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_API_KEY']

/** A copy of `env` without SECRET_VARIABLES. */
export function withoutSecrets(env) {
  const copy = { ...env }
  for (const name of SECRET_VARIABLES) delete copy[name]
  return copy
}

/** Groups started here and not yet ended — what a shutdown must kill. */
const live = new Set()

/** How many groups are still running. A test reads it; a shutdown empties it. */
export function liveGroups() {
  return live.size
}

/**
 * How `signal` reaches the tree under `pid` on `platform`: a signal to the process
 * group, or the `taskkill` command line that stands in for one on win32.
 *
 * @param {number} pid
 * @param {'SIGTERM' | 'SIGKILL'} signal
 * @param {string} [platform]
 * @returns {{ kind: 'group', pid: number, signal: string } | { kind: 'taskkill', command: string, args: string[] }}
 */
export function killPlan(pid, signal, platform = process.platform) {
  if (platform === 'win32') {
    const args = ['/PID', String(pid), '/T']
    if (signal === 'SIGKILL') args.push('/F')
    return { kind: 'taskkill', command: 'taskkill', args }
  }
  return { kind: 'group', pid: -pid, signal }
}

/**
 * The spawn options that give a child its own group where groups exist.
 *
 * @param {string} [platform]
 */
export function groupSpawnOptions(platform = process.platform) {
  return { detached: platform !== 'win32', windowsHide: true }
}

/** Whether a child that exited on its own still has its group swept (POSIX only). */
export function sweepsAfterExit(platform = process.platform) {
  return platform !== 'win32'
}

function signalGroup(pid, signal) {
  const plan = killPlan(pid, signal)
  if (plan.kind === 'taskkill') {
    // No shell: taskkill.exe is an executable and the pid is a number.
    const killer = spawn(plan.command, plan.args, { stdio: 'ignore', windowsHide: true })
    // "not found": the tree has already ended, which is the outcome asked for.
    killer.on('error', () => {})
    return
  }
  try {
    process.kill(plan.pid, signal)
  } catch {
    // ESRCH: the group is already empty, which is the outcome asked for.
  }
}

/**
 * Ends every group still running: SIGTERM now, SIGKILL after `graceMs`.
 * Resolves once the grace has passed, so a caller about to exit can await it.
 */
export async function killAllGroups(graceMs = 5000) {
  const pids = [...live].map((entry) => entry.pid)
  for (const pid of pids) signalGroup(pid, 'SIGTERM')
  if (pids.length === 0) return
  await new Promise((resolve) => setTimeout(resolve, graceMs))
  for (const pid of pids) signalGroup(pid, 'SIGKILL')
}

/**
 * Runs `command` with `args`, bounded by `timeoutMs`.
 *
 * @returns {Promise<{ code: number | null, signal: string | null, stdout: string,
 *   stderr: string, timedOut: boolean, error?: string }>}
 */
export function runBounded(
  command,
  args,
  { cwd, env, timeoutMs, graceMs = 5000, input, onLine } = {},
) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    // A child without a deadline is the defect this module exists to remove.
    throw new Error(`runBounded: ${command} needs a positive timeoutMs`)
  }
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(command, args, {
        cwd,
        env,
        ...groupSpawnOptions(),
        stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      })
    } catch (cause) {
      resolve({ code: null, signal: null, stdout: '', stderr: '', timedOut: false, error: String(cause) })
      return
    }

    const entry = { pid: child.pid }
    if (child.pid !== undefined) live.add(entry)

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let killTimer
    const pending = { stdout: '', stderr: '' }

    const collect = (stream) => (chunk) => {
      const text = chunk.toString('utf8')
      if (stream === 'stdout') stdout += text
      else stderr += text
      if (!onLine) return
      pending[stream] += text
      const lines = pending[stream].split(/\r?\n/)
      pending[stream] = lines.pop() ?? ''
      for (const line of lines) onLine(stream, line)
    }
    child.stdout?.on('data', collect('stdout'))
    child.stderr?.on('data', collect('stderr'))
    if (input !== undefined) child.stdin?.end(input)

    const timer = setTimeout(() => {
      timedOut = true
      if (child.pid === undefined) return
      signalGroup(child.pid, 'SIGTERM')
      killTimer = setTimeout(() => signalGroup(child.pid, 'SIGKILL'), graceMs)
    }, timeoutMs)

    // The direct child is done; whatever it left in its group is not ours to keep.
    child.on('exit', () => {
      if (child.pid !== undefined && sweepsAfterExit()) signalGroup(child.pid, 'SIGKILL')
    })

    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(killTimer)
      live.delete(entry)
      if (onLine) {
        for (const stream of ['stdout', 'stderr']) {
          if (pending[stream] !== '') onLine(stream, pending[stream])
        }
      }
      resolve(result)
    }
    child.on('error', (cause) => {
      finish({ code: null, signal: null, stdout, stderr, timedOut, error: String(cause) })
    })
    child.on('close', (code, signal) => {
      finish({ code, signal, stdout, stderr, timedOut })
    })
  })
}
