import { describe, expect, it } from 'vitest'

import { sessionFor, sessionIdAt } from './system.js'

describe('the session id', () => {
  it('is numeric in the SDK form, starts at its hour and stays the same inside it', () => {
    const at = Date.parse('2026-11-04T22:15:00Z')
    const id = sessionIdAt(at, 12345678)
    expect(id).toMatch(/^\d+$/)
    expect(id).toBe(sessionIdAt(Date.parse('2026-11-04T22:59:59Z'), 12345678))
    expect(id).not.toBe(sessionIdAt(Date.parse('2026-11-04T23:00:00Z'), 12345678))
    expect(BigInt(id) / 100000000n).toBe(BigInt(Date.parse('2026-11-04T22:00:00Z') / 1000))
  })
})

describe('one session an hour, across wakes', () => {
  it('is the same number for one install within one clock hour, whatever woke the worker', () => {
    const at = Date.parse('2026-11-05T03:10:00.000Z')
    const iid = '6f0c2b0e-8b5e-4d8c-9a51-2f0f5c3d9e11'
    expect(sessionFor(at, iid)).toBe(sessionFor(at + 40 * 60 * 1000, iid))
    expect(sessionFor(at, iid)).not.toBe(sessionFor(at + 60 * 60 * 1000, iid))
    expect(sessionFor(at, iid)).not.toBe(sessionFor(at, '0d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a'))
    expect(sessionFor(at, iid)).toMatch(/^\d{18}$/)
  })
})
