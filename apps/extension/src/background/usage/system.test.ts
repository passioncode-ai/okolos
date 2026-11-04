import { describe, expect, it } from 'vitest'

import { sessionIdAt } from './system.js'

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
