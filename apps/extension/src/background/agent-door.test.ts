import { describe, expect, it, vi } from 'vitest'

import { agentDoorPost, pairAgentDoor, releaseAgentDoor, wakeAgentDoor, WAKE_BUDGET_MS, type AgentDoorDeps, type AgentDoorLink } from './agent-door.js'

type Reply = { status: number; body: unknown }

function deps(replies: Record<string, Reply[] | ((body: unknown) => Reply)>, start?: AgentDoorLink) {
  let link = start
  let clock = Date.parse('2026-11-19T10:00:00.000Z')
  const sent: Array<{ path: string; body: unknown; token?: string }> = []
  const alarms: boolean[] = []
  const d: AgentDoorDeps = {
    post: vi.fn(async (path: string, body: unknown, token?: string) => {
      sent.push({ path, body, ...(token === undefined ? {} : { token }) })
      const reply = replies[path]
      if (typeof reply === 'function') return reply(body)
      const next = reply?.shift()
      if (next === undefined) throw new TypeError('Failed to fetch')
      return next
    }),
    load: async () => link,
    save: async (next) => {
      link = next
    },
    forget: async () => {
      link = undefined
    },
    alarm: async (on) => {
      alarms.push(on)
    },
    version: () => '1.4.0',
    now: () => clock,
  }
  return { d, sent, alarms, link: () => link, tick: (ms: number) => (clock += ms) }
}

const LINK: AgentDoorLink = { token: 'tok', pairedAt: '2026-11-19T09:00:00.000Z' }

describe('pairing from the settings page (B-218, SCN-054)', () => {
  it('keeps the token and sets the alarm on a code Okolos Agent accepts', async () => {
    const h = deps({ '/extension/pair': [{ status: 200, body: { token: 'tok', wakeSeconds: 60 } }] })
    expect(await pairAgentDoor(' 123456 ', h.d)).toEqual({ ok: true, pairedAt: '2026-11-19T10:00:00.000Z' })
    expect(h.sent[0]).toEqual({ path: '/extension/pair', body: { code: '123456' } })
    expect(h.link()).toEqual({ token: 'tok', pairedAt: '2026-11-19T10:00:00.000Z' })
    expect(h.alarms).toEqual([true])
  })

  it('stores nothing and sets no alarm for a wrong or expired code, or no answer', async () => {
    for (const [reply, reason] of [
      [{ status: 403, body: { error: 'bad_code' } }, 'bad_code'],
      [{ status: 403, body: { error: 'expired' } }, 'expired'],
    ] as const) {
      const h = deps({ '/extension/pair': [reply] })
      expect(await pairAgentDoor('000000', h.d)).toEqual({ ok: false, reason })
      expect(h.link()).toBeUndefined()
      expect(h.alarms).toEqual([])
    }
    const h = deps({})
    expect(await pairAgentDoor('000000', h.d)).toEqual({ ok: false, reason: 'unreachable' })
  })
})

