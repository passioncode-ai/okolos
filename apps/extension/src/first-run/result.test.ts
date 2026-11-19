import { describe, expect, it } from 'vitest'

import { firstRunResult } from './result.js'

describe('the first run result counted as first_run_completed (B-206)', () => {
  it('says findings first, then partial when a check could not run, else clean', () => {
    expect(firstRunResult([{ state: 'ok' }, { state: 'ok' }], 0)).toBe('clean')
    expect(firstRunResult([{ state: 'ok' }, { state: 'unavailable' }], 0)).toBe('partial')
    expect(firstRunResult([{ state: 'failed' }], 0)).toBe('partial')
    expect(firstRunResult([{ state: 'unavailable' }], 2)).toBe('findings')
  })
})
