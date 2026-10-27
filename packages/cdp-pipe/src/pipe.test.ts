import type { ChildProcess } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

import { CdpError } from './errors.js'
import { CdpPipe, type LaunchOptions } from './pipe.js'

/**
 * Every test here drives a real process: a node script that speaks CDP over
 * fd 3 and fd 4 the way Chrome does under --remote-debugging-pipe. No Chrome,
 * no network.
 */
const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-browser.mjs')
const PROFILE = path.join(tmpdir(), 'okolos-cdp-pipe-test-profile')

const launched: number[] = []

type Extra = Omit<LaunchOptions, 'binary' | 'args' | 'userDataDir'>

async function fake(flags: string[] = [], extra: Extra = {}): Promise<CdpPipe> {
  const pipe = await CdpPipe.launch({ binary: process.execPath, args: [FAKE, ...flags], userDataDir: PROFILE, ...extra })
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

/**
 * One of the browser's streams as the pipe holds it. The stream is private; a
 * test reaches it only to inject the fault an OS read or write error raises
 * (Node destroys the stream with the error), which no fake browser can cause on
 * demand.
 */
function streamOf(pipe: CdpPipe, fd: 2 | 3 | 4): Readable | Writable {
  return (pipe as unknown as { child: ChildProcess }).child.stdio[fd] as Readable | Writable
}

/** The settled rejection of a promise, for assertions on its fields. */
async function rejectionOf(promise: Promise<unknown>): Promise<CdpError> {
  try {
    await promise
  } catch (error) {
    return error as CdpError
  }
  throw new Error('expected the promise to reject, and it resolved')
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
    const pipe = await fake([], { requestTimeoutMs: 300 })
    const started = Date.now()
    await expect(pipe.send('Fake.silence')).rejects.toThrow(/Fake\.silence/)
    expect(Date.now() - started).toBeGreaterThanOrEqual(250)
    // The pipe is still usable after a request timed out.
    expect(await pipe.send('Fake.echo', { after: 'timeout' })).toEqual({ after: 'timeout' })
  })

  it('turns an answer carrying an error into a rejection with the CDP text and the method', async () => {
    const pipe = await fake()
    const failed = pipe.send('Fake.fail', { message: 'No target with given id found' })
    await expect(failed).rejects.toThrow(/Fake\.fail/)
    await expect(failed).rejects.toThrow(/No target with given id found/)
    await expect(pipe.send('Page.noSuchThing')).rejects.toThrow(/'Page\.noSuchThing' wasn't found/)
  })

  it('delivers an event with its sessionId to the subscriber, and stops after unsubscribe', async () => {
    const pipe = await fake()
    const seen: Array<{ params: unknown; sessionId: string | undefined }> = []
    const off = pipe.on('Page.loadEventFired', (params, sessionId) => seen.push({ params, sessionId }))
    const other: unknown[] = []
    pipe.on('Target.targetCreated', (params) => other.push(params))

    await pipe.send('Fake.emit', { event: 'Page.loadEventFired', params: { timestamp: 1 }, sessionId: 'S-1' })
    await pipe.send('Fake.emit', { event: 'Page.loadEventFired', params: { timestamp: 2 } })
    expect(seen).toEqual([
      { params: { timestamp: 1 }, sessionId: 'S-1' },
      { params: { timestamp: 2 }, sessionId: undefined },
    ])
    expect(other).toEqual([])

    off()
    await pipe.send('Fake.emit', { event: 'Page.loadEventFired', params: { timestamp: 3 }, sessionId: 'S-1' })
    expect(seen).toHaveLength(2)
  })

  it('sends a request to a session when given its sessionId', async () => {
    const pipe = await fake()
    expect(await pipe.send('Fake.echo', { n: 1 }, 'S-2')).toEqual({ n: 1, sessionId: 'S-2' })
  })

  it('skips a frame that is not JSON and keeps reading', async () => {
    const pipe = await fake()
    expect(await pipe.send('Fake.garbage')).toEqual({ after: 'garbage' })
    expect(await pipe.send('Fake.echo', { still: 'reading' })).toEqual({ still: 'reading' })
  })

  it('refuses a binary that does not exist', async () => {
    await expect(
      CdpPipe.launch({ binary: path.join(tmpdir(), 'okolos-no-such-browser'), args: [], userDataDir: PROFILE }),
    ).rejects.toThrow(/okolos-no-such-browser/)
  })
})

