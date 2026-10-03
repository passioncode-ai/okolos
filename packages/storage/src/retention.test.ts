import { describe, expect, it } from 'vitest'

import {
  FEED_INTERVAL_MS,
  INVENTORY_INTERVAL_MS,
  LAST_INVENTORY_KEY,
  SWEEP_INTERVAL_MS,
  dueAgain,
  dueForFeed,
  dueForInventory,
  dueForSweep,
  pruneExpired,
} from './retention.js'
import { RETENTION_DAYS } from './schema.js'

/**
 * Retention's own tests.
 *
 * The sweep was covered through the background's alarm handler, where what is
 * asserted is that the handler runs — not what it keeps and what it drops, and
 * not when it is owed. The ninety days on the journal screen is a promise to
 * the user; this is the file that has to make it true.
 */

/** The smallest thing shaped like the database the sweep walks. */
interface Row {
  readonly id: string
  readonly createdAt?: string
  readonly resolvedAt?: string | null
}

/** A settings row is keyed by `key`, not by `id`, and the sweep deletes by that. */
interface Setting {
  readonly key: string
  readonly value?: unknown
}

function fakeDb(seed: Record<string, Array<Row | Setting>>) {
  const stores: Record<string, Array<Row | Setting>> = {
    journal: [],
    outbound_log: [],
    findings: [],
    settings: [],
    ...seed,
  }
  const idOf = (row: Row | Setting): string => ('key' in row ? row.key : row.id)
  const db = {
    getAll: async (name: string) => [...(stores[name] ?? [])],
    delete: async (name: string, id: string) => {
      stores[name] = (stores[name] ?? []).filter((row) => idOf(row) !== id)
    },
  }
  /** Reading the result is what the assertions do, so it is typed rather than cast. */
  const ids = (name: string): string[] => (stores[name] ?? []).map(idOf)
  return { db: db as never, ids }
}

describe('what the sweep drops and what it keeps', () => {
  const NOW = Date.parse('2026-08-08T00:00:00.000Z')
  const daysAgo = (days: number) => new Date(NOW - days * 24 * 60 * 60 * 1000).toISOString()

  it('drops journal entries past the window and keeps the rest', async () => {
    const { db, ids } = fakeDb({
      journal: [
        { id: 'old', createdAt: daysAgo(RETENTION_DAYS.journal + 1) },
        { id: 'fresh', createdAt: daysAgo(1) },
      ],
    })
    await pruneExpired(db, NOW)
    expect(ids('journal')).toEqual(['fresh'])
  })

  it('drops audit entries on the same window', async () => {
    const { db, ids } = fakeDb({
      outbound_log: [
        { id: 'old', createdAt: daysAgo(RETENTION_DAYS.outbound_log + 1) },
        { id: 'fresh', createdAt: daysAgo(2) },
      ],
    })
    await pruneExpired(db, NOW)
    expect(ids('outbound_log')).toEqual(['fresh'])
  })

  it('never drops an unresolved finding, however old', async () => {
    // An unresolved finding is work the user still owes themselves. Ageing it
    // out would quietly discard the only record that anything was wrong.
    const { db, ids } = fakeDb({
      findings: [{ id: 'ancient', createdAt: daysAgo(3650), resolvedAt: null }],
    })
    await pruneExpired(db, NOW)
    expect(ids('findings')).toEqual(['ancient'])
  })
})


describe('deciding whether a sweep is owed', () => {
  const NOW = Date.parse('2026-08-08T12:00:00.000Z')
  const ago = (ms: number) => new Date(NOW - ms).toISOString()

  it('is owed when nothing was ever swept', () => {
    expect(dueForSweep(null, NOW)).toBe(true)
    expect(dueForSweep(undefined, NOW)).toBe(true)
  })

  it('is not owed again immediately', () => {
    expect(dueForSweep(ago(60_000), NOW)).toBe(false)
  })

  it('is owed once the interval has passed', () => {
    expect(dueForSweep(ago(SWEEP_INTERVAL_MS + 1), NOW)).toBe(true)
  })

  it('treats an unreadable timestamp as owed, not as done', () => {
    // Skipping keeps data past the window the user was promised; sweeping
    // twice costs a few deletes.
    expect(dueForSweep('not a date', NOW)).toBe(true)
  })

  it('is owed when the stored time is in the future', () => {
    // A corrected system clock or a restored profile would otherwise postpone
    // the sweep for as long as the skew lasts.
    expect(dueForSweep(ago(-SWEEP_INTERVAL_MS), NOW)).toBe(true)
  })
})

