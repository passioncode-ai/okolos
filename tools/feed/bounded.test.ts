import { describe, expect, it } from 'vitest'

import { groupSpawnOptions, killPlan, liveGroups, runBounded, sweepsAfterExit } from './bounded.mjs'

/**
 * Every child has an owner, a deadline and a process group (LC-02).
 *
 * The feed publish shelled out with `execFileSync` and no timeout: `npx wrangler …`
 * and two smoke fetches could hang after a wake, the launchd job stayed "running",
 * and launchd skips every later interval while a job runs — protection updates
 * stopped in silence. A timeout on the direct child is not enough either: wrangler
 * runs under pnpm under node, and killing only the top leaves the rest as orphans.
 */

const node = process.execPath

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function gone(pid: number, withinMs = 3000): Promise<boolean> {
  const until = Date.now() + withinMs
  while (Date.now() < until) {
    if (!alive(pid)) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return !alive(pid)
}

/** A child that ignores SIGTERM and starts a grandchild that ignores it too. */
const STUBBORN = `
  const { spawn } = require('node:child_process')
  process.on('SIGTERM', () => {})
  const grandchild = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore' })
  console.log('grandchild ' + grandchild.pid)
  setInterval(() => {}, 1000)
`

describe('a bounded child', () => {
  it('returns what the child printed and its exit code', async () => {
    const result = await runBounded(node, ['-e', 'console.log("hello"); process.exit(3)'], {
      timeoutMs: 10_000,
    })
    expect(result.code).toBe(3)
    expect(result.timedOut).toBe(false)
    expect(result.stdout.trim()).toBe('hello')
  })

  it('kills the whole group at the deadline, a SIGTERM-ignoring grandchild included', async () => {
    const started = Date.now()
    // 3 s, not 800 ms: the deadline has to fall *after* the child has started and
    // printed its grandchild's pid, and at a load average of 480 (measured
    // 2026-10-06) starting node took longer than 800 ms — the run then failed on an
    // empty stdout, a fact about the machine and not about the kill.
    const result = await runBounded(node, ['-e', STUBBORN], { timeoutMs: 3000, graceMs: 300 })
    const pid = Number(/grandchild (\d+)/.exec(result.stdout)?.[1])

    expect(result.timedOut).toBe(true)
    expect(Number.isInteger(pid) && pid > 0, `printed: ${result.stdout}`).toBe(true)
    expect(await gone(pid), `grandchild ${pid} survived as an orphan`).toBe(true)
    expect(Date.now() - started, 'the deadline is a deadline').toBeLessThan(10000)
  })

  // Windows cannot find the children of a parent that has already exited, and
  // bounded.mjs does not sweep there by design (a reused PID would be killed), so
  // this is a POSIX promise and is skipped on win32 (B-162).
  it.skipIf(!sweepsAfterExit())('leaves no grandchild behind when the child exits on its own', async () => {
    const LEAVES = `
      const { spawn } = require('node:child_process')
      const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
      console.log('grandchild ' + grandchild.pid)
      setTimeout(() => process.exit(0), 100)
    `
    const result = await runBounded(node, ['-e', LEAVES], { timeoutMs: 10_000, graceMs: 200 })
    const pid = Number(/grandchild (\d+)/.exec(result.stdout)?.[1])
    expect(result.code).toBe(0)
    expect(await gone(pid), `grandchild ${pid} outlived its parent`).toBe(true)
  })

  it('reports a command that cannot start instead of throwing', async () => {
    const result = await runBounded('/nonexistent/okolos-binary', [], { timeoutMs: 1000 })
    expect(result.code).toBeNull()
    expect(result.error).toMatch(/ENOENT/)
  })

  it('forgets every group once it has ended, so a shutdown has nothing stale to kill', async () => {
    await runBounded(node, ['-e', ''], { timeoutMs: 5000 })
    expect(liveGroups()).toBe(0)
  })

  it('hands each line to the caller as it arrives, for the log', async () => {
    const lines: string[] = []
    await runBounded(node, ['-e', 'console.log("a"); console.error("b")'], {
      timeoutMs: 5000,
      onLine: (stream, line) => lines.push(`${stream}:${line}`),
    })
    expect(lines.sort()).toEqual(['stderr:b', 'stdout:a'])
  })
})

describe('the kill, per platform', () => {
  /**
   * Windows has no process groups: `process.kill(-pid)` throws there, and
   * `detached: true` opens a console instead of a group (B-162). The platform is a
   * parameter so the Windows branch is checked on every machine, not only on one.
   */
  it('signals the group on macOS and Linux, as before', () => {
    expect(killPlan(4242, 'SIGTERM', 'darwin')).toEqual({ kind: 'group', pid: -4242, signal: 'SIGTERM' })
    expect(killPlan(4242, 'SIGKILL', 'linux')).toEqual({ kind: 'group', pid: -4242, signal: 'SIGKILL' })
  })

  it('ends the tree with taskkill on Windows, forced only at SIGKILL', () => {
    expect(killPlan(4242, 'SIGTERM', 'win32')).toEqual({
      kind: 'taskkill',
      command: 'taskkill',
      args: ['/PID', '4242', '/T'],
    })
    expect(killPlan(4242, 'SIGKILL', 'win32')).toEqual({
      kind: 'taskkill',
      command: 'taskkill',
      args: ['/PID', '4242', '/T', '/F'],
    })
  })

  it('detaches into a group of its own only where groups exist', () => {
    expect(groupSpawnOptions('darwin').detached).toBe(true)
    expect(groupSpawnOptions('linux').detached).toBe(true)
    expect(groupSpawnOptions('win32').detached).toBe(false)
  })

  it('sweeps the group after a normal exit on POSIX only, where a group outlives its leader', () => {
    expect(sweepsAfterExit('darwin')).toBe(true)
    expect(sweepsAfterExit('win32')).toBe(false)
  })
})
