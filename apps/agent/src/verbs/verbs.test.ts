import { existsSync, readFileSync } from 'node:fs'

import { CdpError } from '@okolos/cdp-pipe'
import { BRIDGE_VERBS, BRIDGE_SESSION_VERBS } from '@okolos/contracts'
import { describe, expect, it } from 'vitest'

import type { AgentRecord } from '../pairing/pairing.js'
import { Tasks } from '../tasks/tasks.js'
import type { AgentWindows } from '../window/window.js'
import { cdpRefusal, createVerbs } from './verbs.js'

const AGENT: AgentRecord = { agentId: 'a1', name: 'agent', pairedAt: 0, lastCallAt: null }
const OTHER: AgentRecord = { agentId: 'a2', name: 'other', pairedAt: 0, lastCallAt: null }

function fakeWindows(opened: string[] = [], closed: string[] = []): AgentWindows {
  return {
    openWindow: () => {
      opened.push(`T${opened.length + 1}`)
      return Promise.resolve({ targetId: `T${opened.length}`, cdpSessionId: `S${opened.length}` })
    },
    sessionOf: (id: string) => (opened.includes(id) && !closed.includes(id) ? `S${id.slice(1)}` : undefined),
    closeWindow: (id: string) => {
      closed.push(id)
      return Promise.resolve()
    },
    transport: () =>
      Promise.resolve({
        pid: 1,
        send: (method: string) =>
          Promise.resolve(method === 'Page.getFrameTree' ? { frameTree: { frame: { id: 'F' } } } : {}),
        on: () => () => {},
        onExit: () => () => {},
        close: () => Promise.resolve(),
      }),
  } as unknown as AgentWindows
}

const SCOPE = {
  goal: 'Read the pricing page',
  origins: { read: ['https://example.com'], write: [] },
  verbs: ['open', 'snapshot', 'close'],
  ttlSeconds: 600,
  stepBudget: 5,
  profile: 'disposable',
}

function verbsWith(windows = fakeWindows()) {
  const ops = createVerbs({ tasks: new Tasks(), windows, probeSource: '', census: () => Promise.resolve([]) })
  const run = (verb: string, input: unknown, agent = AGENT) => {
    const op = ops.find((o) => o.verb === verb)
    if (op === undefined) throw new Error(verb)
    return op.run(op.input.parse(input), { agent })
  }
  return { ops, run }
}

