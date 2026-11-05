import { describe, expect, it } from 'vitest'

import type { TrapKind } from '../../content/traps.js'

import { admissible, CATALOGUE, trapWarning } from './catalogue.js'

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