describe('a listener that throws', () => {
  it('does not stop delivery to the other listeners, nor the pipe, and is reported once', async () => {
    const reported: Array<{ error: unknown; event: string }> = []
    const pipe = await fake([], { onListenerError: (error, event) => reported.push({ error, event }) })
    const boom = new Error('listener bug')
    pipe.on('Page.loadEventFired', () => {
      throw boom
    })
    const seen: unknown[] = []
    pipe.on('Page.loadEventFired', (params) => seen.push(params))

    await pipe.send('Fake.emit', { event: 'Page.loadEventFired', params: { timestamp: 7 } })

    expect(seen).toEqual([{ timestamp: 7 }])
    expect(await pipe.send('Fake.echo', { still: 'answering' })).toEqual({ still: 'answering' })
    expect(reported).toEqual([{ error: boom, event: 'Page.loadEventFired' }])
  })

  it('is reported by default as one stderr line naming the event and never the params', async () => {
    const lines: string[] = []
    const write = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: string | Uint8Array) => {
      lines.push(String(chunk))
      return true
    }) as typeof process.stderr.write
    try {
      const pipe = await fake()
      pipe.on('Network.requestWillBeSent', () => {
        throw new Error('listener bug')
      })
      await pipe.send('Fake.emit', { event: 'Network.requestWillBeSent', params: { secret: 'p4ssw0rd-in-params' } })
    } finally {
      process.stderr.write = write
    }
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('Network.requestWillBeSent')
    expect(lines[0]).not.toContain('p4ssw0rd-in-params')
  })
})

describe('a stream of the browser that breaks', () => {
  it('a read error on fd 4 does not end the owner: requests waiting are rejected as closed', async () => {
    const pipe = await fake([], { requestTimeoutMs: 60_000 })
    const waiting = rejectionOf(pipe.send('Fake.silence'))

    streamOf(pipe, 4).destroy(Object.assign(new Error('read EIO'), { code: 'EIO' }))

    const error = await waiting
    expect(error).toBeInstanceOf(CdpError)
    expect(error.kind).toBe('closed')
    expect(error.method).toBe('Fake.silence')
    expect(error.message).toContain('EIO')
    // Nothing can answer any more, so a new request is refused at once, not timed out.
    expect((await rejectionOf(pipe.send('Fake.echo'))).kind).toBe('closed')
  })

  it('a read error on stderr does not end the owner: requests waiting are rejected as closed', async () => {
    const pipe = await fake([], { requestTimeoutMs: 60_000 })
    const waiting = rejectionOf(pipe.send('Fake.silence'))

    streamOf(pipe, 2).destroy(Object.assign(new Error('read EIO'), { code: 'EIO' }))

    const error = await waiting
    expect(error).toBeInstanceOf(CdpError)
    expect(error.kind).toBe('closed')
    expect(error.method).toBe('Fake.silence')
  })

  it('a write that fails with EPIPE does not end the owner: requests waiting are rejected as closed', async () => {
    const pipe = await fake([], { requestTimeoutMs: 60_000 })
    const waiting = rejectionOf(pipe.send('Fake.silence'))

    streamOf(pipe, 3).destroy(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))

    const error = await waiting
    expect(error).toBeInstanceOf(CdpError)
    expect(error.kind).toBe('closed')
    expect(error.method).toBe('Fake.silence')
    expect(error.message).toContain('the pipe to the browser broke')
    expect(error.message).toContain('EPIPE')
  })

  it('a browser that stops reading its fd 3 is noticed: the next request is refused as closed, not timed out', async () => {
    const pipe = await fake([], { requestTimeoutMs: 60_000 })
    // Its own answer may come before or after the pipe notices fd 3 closed;
    // either is right, so only the request after it is asserted.
    await pipe.send('Fake.closeInput').catch(() => undefined)

    const error = await rejectionOf(pipe.send('Fake.echo', { n: 1 }))

    expect(error).toBeInstanceOf(CdpError)
    expect(error.kind).toBe('closed')
    expect(error.method).toBe('Fake.echo')
  })
})