describe('the settings store, which nothing used to sweep', () => {
  const NOW = Date.parse('2026-08-19T00:00:00.000Z')
  const daysAgo = (n: number): string =>
    new Date(NOW - n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)

  it('drops a host note past its year and keeps one inside it', async () => {
    /**
     * `seen:<host>` answers "have I met this host before" for the credential
     * guard, and had no window at all — so it grew into a permanent list of every
     * site where a password or card field was focused, timestamped to the second.
     * That is the browsing history this product declined the `history` permission
     * in order not to hold.
     */
    const { db, ids } = fakeDb({
      settings: [
        { key: 'seen:old.test', value: daysAgo(RETENTION_DAYS.seenHost + 1) },
        { key: 'seen:recent.test', value: daysAgo(RETENTION_DAYS.seenHost - 1) },
      ],
    })
    await pruneExpired(db, NOW)
    expect(ids('settings')).toEqual(['seen:recent.test'])
  })

  it('drops a host note whose date cannot be read', async () => {
    // Otherwise a corrupt row is the one thing in the database with no expiry,
    // which is the opposite of what a window means.
    const { db, ids } = fakeDb({ settings: [{ key: 'seen:broken.test', value: 'not a date' }] })
    await pruneExpired(db, NOW)
    expect(ids('settings')).toEqual([])
  })

  it('drops a deferral whose own deadline has passed, and keeps a live one', async () => {
    const { db, ids } = fakeDb({
      settings: [
        { key: 'defer:spent', value: new Date(NOW - 1000).toISOString() },
        { key: 'defer:live', value: new Date(NOW + 60_000).toISOString() },
      ],
    })
    await pruneExpired(db, NOW)
    expect(ids('settings')).toEqual(['defer:live'])
  })

  it('keeps the two settings that must outlive every window', async () => {
    // `reuse:key` cannot expire without orphaning every tag it made — the index
    // would answer "nowhere" about passwords it had already seen, which is worse
    // than answering "unknown". The HIBP credential is the user's to remove.
    const { db, ids } = fakeDb({
      settings: [
        { key: 'reuse:key', value: 'base64' },
        { key: 'hibp:apiKey', value: 'token' },
        { key: 'popup:lastCheck', value: daysAgo(999) },
        { key: 'retention:lastSweptAt', value: daysAgo(999) },
      ],
    })
    await pruneExpired(db, NOW)
    expect(ids('settings').sort()).toEqual([
      'hibp:apiKey',
      'popup:lastCheck',
      'retention:lastSweptAt',
      'reuse:key',
    ])
  })
})

describe('a record whose age cannot be read', () => {
  const NOW = Date.parse('2026-08-19T00:00:00.000Z')

  it('is swept rather than kept forever', async () => {
    /**
     * Measured before the fix: after a sweep the corrupt row was the one still
     * present and the valid old one was gone. A record whose age cannot be
     * established cannot be held under a promise about age, and `dueForSweep`
     * had already decided the same way — an unreadable timestamp is not
     * permission to skip.
     */
    const { db, ids } = fakeDb({
      journal: [
        { id: 'unreadable', createdAt: 'yesterday-ish' },
        { id: 'missing-field' },
        { id: 'fresh', createdAt: new Date(NOW - 1000).toISOString() },
      ],
    })
    await pruneExpired(db, NOW)
    expect(ids('journal')).toEqual(['fresh'])
  })
})

