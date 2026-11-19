import { describe, expect, it } from 'vitest'

import type { TrapKind } from '../../content/traps.js'

import {
  admissible,
  CATALOGUE,
  downloadWarningShown,
  leakCheckResult,
  passwordCheckResult,
  extensionsCheckResult,
  passwordError,
  surfaceWarning,
  trapWarning,
} from './catalogue.js'

describe('the catalogue', () => {
  it('admits an event with every declared prop at one of its values', () => {
    expect(admissible('check_done', { check: 'password', result: 'found' })).toBe(true)
  })

  it('refuses a missing prop, an extra prop, a value off the list and an unknown event', () => {
    expect(admissible('check_done', { check: 'password' })).toBe(false)
    expect(admissible('check_done', { check: 'password', result: 'found', extra: 'found' })).toBe(false)
    expect(admissible('check_done', { check: 'password', result: 'https://x.test' })).toBe(false)
    expect(admissible('anything_else', {})).toBe(false)
  })

  it('names events in snake_case under 60 characters and props under 40, as growth counts them', () => {
    for (const [name, props] of Object.entries(CATALOGUE)) {
      expect(name).toMatch(/^[a-z][a-z0-9_]{0,59}$/)
      for (const [key, values] of Object.entries(props)) {
        expect(key.length).toBeLessThanOrEqual(40)
        for (const value of values as readonly string[]) expect(value).toMatch(/^[a-z0-9-]{1,32}$/)
      }
    }
  })

  it('never names a prop the sink attaches itself', () => {
    for (const props of Object.values(CATALOGUE)) {
      for (const reserved of ['iid', 'environment', 'platform']) expect(Object.keys(props)).not.toContain(reserved)
    }
  })
})

describe('a page trap', () => {
  it('is counted under the catalogue value of its own kind, for every kind the content script sends', () => {
    const kinds: readonly TrapKind[] = ['clickfix', 'techsupport', 'outside-link']
    for (const kind of kinds) {
      const value = trapWarning(kind)
      expect(value, kind).not.toBeNull()
      expect(admissible('warning_shown', { kind: value })).toBe(true)
    }
    expect(trapWarning('techsupport')).toBe('tech-support')
  })

  it('is not counted when its kind is one nobody mapped', () => {
    expect(trapWarning('browser-lock')).toBeNull()
    expect(trapWarning('https://x.test')).toBeNull()
  })
})

describe('a password check', () => {
  it('is counted by what it found out, not by where the answer came from', () => {
    expect(passwordCheckResult('in-common-list')).toBe('found')
    expect(passwordCheckResult('found')).toBe('found')
    expect(passwordCheckResult('absent')).toBe('ok')
    // A question that was not answered is not a clean result.
    expect(passwordCheckResult('unreachable')).toBe('unavailable')
    expect(passwordCheckResult('unreadable')).toBe('unavailable')
  })
})

describe('a download warning', () => {
  it('is counted only when a page showed it: a verdict no page received is a warning nobody saw', () => {
    expect(downloadWarningShown('block', true)).toBe(true)
    expect(downloadWarningShown('warn', true)).toBe(true)
    expect(downloadWarningShown('block', false)).toBe(false)
    expect(downloadWarningShown('warn', false)).toBe(false)
    expect(downloadWarningShown('inform', true)).toBe(false)
  })
})

describe('the leak check, by what it found out (B-215)', () => {
  it('is found when any source found a leak, even if another stayed silent', () => {
    expect(leakCheckResult(2, false)).toBe('found')
    expect(leakCheckResult(1, true)).toBe('found')
  })

  it('is ok only when every source answered and none found anything', () => {
    expect(leakCheckResult(0, true)).toBe('ok')
  })

  it('is unavailable when a source stayed silent and nothing was found: a question not answered', () => {
    expect(leakCheckResult(0, false)).toBe('unavailable')
  })
})

describe('surfaceWarning (B-206)', () => {
  it('maps the surfaces drawn on a page and the block page to catalogue values', () => {
    expect(surfaceWarning('injection')).toBe('hidden-instruction')
    expect(surfaceWarning('lookalike')).toBe('lookalike')
    expect(surfaceWarning('credential')).toBe('credential-guard')
    expect(surfaceWarning('blocked-page')).toBe('blocked-page')
    // The password panel is drawn only for a compromised verdict (B-206).
    expect(surfaceWarning('password')).toBe('leaked-password')
  })

  it('counts nothing it cannot name: traps and downloads are counted where decided', () => {
    for (const kind of ['trap', 'download', 'constructor', '']) expect(surfaceWarning(kind), kind).toBeNull()
  })

  it('maps only to values the catalogue holds', () => {
    for (const kind of ['injection', 'lookalike', 'credential', 'blocked-page', 'password']) {
      expect(CATALOGUE.warning_shown.kind).toContain(surfaceWarning(kind))
    }
  })
})

describe('the extension review counted as check_done (B-206)', () => {
  it('is found with a change, ok with none, unavailable without an inventory', () => {
    expect(extensionsCheckResult({ changes: 2 })).toBe('found')
    expect(extensionsCheckResult({ changes: 0 })).toBe('ok')
    expect(extensionsCheckResult('unavailable')).toBe('unavailable')
    for (const result of ['found', 'ok', 'unavailable'] as const) expect(CATALOGUE.check_done.result).toContain(result)
  })
})

describe('a password check that could not be answered, for error_occurred (B-206)', () => {
  it('is network when the query did not get through, unexpected when the list could not be read, and no error otherwise', () => {
    expect(passwordError('unreachable')).toBe('network')
    expect(passwordError('unreadable')).toBe('unexpected')
    for (const code of ['found', 'absent', 'in-common-list'] as const) expect(passwordError(code)).toBeNull()
    expect(CATALOGUE.error_occurred.kind).toEqual(expect.arrayContaining(['network', 'unexpected']))
  })
})
