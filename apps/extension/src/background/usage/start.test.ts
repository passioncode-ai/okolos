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
