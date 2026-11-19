import { describe, expect, it } from 'vitest'

import { AUDIT_CHANNEL, onAuditWritten, signalAuditWritten } from './audit-signal.js'

describe('the outbound log tells an open self-audit panel that a row was written (B-234)', () => {
  it('reaches a listener on the same channel, carries nothing, and closes its own end', async () => {
    let heard = 0
    onAuditWritten(() => (heard += 1))
    const sent: unknown[] = []
    let closed = false
    signalAuditWritten((name) => {
      expect(name).toBe(AUDIT_CHANNEL)
      const real = new BroadcastChannel(name)
      return {
        postMessage: (message: unknown) => {
          sent.push(message)
          real.postMessage(message)
        },
        close: () => {
          closed = true
          real.close()
        },
      }
    })
    await expect.poll(() => heard).toBe(1)
    expect(sent).toEqual([null])
    expect(closed).toBe(true)
  })

  it('does nothing where the API is missing', () => {
    expect(() => signalAuditWritten(() => undefined)).not.toThrow()
    expect(() => onAuditWritten(() => undefined, () => undefined)).not.toThrow()
  })
})
