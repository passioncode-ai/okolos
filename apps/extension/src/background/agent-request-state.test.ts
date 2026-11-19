import { describe, expect, it } from 'vitest'

import { stateOf, waitingRequests, type LiftRequest } from './agent-request-state.js'

const NOW = Date.parse('2026-11-19T12:00:00.000Z')
const request = (over: Partial<LiftRequest>): LiftRequest => ({
  id: 'r1',
  gate: 'block',
  host: 'a.example',
  agentId: 'a1',
  agentName: 'scout',
  createdAt: NOW - 60_000,
  expiresAt: NOW + 540_000,
  state: 'waiting',
  ...over,
})

describe('a request to lift a gate, as kept (B-218 wave (d))', () => {
  it('is expired once waiting past its ten minutes, and keeps an answer it was given', () => {
    expect(stateOf(request({}), NOW)).toBe('waiting')
    expect(stateOf(request({ expiresAt: NOW - 1 }), NOW)).toBe('expired')
    expect(stateOf(request({ expiresAt: NOW - 1, state: 'allowed' }), NOW)).toBe('allowed')
  })

  it('lists only the waiting ones, oldest first', () => {
    const list = [
      request({ id: 'late', createdAt: NOW - 1_000 }),
      request({ id: 'early', createdAt: NOW - 5_000 }),
      request({ id: 'gone', expiresAt: NOW - 1 }),
      request({ id: 'answered', state: 'declined' }),
    ]
    expect(waitingRequests(list, NOW).map((r) => r.id)).toEqual(['early', 'late'])
  })
})
