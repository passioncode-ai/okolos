import { describe, expect, it } from 'vitest'

import { pageMarks } from './build-flags.mjs'

describe('which builds write marks a page can read (B-190)', () => {
  it('the store build writes none', () => {
    expect(pageMarks({ withTestHooks: false, env: { OKOLOS_USAGE_ENV: 'production' } })).toBe(false)
  })

  it('every other build writes them, so the e2e suite can wait on them', () => {
    expect(pageMarks({ withTestHooks: false, env: {} })).toBe(true)
    expect(pageMarks({ withTestHooks: false, env: { OKOLOS_USAGE_ENV: 'sandbox' } })).toBe(true)
  })

  it('the test-hook build always writes them', () => {
    expect(pageMarks({ withTestHooks: true, env: { OKOLOS_USAGE_ENV: 'production' } })).toBe(true)
  })
})
