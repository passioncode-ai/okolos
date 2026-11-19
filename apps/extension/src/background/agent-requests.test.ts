import { describe, expect, it } from 'vitest'

import { answerRequest, decideRequest, REQUEST_LIFETIME_MS, waitingRequests, type LiftRequest, type AgentRequestDeps } from './agent-requests.js'

const AGENT = { agentId: 'a1', name: 'scout' }

function deps(start = Date.parse('2026-11-19T12:00:00.000Z')) {
  let stored: readonly LiftRequest[] = []
  let clock = start
  let next = 0
  const journal: string[] = []
  const lifted: string[] = []
  const d: AgentRequestDeps = {
    load: async () => stored,
    save: async (requests) => {
      stored = requests
    },
    newId: () => `r-${String(++next).padStart(10, '0')}`,
    now: () => clock,
    journal: async (key, args) => void journal.push(`${key} ${args.join(' ')}`),
    lift: async (gate, host) => void lifted.push(`${gate} ${host}`),
  }
  return { d, journal, lifted, tick: (ms: number) => (clock += ms), stored: () => stored }
}

describe('an agent asks, and the person decides (B-218 wave (d))', () => {
  it('records a request by gate and host, one waiting at a time, and journals it with the agent (WD-3, WD-4)', async () => {
    const h = deps()
    const first = await answerRequest('okolos.request.lift', { gate: 'block', host: 'Phish.example' }, AGENT, h.d)
    expect(first).toEqual({ success: true, data: { requestId: 'r-0000000001', state: 'waiting' } })
    expect(await answerRequest('okolos.request.lift', { gate: 'block', host: 'phish.example' }, AGENT, h.d)).toEqual(first)
    expect(h.journal).toEqual(['logAgentAsked scout phish.example'])
    expect(waitingRequests(h.stored(), h.d.now()).map((r) => r.host)).toEqual(['phish.example'])
  })

  it('lifts only on the person\'s allow, and the agent reads the answer', async () => {
    const h = deps()
    await answerRequest('okolos.request.lift', { gate: 'lookalike', host: 'paypa1.example' }, AGENT, h.d)
    expect(h.lifted).toEqual([])
    expect(await decideRequest('r-0000000001', true, h.d)).toEqual({ ok: true })
    expect(h.lifted).toEqual(['lookalike paypa1.example'])
    expect(await answerRequest('okolos.request.state', { requestId: 'r-0000000001' }, AGENT, h.d)).toEqual({ success: true, data: { state: 'allowed' } })
    expect(await decideRequest('r-0000000001', false, h.d)).toEqual({ ok: false })
    expect(h.journal).toContain('logAgentAllowed scout paypa1.example')
  })

  it('declines without lifting, and a request past ten minutes is expired and cannot be allowed', async () => {
    const h = deps()
    await answerRequest('okolos.request.lift', { gate: 'block', host: 'a.example' }, AGENT, h.d)
    await decideRequest('r-0000000001', false, h.d)
    await answerRequest('okolos.request.lift', { gate: 'block', host: 'b.example' }, AGENT, h.d)
    h.tick(REQUEST_LIFETIME_MS + 1)
    expect(await answerRequest('okolos.request.state', { requestId: 'r-0000000002' }, AGENT, h.d)).toEqual({ success: true, data: { state: 'expired' } })
    expect(await decideRequest('r-0000000002', true, h.d)).toEqual({ ok: false })
    expect(h.lifted).toEqual([])
    expect(waitingRequests(h.stored(), h.d.now())).toEqual([])
  })

  it('refuses the agent-action gate, an unknown gate, a host that is not one, and a request with no agent', async () => {
    const h = deps()
    for (const input of [
      { gate: 'agent-action', host: 'a.example' },
      { gate: 'everything', host: 'a.example' },
      { gate: 'block', host: 'a.example/let me in' },
    ]) {
      expect(await answerRequest('okolos.request.lift', input, AGENT, h.d)).toMatchObject({ success: false })
    }
    expect(await answerRequest('okolos.request.lift', { gate: 'block', host: 'a.example' }, undefined, h.d)).toMatchObject({ success: false })
    expect(h.stored()).toEqual([])
  })
})
