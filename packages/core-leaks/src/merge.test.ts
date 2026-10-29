import { describe, expect, it } from 'vitest'

import { mergeLeaks, type Leak, type SourceStatus } from './merge.js'

function leak(overrides: Partial<Leak> = {}): Leak {
  return {
    name: 'ExampleCorp',
    occurredAt: '2024-03-01',
    source: 'HIBP',
    classes: ['email addresses', 'passwords'],
    ...overrides,
  }
}

const answered = (name: string, leaks: Leak[]): SourceStatus => ({ name, answered: true, leaks })
const silent = (name: string, why: string): SourceStatus => ({ name, answered: false, why })

describe('what the number counts', () => {
  it('states the sources behind it when they all answered', () => {
    const inventory = mergeLeaks([answered('HIBP', [leak()]), answered('Cavalier', [])])
    expect(inventory.complete).toBe(true)
    expect(inventory.sources.map((source) => source.name)).toEqual(['HIBP', 'Cavalier'])
  })

  it('says the list may be incomplete when one source went quiet', () => {
    // The silent failure this exists to prevent: a total that shrinks because a
    // source timed out, and reads as good news.
    const inventory = mergeLeaks([
      answered('HIBP', [leak()]),
      silent('Cavalier', 'the request timed out'),
    ])
    expect(inventory.complete).toBe(false)
    // The facts the screen composes its sentence from; the sentence itself is
    // no longer built in a core package.
    expect(inventory.sources.filter((source) => !source.answered).map((s) => s.name)).toEqual([
      'Cavalier',
    ])
  })

  it('keeps the reason each source gave', () => {
    const inventory = mergeLeaks([silent('Cavalier', 'no API key configured')])
    expect(inventory.sources[0]).toMatchObject({ answered: false, why: 'no API key configured' })
  })

  it('keeps whether the remedy is a key, so the screen can point at the field', () => {
    // A timeout's remedy is waiting; a missing or refused key's remedy is a setting.
    // The screen offers the link only for the second, and it can only tell them apart
    // if the fact survives the merge.
    const inventory = mergeLeaks([
      { name: 'Have I Been Pwned', answered: false, why: 'no key', needsKey: 'missing' },
      { name: 'Other', answered: false, why: 'refused', needsKey: 'refused' },
      silent('Cavalier', 'timed out'),
    ])
    expect(inventory.sources.map((source) => source.needsKey)).toEqual(['missing', 'refused', undefined])
    expect(inventory.sources[2]).not.toHaveProperty('needsKey')
  })

  it('keeps an unreadable key apart from a missing one', () => {
    const inventory = mergeLeaks([
      { name: 'Have I Been Pwned', answered: false, why: 'unreadable', needsKey: 'unreadable' },
    ])
    expect(inventory.sources[0]?.needsKey).toBe('unreadable')
  })

  it('does not pretend an empty result is a complete one when nothing answered', () => {
    const inventory = mergeLeaks([silent('HIBP', 'offline'), silent('Cavalier', 'offline')])
    expect(inventory.leaks).toEqual([])
    expect(inventory.complete).toBe(false)
    expect(inventory.sources.every((source) => !source.answered)).toBe(true)
  })
})

describe('the same breach from several places', () => {
  it('is counted once', () => {
    const inventory = mergeLeaks([
      answered('HIBP', [leak()]),
      answered('Cavalier', [leak({ source: 'Cavalier' })]),
    ])
    expect(inventory.leaks).toHaveLength(1)
  })

  it('keeps what each source knew about it', () => {
    const inventory = mergeLeaks([
      answered('HIBP', [leak({ classes: ['email addresses'] })]),
      answered('Cavalier', [leak({ source: 'Cavalier', classes: ['session cookies'] })]),
    ])
    expect(inventory.leaks[0]?.classes).toEqual(['email addresses', 'session cookies'])
  })

  it('treats two breaches of the same company on different dates as two', () => {
    const inventory = mergeLeaks([
      answered('HIBP', [leak({ occurredAt: '2024-03-01' }), leak({ occurredAt: '2021-06-01' })]),
    ])
    expect(inventory.leaks).toHaveLength(2)
  })

  it('ignores case and spacing in a breach name', () => {
    const inventory = mergeLeaks([
      answered('HIBP', [leak({ name: 'ExampleCorp' })]),
      answered('Cavalier', [leak({ name: '  examplecorp ' })]),
    ])
    expect(inventory.leaks).toHaveLength(1)
  })
})

describe('the order they are shown in', () => {
  it('puts the most recent first', () => {
    const inventory = mergeLeaks([
      answered('HIBP', [
        leak({ name: 'Older', occurredAt: '2019-01-01' }),
        leak({ name: 'Newer', occurredAt: '2025-01-01' }),
      ]),
    ])
    expect(inventory.leaks.map((entry) => entry.name)).toEqual(['Newer', 'Older'])
  })

  it('puts undated breaches last, because a missing date is not a recent one', () => {
    const inventory = mergeLeaks([
      answered('HIBP', [leak({ name: 'Undated', occurredAt: null }), leak({ name: 'Dated' })]),
    ])
    expect(inventory.leaks.map((entry) => entry.name)).toEqual(['Dated', 'Undated'])
  })
})
