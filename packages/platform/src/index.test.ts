import { afterEach, describe, expect, it, vi } from 'vitest'

import { detectPlatform } from './index.js'

const runtime = () => ({
  getURL: (p: string) => `chrome-extension://okolos/${p}`,
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

  it('is Chrome with only a `browser` object that is not Firefox: the Chrome consent rule, by decision (B-215)', () => {
    vi.stubGlobal('chrome', undefined)
    vi.stubGlobal('browser', api())
    expect(detectPlatform().kind).toBe('chrome')
  })

  it('is Chrome with only `chrome`', () => {
    vi.stubGlobal('chrome', api())
    vi.stubGlobal('browser', undefined)
    expect(detectPlatform().kind).toBe('chrome')
  })

  it('is Firefox in a content script too, where there is no getBrowserInfo: the extension URL says so', () => {
    const firefox = api({ getURL: (p: string) => `moz-extension://okolos/${p}` })
    vi.stubGlobal('chrome', api())
    vi.stubGlobal('browser', firefox)
    const platform = detectPlatform()
    expect(platform.kind).toBe('firefox')
    // And on Firefox's own promise-based `browser` object, as before B-199.
    expect(platform.runtime.getUrl('x')).toBe('moz-extension://okolos/x')
  })
})
