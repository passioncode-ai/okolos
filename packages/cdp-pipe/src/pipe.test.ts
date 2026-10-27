import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

import { CdpPipe } from './pipe.js'

/**
 * Every test here drives a real process: a node script that speaks CDP over
 * fd 3 and fd 4 the way Chrome does under --remote-debugging-pipe. No Chrome,
 * no network.
 */
const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-browser.mjs')
const PROFILE = path.join(tmpdir(), 'okolos-cdp-pipe-test-profile')

const launched: number[] = []

async function fake(flags: string[] = [], requestTimeoutMs?: number): Promise<CdpPipe> {
  const pipe = await CdpPipe.launch({
    binary: process.execPath,
    args: [FAKE, ...flags],
    userDataDir: PROFILE,
    ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
  })
  launched.push(pipe.pid)
  return pipe
}

/** Whether a process (pid > 0) or a process group (pid < 0) still exists. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/** Waits until the predicate holds or the deadline passes; returns the last answer. */
async function eventually(predicate: () => boolean, ms = 3000): Promise<boolean> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return predicate()
}

// Whatever a test did, no fake browser outlives it: the group is killed here
// directly, not through the close() under test.
afterEach(async () => {
  for (const pid of launched.splice(0)) {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      // the group is already gone
    }
    await eventually(() => !alive(-pid))
  }
})

describe('launching a browser on a pipe', () => {
  it('adds the pipe and the profile to the arguments it was given', async () => {
    const pipe = await fake(['--flag-of-the-caller'])
    const { argv } = await pipe.send<{ argv: string[] }>('Fake.argv')
    expect(argv).toEqual(['--flag-of-the-caller', '--remote-debugging-pipe', `--user-data-dir=${PROFILE}`])
  })

  it('answers each request with its own result', async () => {
    const pipe = await fake()
    const [a, b] = await Promise.all([pipe.send('Fake.echo', { n: 1 }), pipe.send('Fake.echo', { n: 2 })])
    expect(a).toEqual({ n: 1 })
    expect(b).toEqual({ n: 2 })
  })

  it('leads its own process group', async () => {
    const pipe = await fake()
    expect(alive(-pipe.pid)).toBe(true)
  })

  it('rejects a request with no answer within requestTimeoutMs, naming the method', async () => {
    const pipe = await fake([], 300)
    const started = Date.now()
    await expect(pipe.send('Fake.silence')).rejects.toThrow(/Fake\.silence/)
    expect(Date.now() - started).toBeGreaterThanOrEqual(250)
    // The pipe is still usable after a request timed out.
    expect(await pipe.send('Fake.echo', { after: 'timeout' })).toEqual({ after: 'timeout' })
  })

  it('refuses a binary that does not exist', async () => {
    await expect(
      CdpPipe.launch({ binary: path.join(tmpdir(), 'okolos-no-such-browser'), args: [], userDataDir: PROFILE }),
    ).rejects.toThrow(/okolos-no-such-browser/)
  })
})
