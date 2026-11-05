import type { Platform } from '@okolos/platform'
import { describe, expect, it } from 'vitest'

import type { UsageState } from './sink.js'
import { startUsage } from './start.js'

function platform(kind: 'chrome' | 'firefox', stored?: UsageState) {
  const values = new Map<string, unknown>(stored ? [['usage:state', stored]] : [])
  return {
    values,
    platform: {
      kind,
      storage: {
        get: async (key: string) => values.get(key),
        set: async (key: string, value: unknown) => {
          values.set(key, value)
        },
        remove: async (key: string) => {
          values.delete(key)
        },
      },
      runtime: { version: () => '0.1.0' },
      dataConsent: {},
    } as unknown as Platform,
  }
}

const audit = async () => {
  throw new Error('nothing may be sent from a build with no App-Key')
}

describe('the worker wiring', () => {
  it('drops a stored "on" with its install id when Firefox took the grant back', async () => {
    const on: UsageState = { consent: 'on', iid: '6f0c2b0e-8b5e-4d8c-9a51-2f0f5c3d9e11', queue: [] }
    const p = platform('firefox', on)
    const usage = startUsage(p.platform, audit, { getAll: async () => ({ data_collection: [] }) })

    expect(await usage.state()).toBe('off')
    expect(p.values.get('usage:state')).toEqual({ consent: 'off', iid: null, queue: [] })
  })

  it('keeps the install id and the queue when Firefox cannot be read for a moment (B-215)', async () => {
    const waiting = { eventName: 'extension_installed' as const, at: Date.parse('2026-11-04T20:00:00.000Z'), sessionId: '1', props: { reason: 'install' } }
    const on: UsageState = { consent: 'on', iid: '6f0c2b0e-8b5e-4d8c-9a51-2f0f5c3d9e11', queue: [waiting] }
    const p = platform('firefox', on)
    let fail = true
    const usage = startUsage(p.platform, audit, {
      getAll: async () => {
        if (fail) throw new Error('permissions.getAll failed')
        return { data_collection: ['technicalAndInteraction'] }
      },
    })
    await usage.track('first_run_completed', { result: 'clean' })
    await usage.flush()
    // A read that failed is not a grant taken back: nothing stored changes.
    expect(p.values.get('usage:state')).toEqual(on)
    expect(await usage.state()).toBe('on')
    // The switch and the renewal are refused rather than guessed.
    await expect(usage.set(false)).rejects.toThrow()
    await expect(usage.renew()).rejects.toThrow()
    fail = false
    expect(await usage.state()).toBe('on')
    expect((p.values.get('usage:state') as UsageState).iid).toBe(on.iid)
  })

  it('says unsupported on a Firefox with no built-in consent, and the switch cannot change that', async () => {
    const p = platform('firefox')
    const usage = startUsage(p.platform, audit, { getAll: async () => ({ origins: [], permissions: [] }) })
    expect(await usage.state()).toBe('unsupported')
    expect(await usage.set(true)).toBe('unsupported')
  })

  it('in Chrome follows the switch, and a build with no App-Key sends nothing either way', async () => {
    const p = platform('chrome')
    const usage = startUsage(p.platform, audit, {})
    expect(await usage.state()).toBe('on')
    await usage.track('extension_installed', { reason: 'install' })
    await usage.flush()
    expect(await usage.set(false)).toBe('off')
    expect(await usage.state()).toBe('off')
  })

  it('in Firefox reads the answer the page got from the browser, and an on Firefox refused stays off', async () => {
    const p = platform('firefox')
    let granted = false
    const usage = startUsage(p.platform, audit, { getAll: async () => ({ data_collection: granted ? ['technicalAndInteraction'] : [] }) })
    expect(await usage.set(true)).toBe('off')
    granted = true
    expect(await usage.set(true)).toBe('on')
    expect(await usage.set(false)).toBe('off')
  })
})