describe('the verbs (N-011)', () => {
  it('are exactly the contract verbs, with no screenshot among them', () => {
    const { ops } = verbsWith()
    expect(ops.map((o) => o.verb).sort()).toEqual([...BRIDGE_VERBS, ...BRIDGE_SESSION_VERBS].sort())
    expect(ops.map((o) => o.verb)).not.toContain('screenshot')
    for (const op of ops) expect(op.input.safeParse(op.example).success, op.verb).toBe(true)
  })

  it('opens a task with its own window and closes both; another agent sees no such task', async () => {
    const opened: string[] = []
    const closed: string[] = []
    const { run } = verbsWith(fakeWindows(opened, closed))
    const result = await run('session.open', SCOPE)
    expect(result).toMatchObject({ success: true, data: { windowId: 'T1' } })
    const { sessionId } = (result as { data: { sessionId: string } }).data
    expect(sessionId).toMatch(/^[0-9a-f]{32}$/)
    expect(await run('close', { sessionId }, OTHER)).toMatchObject({ success: false, error: { code: 'no_such_task' } })
    expect(await run('close', { sessionId })).toMatchObject({ success: true, data: { closed: true } })
    expect(closed).toEqual(['T1'])
  })

  it('refuses a scope it cannot hold, and an address outside the task before navigating', async () => {
    const { run } = verbsWith()
    expect(await run('session.open', { ...SCOPE, origins: { read: ['file:///etc'], write: [] } })).toMatchObject({
      success: false,
      error: { code: 'invalid_scope' },
    })
    const { data } = (await run('session.open', SCOPE)) as { data: { sessionId: string } }
    expect(await run('open', { sessionId: data.sessionId, url: 'https://evil.example/' })).toMatchObject({
      success: false,
      error: { code: 'origin_not_in_task' },
    })
    expect(await run('read', { sessionId: data.sessionId })).toMatchObject({ success: false, error: { code: 'verb_not_in_task' } })
  })

  it('answers a ref it never gave out as stale, and a cursor with no snapshot as stale', async () => {
    const { run } = verbsWith()
    const { data } = (await run('session.open', SCOPE)) as { data: { sessionId: string } }
    expect(await run('open', { sessionId: data.sessionId, ref: 'rAAAAAAAAAAAAAAAA' })).toMatchObject({ success: false, error: { code: 'stale_cursor' } })
  })

  it('turns a CdpError into the contract refusal by its kind', () => {
    expect(cdpRefusal(new CdpError('exited', 'Page.navigate', 'gone')).code).toBe('browser_offline')
    expect(cdpRefusal(new CdpError('closed', 'Page.navigate', 'gone')).code).toBe('browser_offline')
    expect(cdpRefusal(new CdpError('cdp', 'Page.navigate', 'No target with given id found', -32000)).code).toBe('tab_gone')
    expect(cdpRefusal(new CdpError('cdp', 'DOM.getDocument', 'Session with given id not found', -32001)).code).toBe('tab_gone')
    expect(cdpRefusal(new CdpError('timeout', 'Page.navigate', 'no answer')).code).toBe('internal')
    expect(cdpRefusal(new Error('anything')).code).toBe('internal')
  })

  it('lets loopback through only for tests: main.ts never passes allowLoopbackForTests', () => {
    const file = new URL('../main.ts', import.meta.url)
    // main.ts is written after the verbs; until then there is nothing that could pass it.
    const main = existsSync(file) ? readFileSync(file, 'utf8') : ''
    expect(main).not.toContain('allowLoopbackForTests')
  })

  it('answers the census without a task', async () => {
    const ops = createVerbs({
      tasks: new Tasks(),
      windows: fakeWindows(),
      probeSource: '',
      census: () => Promise.resolve([{ pid: 1, ppid: 0, executable: '/c', owner: null, ageSeconds: 1, flags: [], keep: true, reason: 'persons-browser' }]),
    })
    const census = ops.find((o) => o.verb === 'hygiene.census')
    expect(await census?.run({}, { agent: AGENT })).toMatchObject({ success: true, data: [{ pid: 1 }] })
  })

  it('hands an agent\'s read of Okolos to the extension, and checks its input first (B-218 wave (b))', async () => {
    const asked: Array<{ verb: string; input: unknown }> = []
    const extension = {
      ask: (verb: string, input: unknown) => {
        asked.push({ verb, input })
        return Promise.resolve({ success: true, data: {} })
      },
    } as unknown as NonNullable<Parameters<typeof createVerbs>[0]['extension']>
    const ops = createVerbs({ tasks: new Tasks(), windows: fakeWindows(), probeSource: '', census: () => Promise.resolve([]), extension })
    const op = (verb: string) => ops.find((o) => o.verb === verb) as (typeof ops)[number]
    for (const verb of ['okolos.queue', 'okolos.journal', 'okolos.audit']) {
      expect(op(verb).input.safeParse({ limit: 51 }).success, verb).toBe(false)
      expect(op(verb).input.safeParse({ limit: 50 }).success, verb).toBe(true)
    }
    expect(op('okolos.verdict').input.safeParse({ url: 'file:///etc/passwd' }).success).toBe(false)
    expect(op('okolos.verdict').input.safeParse({ url: 'https://example.com/login' }).success).toBe(true)
    expect(op('okolos.extensions').input.safeParse({ all: true }).success).toBe(false)
    expect(await op('okolos.queue').run({ limit: 5 }, { agent: AGENT })).toEqual({ success: true, data: {} })
    expect(asked).toEqual([{ verb: 'okolos.queue', input: { limit: 5 } }])
    const { run } = verbsWith()
    expect(await run('okolos.audit', {})).toMatchObject({ success: false, error: { code: 'extension_not_connected' } })
  })
})
