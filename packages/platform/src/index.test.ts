import { afterEach, describe, expect, it, vi } from 'vitest'

import { detectPlatform } from './index.js'

const runtime = () => ({
  getURL: (p: string) => p,
  onInstalled: { addListener: () => undefined },
  sendMessage: async () => undefined,
  onMessage: { addListener: () => undefined },
})
const api = (extra: Record<string, unknown> = {}) => ({
  runtime: { ...runtime(), ...extra },
  storage: { local: { get: async () => ({}), set: async () => undefined, remove: async () => undefined } },
  alarms: { create: () => undefined, onAlarm: { addListener: () => undefined } },
  tabs: {},
  i18n: { getMessage: () => '' },
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('which browser this is', () => {
  it('is Chrome when Chromium also offers a `browser` object, as recent Chromium does (found 2026-11-04 in e2e)', () => {
    vi.stubGlobal('chrome', api())
    vi.stubGlobal('browser', api())
    expect(detectPlatform().kind).toBe('chrome')
  })

  it('is Firefox by the API only Firefox has, runtime.getBrowserInfo', () => {
    vi.stubGlobal('chrome', api())
    vi.stubGlobal('browser', api({ getBrowserInfo: async () => ({ name: 'Firefox' }) }))
    expect(detectPlatform().kind).toBe('firefox')
  })

  it('is Chrome with only `chrome`', () => {
    vi.stubGlobal('chrome', api())
    vi.stubGlobal('browser', undefined)
    expect(detectPlatform().kind).toBe('chrome')
  })
})