describe('closing ends the whole process group', () => {
  it('asks first: a browser that leaves on Browser.close is not waited out to the grace', async () => {
    const pipe = await fake()
    const started = Date.now()
    await pipe.close(5000)
    expect(Date.now() - started).toBeLessThan(2500)
    expect(alive(pipe.pid)).toBe(false)
  })

  it('leaves no process of the group when the browser exits on Browser.close but its child lingers', async () => {
    const pipe = await fake()
    const { pid: grandchild } = await pipe.send<{ pid: number }>('Fake.spawnGrandchild')
    expect(alive(grandchild)).toBe(true)

    await pipe.close(300)

    expect(alive(pipe.pid)).toBe(false)
    expect(alive(grandchild)).toBe(false)
    expect(alive(-pipe.pid)).toBe(false)
  })

  it('escalates to SIGTERM and then SIGKILL when the browser ignores Browser.close and SIGTERM', async () => {
    const pipe = await fake(['--ignore-close', '--ignore-term'])
    const { pid: grandchild } = await pipe.send<{ pid: number }>('Fake.spawnGrandchild')
    const started = Date.now()

    await pipe.close(200)

    // One grace for Browser.close, one for SIGTERM, then SIGKILL.
    expect(Date.now() - started).toBeGreaterThanOrEqual(350)
    expect(alive(pipe.pid)).toBe(false)
    expect(alive(grandchild)).toBe(false)
    expect(alive(-pipe.pid)).toBe(false)
  })

  it('rejects requests still waiting when the pipe closes, naming the method', async () => {
    const pipe = await fake()
    const waiting = expect(pipe.send('Fake.silence')).rejects.toThrow(/Fake\.silence/)
    await pipe.close(300)
    await waiting
    await expect(pipe.send('Fake.echo')).rejects.toThrow(/Fake\.echo/)
  })

  it('never hangs: when the group cannot be signalled it resolves within 3 x graceMs and reports the pid', async () => {
    const refused: unknown[] = []
    const incomplete: number[] = []
    const pipe = await fake(['--ignore-close'], {
      kill: ((pid: number, signal?: string | number) => {
        refused.push([pid, signal])
        throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' })
      }) as typeof process.kill,
      onCloseIncomplete: (pid) => incomplete.push(pid),
    })
    const grace = 200
    const started = Date.now()

    await pipe.close(grace)

    // Three graces (ask, SIGTERM, SIGKILL) and timer jitter, nothing more.
    expect(Date.now() - started).toBeLessThan(3 * grace + 50)
    expect(incomplete).toEqual([pipe.pid])
    expect(refused).toContainEqual([-pipe.pid, 'SIGKILL'])
    // The browser really is still there: close said so rather than pretending.
    expect(alive(pipe.pid)).toBe(true)
  })

  it('reports a group it could not end, by default, as one stderr line naming the pid', async () => {
    const pipe = await fake(['--ignore-close'], {
      kill: (() => {
        throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' })
      }) as typeof process.kill,
    })
    const lines: string[] = []
    const write = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: string | Uint8Array) => {
      lines.push(String(chunk))
      return true
    }) as typeof process.stderr.write
    try {
      await pipe.close(100)
    } finally {
      process.stderr.write = write
    }
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain(`browser ${pipe.pid} `)
    expect(lines[0]).toContain('close() gave up')
  })

  it('is idempotent', async () => {
    const pipe = await fake()
    await Promise.all([pipe.close(300), pipe.close(300)])
    await pipe.close(300)
    expect(alive(-pipe.pid)).toBe(false)
  })
})
