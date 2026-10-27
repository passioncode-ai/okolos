/**
 * How to start a package-manager command (`pnpm`, `npx`) on this platform.
 *
 * On macOS and Linux `pnpm` and `npx` are executables, and they are spawned as
 * before: no shell. On Windows they are `pnpm.cmd` and `npx.cmd`, and since Node
 * 18.20.2 and 20.12.2 (CVE-2024-27980) a `.cmd` cannot be spawned without a shell:
 * the call fails with EINVAL, so `pnpm package` and the Firefox suite stopped before
 * their first step (B-163). There the command goes through `cmd.exe` (`shell: true`).
 *
 * A shell joins the arguments with spaces and reads its own metacharacters, so on
 * win32 an argument that a shell would reinterpret is refused rather than quoted:
 * every argument these tools pass is a fixed word, and one that is not is a change
 * that should have to say so.
 */

import { spawn, spawnSync } from 'node:child_process'
import path from 'node:path'

import { killPlan } from './feed/bounded.mjs'

/** Characters `cmd.exe` would read as something other than part of an argument. */
const CMD_SPECIAL = /[\s"&|<>^%!()]/

/**
 * @param {string} name   e.g. `pnpm`, `npx`
 * @param {readonly string[]} args
 * @param {string} [platform]
 * @returns {{ command: string, args: string[], shell: boolean }}
 */
export function binInvocation(name, args, platform = process.platform) {
  if (platform !== 'win32') return { command: name, args: [...args], shell: false }
  const unsafe = [name, ...args].filter((arg) => arg === '' || CMD_SPECIAL.test(arg))
  if (unsafe.length > 0) {
    throw new Error(`refusing to pass ${unsafe.map((a) => JSON.stringify(a)).join(', ')} through cmd.exe`)
  }
  return { command: name, args: [...args], shell: true }
}

/**
 * Where a POSIX `sh` can be, in the order to try. On macOS and Linux it is `sh`.
 * Windows has none of its own; Git for Windows ships one, on PATH inside Git Bash
 * and the hooks it runs but not in PowerShell or cmd, so it is also looked for
 * beside Git itself (`git --exec-path` is `<git>/mingw64/libexec/git-core`).
 *
 * @param {string} [platform]
 * @param {string} [gitExecPath] what `git --exec-path` printed
 * @returns {string[]}
 */
export function shCandidates(platform = process.platform, gitExecPath = '') {
  if (platform !== 'win32') return ['sh']
  const candidates = ['sh']
  if (gitExecPath !== '') {
    const git = path.win32.resolve(gitExecPath, '..', '..', '..')
    candidates.push(path.win32.join(git, 'usr', 'bin', 'sh.exe'), path.win32.join(git, 'bin', 'sh.exe'))
  }
  return candidates
}

/**
 * Ends `child` and everything it started.
 *
 * A command spawned through `binInvocation` on win32 is `cmd.exe`, and `child.kill()`
 * ends only that: geckodriver under npx, or the build under pnpm, kept running after
 * the tool that started them had gone. There the tree is ended with
 * `taskkill /PID <pid> /T /F`, the plan `tools/feed/bounded.mjs` already uses, run to
 * completion so the caller may exit right after. On macOS and Linux this is
 * `child.kill(signal)`, as it was.
 *
 * @param {{ pid?: number, kill: (signal?: NodeJS.Signals) => boolean }} child
 * @param {{ platform?: string, signal?: NodeJS.Signals,
 *   run?: (command: string, args: string[]) => unknown }} [options]
 */
export function endTree(child, { platform = process.platform, signal = 'SIGTERM', run = runTaskkill } = {}) {
  if (platform !== 'win32' || child.pid === undefined) {
    child.kill(signal)
    return
  }
  const plan = killPlan(child.pid, 'SIGKILL', platform)
  if (plan.kind === 'taskkill') run(plan.command, plan.args)
}

/** taskkill.exe, no shell (the pid is a number), bounded; "not found" is the outcome asked for. */
function runTaskkill(command, args) {
  spawnSync(command, args, { stdio: 'ignore', windowsHide: true, timeout: 30_000 })
}

/**
 * Runs `name args…` with the terminal's stdio, and resolves when it exits 0.
 *
 * What `execFileSync(…, { stdio: 'inherit', timeout })` did, with one difference that
 * matters only on win32: at the deadline the whole tree is ended (`endTree`), not just
 * `cmd.exe`. Rejects with the exit code, the signal, or the deadline in the message.
 *
 * @param {string} name
 * @param {readonly string[]} args
 * @param {{ cwd?: string, timeoutMs: number, platform?: string }} options
 * @returns {Promise<void>}
 */
export function runToCompletion(name, args, { cwd, timeoutMs, platform = process.platform }) {
  const invocation = binInvocation(name, args, platform)
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, { cwd, stdio: 'inherit', shell: invocation.shell })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      endTree(child, { platform })
    }, timeoutMs)
    child.on('error', (cause) => {
      clearTimeout(timer)
      reject(cause)
    })
    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      const line = `${name} ${args.join(' ')}`
      if (timedOut) reject(new Error(`${line} did not finish within ${timeoutMs} ms`))
      else if (code === 0) resolve()
      else reject(new Error(`${line} failed: ${code === null ? `signal ${String(signal)}` : `exit ${code}`}`))
    })
  })
}