describe('one change at a time', () => {
  const keyed = { appKey: 'A-SH-0000000000', environment: 'sandbox' as const }

  it('a switch-off that lands while an event is being recorded stays off, with no install id', async () => {
    const p = platform('chrome', { consent: 'on', iid: '6f0c2b0e-8b5e-4d8c-9a51-2f0f5c3d9e11', queue: [] })
    // Every read answers a turn late with what was there when it was asked, so an event's read and
    // its write have a gap another call can use.
    const get = p.platform.storage.get.bind(p.platform.storage)
    p.platform.storage.get = (async (key: string) => {
      const value = structuredClone(await get(key))
      await new Promise((resolve) => setTimeout(resolve, 1))
      return value
    }) as typeof p.platform.storage.get
    const usage = startUsage(p.platform, audit, {}, keyed)

    const tracked = usage.track('warning_shown', { kind: 'lookalike' })
    const off = usage.set(false)
    await Promise.all([tracked, off])

    expect(p.values.get('usage:state')).toEqual({ consent: 'off', iid: null, queue: [] })
  })

  it('two events recorded at once are both kept', async () => {
    const p = platform('chrome')
    const get = p.platform.storage.get.bind(p.platform.storage)
    p.platform.storage.get = (async (key: string) => {
      const value = structuredClone(await get(key))
      await new Promise((resolve) => setTimeout(resolve, 1))
      return value
    }) as typeof p.platform.storage.get
    const usage = startUsage(p.platform, audit, {}, keyed)

    await Promise.all([usage.track('warning_shown', { kind: 'lookalike' }), usage.track('warning_shown', { kind: 'clickfix' })])

    expect((p.values.get('usage:state') as UsageState).queue).toHaveLength(2)
  })

  it('a storage that fails makes an event go missing, never a rejection in the worker', async () => {
    const p = platform('chrome')
    p.platform.storage.get = (async () => {
      throw new Error('storage gone')
    }) as typeof p.platform.storage.get
    const usage = startUsage(p.platform, audit, {}, keyed)
    await expect(usage.track('warning_shown', { kind: 'lookalike' })).resolves.toBeUndefined()
    await expect(usage.flush()).resolves.toBeUndefined()
  })
})

describe('Firefox, where the browser keeps the choice', () => {
  it('a grant given again in Firefox turns collection back on, with a new install id', async () => {
    const p = platform('firefox', { consent: 'off', iid: null, queue: [] })
    const usage = startUsage(p.platform, audit, { getAll: async () => ({ data_collection: ['technicalAndInteraction'] }) })
    expect(await usage.state()).toBe('on')
    expect((p.values.get('usage:state') as UsageState).iid).toMatch(/^[0-9a-f-]{36}$/)
  })
})

describe('the switch, read once', () => {
  it('reads the Firefox grant once, inside the step, so the answer and what is stored cannot disagree', async () => {
    const p = platform('firefox')
    let calls = 0
    const usage = startUsage(p.platform, audit, {
      getAll: async () => {
        calls += 1
        // Granted at the first read only: a second read would see it taken back.
        return { data_collection: calls === 1 ? ['technicalAndInteraction'] : [] }
      },
    })
    const answer = await usage.set(true)
    expect(calls).toBe(1)
    expect(answer).toBe('on')
    expect(p.values.get('usage:state')).toMatchObject({ consent: 'on' })
  })
})

describe('an audit that cannot be opened', () => {
  it('keeps the events: nothing was sent, so they may go next time', async () => {
    const p = platform('chrome')
    const usage = startUsage(
      p.platform,
      async () => {
        throw new Error('the database is blocked')
      },
      {},
      { appKey: 'A-SH-0000000000', environment: 'sandbox' },
    )
    await usage.track('warning_shown', { kind: 'lookalike' })
    await usage.track('warning_shown', { kind: 'clickfix' })
    await usage.flush()
    expect((p.values.get('usage:state') as UsageState).queue).toHaveLength(2)
  })
})

describe('the renewal after an erase', () => {
  const keyed = { appKey: 'A-SH-0000000000', environment: 'sandbox' as const }

  it('renews the install number only when collection is on at that moment, in one step', async () => {
    // A queue that is not empty, so «the unsent events are deleted» (dataConfirmNote) is what is held.
    const waiting = { eventName: 'extension_installed' as const, at: Date.parse('2026-11-04T20:00:00.000Z'), sessionId: '1', props: { reason: 'install' } }
    const p = platform('chrome', { consent: 'on', iid: '6f0c2b0e-8b5e-4d8c-9a51-2f0f5c3d9e11', queue: [waiting] })
    const usage = startUsage(p.platform, audit, {}, keyed)
    expect(await usage.renew()).toBe('on')
    const renewed = p.values.get('usage:state') as UsageState
    expect(renewed.iid).not.toBe('6f0c2b0e-8b5e-4d8c-9a51-2f0f5c3d9e11')
    expect(renewed.queue).toEqual([])
  })

  it('a switch-off that lands before the renewal stays off: the renewal never turns collection back on', async () => {
    const p = platform('chrome', { consent: 'on', iid: '6f0c2b0e-8b5e-4d8c-9a51-2f0f5c3d9e11', queue: [] })
    const usage = startUsage(p.platform, audit, {}, keyed)
    const off = usage.set(false)
    const renewal = usage.renew()
    await Promise.all([off, renewal])
    expect(await renewal).toBe('off')
    expect(p.values.get('usage:state')).toEqual({ consent: 'off', iid: null, queue: [] })
  })
})
