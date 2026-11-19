import { describe, expect, it, vi } from 'vitest'

import { afterSends, answeredWithin } from './usage-wait.js'

describe('the usage state, waited for at most a moment (B-214)', () => {
  it('returns an answer that comes in time, and runs nothing later', async () => {
    const later = vi.fn()
    expect(await answeredWithin(Promise.resolve({ state: 'on' }), 2_000, later)).toEqual({ state: 'on' })
    await Promise.resolve()
    expect(later).not.toHaveBeenCalled()
  })

  it('says late past the wait, and runs `later` once the answer arrives', async () => {
    vi.useFakeTimers()
    try {
      let answer!: (value: { state: string }) => void
      const later = vi.fn()
      const waited = answeredWithin(new Promise<{ state: string }>((resolve) => (answer = resolve)), 2_000, later)
      await vi.advanceTimersByTimeAsync(2_000)
      expect(await waited).toBe('late')
      expect(later).not.toHaveBeenCalled()
      answer({ state: 'on' })
      await vi.advanceTimersByTimeAsync(0)
      expect(later).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects as a refusal in time rejects, and a late refusal runs nothing', async () => {
    await expect(answeredWithin(Promise.reject(new Error('unsupported')), 2_000, vi.fn())).rejects.toThrow('unsupported')
    vi.useFakeTimers()
    try {
      let refuse!: (cause: Error) => void
      const later = vi.fn()
      const waited = answeredWithin(new Promise<never>((_resolve, reject) => (refuse = reject)), 2_000, later)
      await vi.advanceTimersByTimeAsync(2_000)
      expect(await waited).toBe('late')
      refuse(new Error('worker gone'))
      await vi.advanceTimersByTimeAsync(0)
      expect(later).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('the erase, after the send under way (B-214)', () => {
  it('waits for the worker step before it erases', async () => {
    const order: string[] = []
    let settle!: () => void
    const erased = afterSends(new Promise<void>((resolve) => (settle = resolve)).then(() => void order.push('send done')), 30_000, async () => {
      order.push('erase')
      return 'wiped'
    })
    await Promise.resolve()
    expect(order).toEqual([])
    settle()
    expect(await erased).toBe('wiped')
    expect(order).toEqual(['send done', 'erase'])
  })

  it('erases anyway when the worker refuses, or has not answered in time', async () => {
    const erase = vi.fn(async () => 'wiped')
    expect(await afterSends(Promise.reject(new Error('unsupported')), 30_000, erase)).toBe('wiped')
    vi.useFakeTimers()
    try {
      const late = afterSends(new Promise(() => {}), 30_000, erase)
      await vi.advanceTimersByTimeAsync(30_000)
      expect(await late).toBe('wiped')
      expect(erase).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