describe('a wake (WA-1, WA-2, WA-4)', () => {
  it('makes no request and clears the alarm while nothing is paired', async () => {
    const h = deps({})
    expect(await wakeAgentDoor(h.d)).toBe('not-paired')
    expect(h.sent).toEqual([])
    expect(h.alarms).toEqual([false])
  })

  it('answers okolos.ping with the version and since when it is connected, then asks again', async () => {
    const h = deps(
      {
        '/extension/next': [
          { status: 200, body: { requests: [{ id: 'r1', verb: 'okolos.ping', input: {} }] } },
          { status: 200, body: { requests: [] } },
        ],
        '/extension/answer': () => ({ status: 200, body: { accepted: true } }),
      },
      LINK,
    )
    expect(await wakeAgentDoor(h.d)).toBe('answered')
    expect(h.sent.map((s) => s.path)).toEqual(['/extension/next', '/extension/answer', '/extension/next'])
    expect(h.sent[1]?.body).toEqual({ id: 'r1', verb: 'okolos.ping', result: { success: true, data: { extensionVersion: '1.4.0', connectedSince: LINK.pairedAt } } })
    expect(h.sent.every((s) => s.token === 'tok')).toBe(true)
  })

  it('refuses a verb it does not know, rather than leaving the agent waiting', async () => {
    const h = deps(
      {
        '/extension/next': [{ status: 200, body: { requests: [{ id: 'r2', verb: 'snapshot' }] } }, { status: 200, body: { requests: [] } }],
        '/extension/answer': () => ({ status: 200, body: { accepted: true } }),
      },
      LINK,
    )
    await wakeAgentDoor(h.d)
    expect((h.sent[1]?.body as { result: { success: boolean } }).result.success).toBe(false)
  })

  it('forgets the link and the alarm when Okolos Agent says it is not connected', async () => {
    const h = deps({ '/extension/next': [{ status: 401, body: { error: 'not_connected' } }] }, LINK)
    expect(await wakeAgentDoor(h.d)).toBe('disconnected')
    expect(h.link()).toBeUndefined()
    expect(h.alarms).toEqual([false])
  })

  it('keeps the link when Okolos Agent does not answer at all', async () => {
    const h = deps({}, LINK)
    expect(await wakeAgentDoor(h.d)).toBe('unreachable')
    expect(h.link()).toEqual(LINK)
  })

  it('stops asking once the wake budget is spent', async () => {
    const h = deps(
      {
        '/extension/next': () => {
          h.tick(WAKE_BUDGET_MS / 2)
          return { status: 200, body: { requests: [{ id: 'r', verb: 'okolos.ping' }] } }
        },
        '/extension/answer': () => ({ status: 200, body: { accepted: true } }),
      },
      LINK,
    )
    expect(await wakeAgentDoor(h.d)).toBe('answered')
    expect(h.sent.filter((s) => s.path === '/extension/next')).toHaveLength(2)
  })
})

describe('disconnecting from the settings page', () => {
  it('tells Okolos Agent, forgets the link and clears the alarm, even when Okolos Agent is down', async () => {
    const h = deps({}, LINK)
    await releaseAgentDoor(h.d)
    expect(h.sent[0]).toEqual({ path: '/extension/release', body: {}, token: 'tok' })
    expect(h.link()).toBeUndefined()
    expect(h.alarms).toEqual([false])
  })
})

describe('the request goes through the network module', () => {
  it('logs it under agent-door, to 127.0.0.1, with the token only in a header', async () => {
    const audits: Array<{ purpose: string; destination: string; payloadShape: string; triggeredBy: string }> = []
    const transport = vi.fn(async () => new Response(JSON.stringify({ requests: [] }), { status: 200 }))
    const post = agentDoorPost(async () => ({
      writeAudit: async (entry) => {
        audits.push(entry)
      },
      transport,
      now: () => '2026-11-19T10:00:00.000Z',
      newId: () => 'id',
    }))
    expect(await post('/extension/next', {}, 'tok')).toEqual({ status: 200, body: { requests: [] } })
    expect(audits[0]).toMatchObject({ purpose: 'agent-door', destination: '127.0.0.1', payloadShape: 'agent-door:next', triggeredBy: 'alarm:okolos:agent' })
    expect(JSON.stringify(audits)).not.toContain('tok')
    expect(transport).toHaveBeenCalledWith(expect.objectContaining({ url: 'http://127.0.0.1:47871/extension/next', headers: expect.objectContaining({ Authorization: 'Bearer tok' }) }))
  })

  it('asks for the port at each request when given a function (the e2e build only)', async () => {
    const transport = vi.fn(async () => new Response('{}', { status: 200 }))
    const deps = async () => ({ writeAudit: async () => undefined, transport, now: () => '2026-11-19T10:00:00.000Z', newId: () => 'id' })
    await agentDoorPost(deps, async () => 51234)('/extension/release', {}, 'tok')
    expect(transport).toHaveBeenCalledWith(expect.objectContaining({ url: 'http://127.0.0.1:51234/extension/release' }))
  })
})
