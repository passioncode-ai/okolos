import { describe, expect, it } from 'vitest'

import { PROXY_ORIGIN } from '../apps/extension/src/config.js'
import { proxyHost, proxyHostIn } from './proxy-host.mjs'

describe('the proxy host the Firefox harness keeps the extension away from (B-235)', () => {
  it('is the host of PROXY_ORIGIN, read from the one place it is declared', () => {
    expect(proxyHost()).toBe(new URL(PROXY_ORIGIN).hostname)
  })

  it('refuses a config without the declaration rather than guessing', () => {
    expect(() => proxyHostIn('export const OTHER = 1')).toThrow(/PROXY_ORIGIN/)
  })
})
