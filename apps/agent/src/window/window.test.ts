import { CdpError } from '@okolos/cdp-pipe'
import type { CdpTransport, ExitInfo, LaunchOptions } from '@okolos/cdp-pipe'
import { describe, expect, it } from 'vitest'

import type { OrphanProbe } from './chrome.js'
import { AGENT_BROWSER_ARGS, AgentWindows, CLOSE_GRACE_MS } from './window.js'

interface Fake {
  readonly launches: LaunchOptions[]
  readonly sent: { method: string; params: unknown }[]
  readonly closes: (number | undefined)[]
  exit(info: Partial<ExitInfo>): void
  refuse(kind: 'closed' | 'exited' | undefined): void
  incompleteOnClose(pid: number | undefined): void
  launch(options: LaunchOptions): Promise<CdpTransport>
}

/** A browser that answers the window commands; nothing is started. */
function fakeBrowser(): Fake {
  const launches: LaunchOptions[] = []
  const sent: { method: string; params: unknown }[] = []
  const closes: (number | undefined)[] = []
  let exitListener: ((info: ExitInfo) => void) | undefined
  let refusal: 'closed' | 'exited' | undefined
  let incomplete: number | undefined
  let n = 0
  return {
    launches,
    sent,
    closes,
    exit: (info) => exitListener?.({ code: 0, signal: null, requested: false, ...info }),
    refuse: (kind) => {
      refusal = kind
    },
    incompleteOnClose: (pid) => {
      incomplete = pid
    },
    launch: (options) => {
      launches.push(options)
      const transport: CdpTransport = {
        pid: 4242,
        send: <T>(method: string, params?: object): Promise<T> => {
          sent.push({ method, params })
          if (refusal !== undefined) return Promise.reject(new CdpError(refusal, method, 'gone'))
          n++
          const answers: Record<string, unknown> = {
            'Target.createTarget': { targetId: `T${n}` },
            'Target.attachToTarget': { sessionId: `S${n}` },
            'Target.createBrowserContext': { browserContextId: `C${n}` },
          }
          return Promise.resolve((answers[method] ?? {}) as T)
        },
        on: () => () => {},
        onExit: (listener) => {
          exitListener = listener
          return () => {}
        },
        close: (graceMs) => {
          closes.push(graceMs)
          if (incomplete !== undefined) options.onCloseIncomplete?.(incomplete)
          return Promise.resolve()
        },
      }
      return Promise.resolve(transport)
    },
  }
}

const noOrphans: OrphanProbe = {
  readLock: () => null,
  commandOf: () => null,
  kill: () => {},
  sleep: () => Promise.resolve(),
}

function windows(fake: Fake, extra: Partial<ConstructorParameters<typeof AgentWindows>[0]> = {}): AgentWindows {
  return new AgentWindows({ binary: '/chrome', profileDir: '/profile', launch: fake.launch, probe: noOrphans, ...extra })
}

