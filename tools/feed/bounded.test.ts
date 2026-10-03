import { describe, expect, it } from 'vitest'

import { liveGroups, runBounded } from './bounded.mjs'

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
    const result = await runBounded(node, ['-e', STUBBORN], { timeoutMs: 800, graceMs: 300 })
    const pid = Number(/grandchild (\d+)/.exec(result.stdout)?.[1])

    expect(result.timedOut).toBe(true)
    expect(Number.isInteger(pid) && pid > 0, `printed: ${result.stdout}`).toBe(true)
    expect(await gone(pid), `grandchild ${pid} survived as an orphan`).toBe(true)
    expect(Date.now() - started, 'the deadline is a deadline').toBeLessThan(5000)
  })

  it('leaves no grandchild behind when the child exits on its own', async () => {
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