describe('one due-check, used by both periodic jobs', () => {
  /**
   * The retention sweep had four edge cases and the feed pull had none, so the
   * feed ran on **every worker start** — and an MV3 worker starts on nearly every
   * page, because a content script sends it a message. Instead of four requests a
   * day the product made one per page, each writing a row to `outbound_log`
   * (the audit entry is mandatory before a request leaves), so the self-audit
   * panel — the screen whose subject is what left this device — filled with
   * `feed-update`.
   *
   * Four edge cases duplicated across two callers are four that will disagree, so
   * there is one function and the two named wrappers call it.
   */
  const HOUR = 60 * 60 * 1000
  const now = Date.UTC(2026, 7, 20, 12, 0, 0)
  const ago = (ms: number) => new Date(now - ms).toISOString()

  it('owes the work when it has never been done', () => {
    expect(dueAgain(null, now, HOUR)).toBe(true)
    expect(dueAgain(undefined, now, HOUR)).toBe(true)
  })

  it('owes it when the timestamp cannot be read', () => {
    // Absence of data is not permission to skip. Doing the work twice costs a
    // little; skipping it silently costs the promise the work keeps.
    expect(dueAgain('soon', now, HOUR)).toBe(true)
    expect(dueAgain('', now, HOUR)).toBe(true)
  })

  it('owes it when the clock moved backwards', () => {
    // A corrected system time or a restored profile would otherwise postpone the
    // work indefinitely.
    expect(dueAgain(new Date(now + 5 * HOUR).toISOString(), now, HOUR)).toBe(true)
  })

  it('owes it exactly at the interval, and not before', () => {
    expect(dueAgain(ago(HOUR - 1), now, HOUR)).toBe(false)
    expect(dueAgain(ago(HOUR), now, HOUR)).toBe(true)
  })

  it('gives the feed six hours, which is the alarm’s period and REQ-13’s cadence', () => {
    expect(FEED_INTERVAL_MS).toBe(6 * HOUR)
    expect(dueForFeed(ago(5 * HOUR), now)).toBe(false)
    expect(dueForFeed(ago(6 * HOUR), now)).toBe(true)
  })

  it('leaves the sweep’s own window where it was', () => {
    // Sharing the mechanism must not have moved the other caller's number.
    expect(SWEEP_INTERVAL_MS).toBe(12 * HOUR)
    expect(dueForSweep(ago(11 * HOUR), now)).toBe(false)
    expect(dueForSweep(ago(12 * HOUR), now)).toBe(true)
  })

  it('answers the two jobs differently at the same moment, which is the point of two windows', () => {
    // Seven hours: the feed is owed, the sweep is not. A single shared interval
    // would have had to be wrong for one of them.
    expect(dueForFeed(ago(7 * HOUR), now)).toBe(true)
    expect(dueForSweep(ago(7 * HOUR), now)).toBe(false)
  })
})

describe('deciding whether the extension inventory is owed (LC-08)', () => {
  /**
   * The comment above `reviewExtensions` promised a daily review and the call sat at
   * the top of the background, so `management.getAll()` ran on every wake-up — and
   * the daily alarm that was meant to carry it was reset before it could fire.
   */
  const NOW = Date.parse('2026-10-03T12:00:00.000Z')
  const ago = (ms: number) => new Date(NOW - ms).toISOString()

  it('is a day, kept under its own key', () => {
    expect(INVENTORY_INTERVAL_MS).toBe(24 * 60 * 60 * 1000)
    expect(LAST_INVENTORY_KEY).toBe('inventory:lastReviewedAt')
  })

  it('is owed when it never ran, and not again an hour later', () => {
    expect(dueForInventory(null, NOW)).toBe(true)
    expect(dueForInventory(ago(60 * 60 * 1000), NOW)).toBe(false)
  })

  it('is owed once a day has passed', () => {
    expect(dueForInventory(ago(INVENTORY_INTERVAL_MS), NOW)).toBe(true)
  })
})