describe('AgentWindows (N-010, REQ-61)', () => {
  it('starts the browser without a window and never with --enable-automation; launch adds the pipe and the profile', async () => {
    const fake = fakeBrowser()
    await windows(fake).openWindow()
    expect(fake.launches).toHaveLength(1)
    const args = fake.launches[0]?.args ?? []
    expect(args).toContain('--no-startup-window')
    expect(args).toEqual(AGENT_BROWSER_ARGS)
    expect(args.some((a) => a.startsWith('--enable-automation') || a.startsWith('--remote-debugging') || a.startsWith('--user-data-dir'))).toBe(false)
    expect(fake.launches[0]?.userDataDir).toBe('/profile')
  })

  it('opens a task window in the background, in a new window, and attaches a flat session to it', async () => {
    const fake = fakeBrowser()
    const opened = await windows(fake).openWindow()
    expect(fake.sent[0]).toEqual({ method: 'Target.createTarget', params: { url: 'about:blank', newWindow: true, background: true } })
    expect(fake.sent[1]).toEqual({ method: 'Target.attachToTarget', params: { targetId: opened.targetId, flatten: true } })
    expect(opened).toEqual({ targetId: 'T1', cdpSessionId: 'S2' })
  })

  it('starts one browser for many windows, and shutdown closes its group with the constant grace', async () => {
    const fake = fakeBrowser()
    const w = windows(fake)
    await Promise.all([w.openWindow(), w.openWindow()])
    expect(fake.launches).toHaveLength(1)
    expect(w.openWindows()).toHaveLength(2)
    expect(await w.shutdown()).toEqual({ complete: true })
    expect(fake.closes).toEqual([CLOSE_GRACE_MS])
    expect(w.openWindows()).toEqual([])
    expect(await w.shutdown()).toEqual({ complete: true })
    expect(fake.closes).toHaveLength(1)
  })

  it('refuses --enable-automation and a debugging port as extra flags, and lets --host-resolver-rules through', () => {
    const fake = fakeBrowser()
    for (const flag of ['--enable-automation', '--remote-debugging-port=9222', '--remote-debugging-pipe', '--user-data-dir=/x']) {
      expect(() => windows(fake, { extraArgs: [flag] })).toThrow(TypeError)
    }
    expect(() => windows(fake, { extraArgs: ['--host-resolver-rules=MAP * 127.0.0.1'] })).not.toThrow()
  })

  it('tells a browser that left on its own from one it was asked to close, and drops the windows it took', async () => {
    const fake = fakeBrowser()
    const heard: [boolean, readonly string[]][] = []
    const w = windows(fake, { onExit: (info, closed) => heard.push([info.requested, closed]) })
    await w.openWindow()
    fake.exit({ requested: false, signal: 'SIGKILL' })
    expect(heard).toEqual([[false, ['T1']]])
    expect(w.openWindows()).toEqual([])
    // What the browser left behind of its group is swept.
    expect(fake.closes).toEqual([CLOSE_GRACE_MS])
    await w.openWindow()
    expect(fake.launches).toHaveLength(2)
    fake.exit({ requested: true })
    expect(heard.at(-1)).toEqual([true, []])
  })

  it('ends the group when the pipe refuses as closed, and starts a new browser for the next window', async () => {
    const fake = fakeBrowser()
    const w = windows(fake)
    await w.openWindow()
    fake.refuse('closed')
    await expect(w.openWindow()).rejects.toMatchObject({ kind: 'closed' })
    expect(fake.closes).toEqual([CLOSE_GRACE_MS])
    expect(w.openWindows()).toEqual([])
    fake.refuse(undefined)
    await w.openWindow()
    expect(fake.launches).toHaveLength(2)
  })

  it('reports a close that left a process, and does not count the windows closed', async () => {
    const fake = fakeBrowser()
    const pids: number[] = []
    const w = windows(fake, { onCloseIncomplete: (pid) => pids.push(pid) })
    await w.openWindow()
    fake.incompleteOnClose(4242)
    expect(await w.shutdown()).toEqual({ complete: false })
    expect(pids).toEqual([4242])
    expect(w.openWindows()).toEqual(['T1'])
  })

  it('gives a disposable window a browser context of its own and disposes it with the window', async () => {
    const fake = fakeBrowser()
    const w = windows(fake)
    const opened = await w.openWindow('disposable')
    expect(fake.sent[0]?.method).toBe('Target.createBrowserContext')
    expect(fake.sent[1]?.params).toMatchObject({ browserContextId: 'C1', newWindow: true, background: true })
    await w.closeWindow(opened.targetId)
    expect(fake.sent.slice(-2).map((s) => s.method)).toEqual(['Target.closeTarget', 'Target.disposeBrowserContext'])
    expect(fake.sent.at(-1)?.params).toEqual({ browserContextId: 'C1' })
    expect(w.sessionOf(opened.targetId)).toBeUndefined()
  })

  it('sweeps the orphans of its own profile before starting the browser', async () => {
    const fake = fakeBrowser()
    const order: string[] = []
    const probe: OrphanProbe = { ...noOrphans, readLock: () => (order.push('sweep'), null) }
    const launch = (o: LaunchOptions): Promise<CdpTransport> => (order.push('launch'), fake.launch(o))
    await new AgentWindows({ binary: '/c', profileDir: '/p', launch, probe }).openWindow()
    expect(order).toEqual(['sweep', 'launch'])
  })
})
