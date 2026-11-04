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
})
