import { describe, expect, it } from 'vitest'

import { capped, MARK_CAP, type Timeline } from './marks.js'

function fakeTimeline() {
  const entries: string[] = []
  const timeline: Timeline = {
    getEntriesByName: ((name: string) => entries.filter((e) => e === name).map((n) => ({ name: n }))) as never,
    clearMarks: (name?: string) => {
      for (let i = entries.length - 1; i >= 0; i -= 1) if (entries[i] === name) entries.splice(i, 1)
    },
    clearMeasures: () => undefined,
  }
  return { timeline, entries, write: (name: string) => () => void entries.push(name) }
}

describe('an entry that accumulates, kept under a cap (B-190)', () => {
  it('climbs to the cap, so a reader counting rescans sees them', () => {
    const { timeline, entries, write } = fakeTimeline()
    for (let i = 0; i < MARK_CAP; i += 1) capped(timeline, 'okolos:collect', write('okolos:collect'))
    expect(entries).toHaveLength(MARK_CAP)
  })

  it('starts again from one past the cap, instead of growing all day', () => {
    const { timeline, entries, write } = fakeTimeline()
    for (let i = 0; i < MARK_CAP * 3 + 5; i += 1) capped(timeline, 'okolos:collect', write('okolos:collect'))
    expect(entries.length).toBeLessThanOrEqual(MARK_CAP)
    expect(entries.length).toBeGreaterThan(0)
  })

  it('leaves other names alone', () => {
    const { timeline, entries, write } = fakeTimeline()
    entries.push('okolos:scan')
    for (let i = 0; i < MARK_CAP + 1; i += 1) capped(timeline, 'okolos:collect', write('okolos:collect'))
    expect(entries.filter((e) => e === 'okolos:scan')).toHaveLength(1)
  })

  it('never throws, when a page has taken the API away', () => {
    const broken = {
      getEntriesByName: () => {
        throw new Error('replaced by the page')
      },
      clearMarks: () => undefined,
      clearMeasures: () => undefined,
    } as unknown as Timeline
    expect(() => capped(broken, 'okolos:collect', () => undefined)).not.toThrow()
  })
})
