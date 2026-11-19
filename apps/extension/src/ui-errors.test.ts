import { describe, expect, it, vi } from 'vitest'

import { countUncaughtErrors } from './ui-errors.js'

describe('an uncaught error on an extension page (B-206)', () => {
  it('tells the worker once per page load, for an error and for an unhandled rejection alike', () => {
    const target = new EventTarget()
    const tell = vi.fn(async () => ({ ok: true }))
    countUncaughtErrors(target, tell)
    target.dispatchEvent(new Event('unhandledrejection'))
    target.dispatchEvent(new Event('error'))
    target.dispatchEvent(new Event('error'))
    expect(tell).toHaveBeenCalledOnce()
  })

  it('tells nothing while nothing failed', () => {
    const target = new EventTarget()
    const tell = vi.fn(async () => ({ ok: true }))
    countUncaughtErrors(target, tell)
    target.dispatchEvent(new Event('click'))
    expect(tell).not.toHaveBeenCalled()
  })

  it('survives a worker that cannot be told', async () => {
    const target = new EventTarget()
    const tell = vi.fn(async () => Promise.reject(new Error('worker restarting')))
    countUncaughtErrors(target, tell)
    expect(() => target.dispatchEvent(new Event('error'))).not.toThrow()
    await Promise.resolve()
    expect(tell).toHaveBeenCalledOnce()
  })
})
