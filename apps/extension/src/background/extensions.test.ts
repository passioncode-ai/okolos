import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { closeDb, openDb } from '@okolos/storage'
import type { ExtensionSnapshot } from '@okolos/core-extensions'

import {
  acceptInventoryChange,
  compareInventory,
  journalChanges,
  type InventoryDeps,
} from './extensions.js'

const NOW = '2026-08-05T12:00:00.000Z'

/**
 * The inventory, with reading and deciding kept apart.
 *
 * Every test below the first two exists because a single function did both. It
 * compared and then recorded the new state as the baseline, and three callers ran
 * it: the daily alarm, the extensions screen, and the area counter on the
 * overview. The counter and the screen share one handler, so the first of them
 * consumed the difference — measured 2026-08-20, the counter said there were
 * changes and the screen, opened immediately after, said there were none.
 *
 * The fixture carries **non-empty host permissions**, which the old one did not:
 * both sides of every comparison were `hostPermissions: []`, so the defect that
 * reported every extension as having just widened its access, `critical`, on
 * every run, could not be seen from here.
 */
function ext(overrides: Partial<ExtensionSnapshot> = {}): ExtensionSnapshot {
  return {
    id: 'abc',
    name: 'Colour Picker',
    version: '1.0.0',
    permissions: ['storage'],
    hostPermissions: ['https://example.test/*'],
    publisher: 'Someone',
    enabled: true,
    ...overrides,
  }
}

async function deps(list: ExtensionSnapshot[]): Promise<InventoryDeps> {
  return { db: await openDb(), list: async () => list, now: () => NOW, selfId: 'self' }
}

const compare = async (list: ExtensionSnapshot[]) => compareInventory(await deps(list))

beforeEach(() => {
  indexedDB.deleteDatabase('okolos')
  closeDb()
})

describe('the first run', () => {
  it('records what is installed without calling any of it a change', async () => {
    // Reporting every installed extension as new would bury the one that
    // matters under the twenty that do not.
    expect(await compare([ext(), ext({ id: 'def' })])).toEqual([])
    expect(await (await openDb()).getAll('snapshots')).toHaveLength(2)
  })

  /**
   * Two first comparisons at once, which is what a fresh profile does.
   *
   * The worker's start-up review and the extensions screen both reach this function, and
   * on a fresh profile both may find the store empty. The baseline used to be written one
   * extension at a time, so a reader arriving while it was half written diffed the full
   * list against a partial baseline and reported every extension not yet stored. CI saw a
   * fresh profile with a change on it once (B-168, run 36563089100).
   */
  it('reports nothing to a second first comparison that reads while the first writes', async () => {
    const list = [ext(), ext({ id: 'def', name: 'Tab Saver' }), ext({ id: 'ghi', name: 'Reader' })]
    const db = await openDb()
    const reader: InventoryDeps = { db, list: async () => list, now: () => NOW, selfId: 'self' }
    let second: Promise<unknown> | null = null
    // The second reader starts the moment the first one begins to write, whichever way it
    // writes: one row at a time, or one transaction for the lot.
    const startSecond = () => {
      second ??= compareInventory(reader)
    }
    const writer: InventoryDeps = {
      ...reader,
      db: new Proxy(db, {
        get(target, key) {
          const value = Reflect.get(target, key) as unknown
          if (typeof value !== 'function') return value
          if (key === 'put' || key === 'transaction') {
            return (...args: unknown[]) => {
              const result = (value as (...a: unknown[]) => unknown).apply(target, args)
              startSecond()
              return result
            }
          }
          return (value as (...a: unknown[]) => unknown).bind(target)
        },
      }),
    }

    expect(await compareInventory(writer)).toEqual([])
    expect(second, 'the race was never provoked: the first comparison wrote nothing').not.toBeNull()
    expect(await second).toEqual([])
    expect(await db.getAll('snapshots')).toHaveLength(3)
  })

  it('records everything the comparison will need, not a subset of it', async () => {
    // Host permissions and the name were not stored at all. The first absence
    // produced a false `critical` on every run; the second made a removal read
    // "jhkfbmnopqrs is no longer installed" about a thing the user chose by name.
    await compare([ext()])
    const [row] = await (await openDb()).getAll('snapshots')
    expect(row).toMatchObject({
      extensionId: 'abc',
      name: 'Colour Picker',
      hostPermissions: ['https://example.test/*'],
      enabled: true,
    })
  })
})

describe('what a comparison reports', () => {
  it('reports a permission that appeared', async () => {
    await compare([ext()])
    expect((await compare([ext({ permissions: ['storage', 'cookies'] })]))[0]).toMatchObject({
      kind: 'permission-added',
    })
  })

  it('reports a change of publisher', async () => {
    await compare([ext()])
    expect((await compare([ext({ publisher: 'New Owner' })]))[0]).toMatchObject({
      kind: 'publisher-changed',
    })
  })

  it('reports host access that actually widened', async () => {
    await compare([ext()])
    const changes = await compare([ext({ hostPermissions: ['https://example.test/*', '<all_urls>'] })])
    expect(changes[0]).toMatchObject({ kind: 'host-access-widened', severity: 'critical' })
  })

  it('says nothing about host access that did not widen', async () => {
    // The case the old fixture could not express, because both sides were empty.
    await compare([ext()])
    expect(await compare([ext()])).toEqual([])
  })

  it('leaves this extension out of its own report', async () => {
    await compare([ext()])
    const changes = await compare([ext(), ext({ id: 'self', permissions: ['storage', 'tabs'] })])
    expect(changes.every((change) => change.id !== 'self')).toBe(true)
  })

  it('names a removed extension by its name, not by its id', async () => {
    await compare([ext()])
    // The name travels; the sentence it goes into belongs to the surface (B-75), and
    // `packages/ui/src/extensions/words.test.ts` holds that end.
    expect((await compare([]))[0]).toMatchObject({ kind: 'removed', name: 'Colour Picker' })
  })
})

describe('reading does not consume what it reports', () => {
  it('says the same thing every time it is asked', async () => {
    /**
     * The defect this whole split exists for. Two callers, one handler: the area
     * counter on the overview and the extensions screen. Whichever ran first used
     * to record the new state, so the other one found nothing — a screen that
     * contradicted the number that sent the user to it.
     */
    await compare([ext()])
    const changed = [ext({ publisher: 'New Owner' })]
    expect((await compare(changed))[0]).toMatchObject({ kind: 'publisher-changed' })
    expect((await compare(changed))[0]).toMatchObject({ kind: 'publisher-changed' })
    expect((await compare(changed))[0]).toMatchObject({ kind: 'publisher-changed' })
  })

  it('writes no snapshot at all once a baseline exists', async () => {
    await compare([ext()])
    const before = await (await openDb()).getAll('snapshots')
    await compare([ext({ publisher: 'New Owner', version: '2.0.0' })])
    expect(await (await openDb()).getAll('snapshots')).toEqual(before)
  })
})

describe('accepting a change is what moves the baseline', () => {
  it('stops reporting the change the user accepted', async () => {
    await compare([ext()])
    const changed = [ext({ publisher: 'New Owner' })]
    expect(await compare(changed)).toHaveLength(1)

    await acceptInventoryChange(await deps(changed), 'abc')
    expect(await compare(changed)).toEqual([])
  })

  it('accepts one extension without accepting the others', async () => {
    await compare([ext(), ext({ id: 'def', name: 'Other' })])
    const changed = [ext({ publisher: 'New Owner' }), ext({ id: 'def', name: 'Other', publisher: 'Also New' })]
    await acceptInventoryChange(await deps(changed), 'abc')

    const left = await compare(changed)
    expect(left).toHaveLength(1)
    expect(left[0]?.id).toBe('def')
  })

  it('forgets an extension that is gone, so the removal is reported once', async () => {
    // `db.delete('snapshots')` appeared nowhere in the repository, so "no longer
    // installed" was reported on every run for the rest of the profile's life.
    await compare([ext()])
    expect(await compare([])).toHaveLength(1)

    await acceptInventoryChange(await deps([]), 'abc')
    expect(await compare([])).toEqual([])
    expect(await (await openDb()).getAll('snapshots')).toEqual([])
  })
})

describe('a snapshot written before the fields existed', () => {
  it('does not read a missing host list as an empty one', async () => {
    /**
     * The measured false alarm: `hostPermissions` was not stored, `before` was
     * built with `[]`, so every extension holding host permissions looked as
     * though it had just been granted them — severity `critical`, on every run,
     * for the life of the profile. An absence is not a value to compare against.
     */
    const db = await openDb()
    await db.put('snapshots', {
      extensionId: 'abc',
      takenAt: NOW,
      version: '1.0.0',
      permissions: ['storage'],
      publisher: 'Someone',
      // No `hostPermissions`, no `name` — a row from before they were stored.
    })

    expect(await compare([ext()])).toEqual([])
  })

  it('still reports the things such a row does record', async () => {
    // Silence about the unknown field must not become silence about the rest.
    const db = await openDb()
    await db.put('snapshots', {
      extensionId: 'abc',
      takenAt: NOW,
      version: '1.0.0',
      permissions: ['storage'],
      publisher: 'Someone',
    })

    expect((await compare([ext({ publisher: 'New Owner' })]))[0]).toMatchObject({
      kind: 'publisher-changed',
    })
  })
})

describe('the journal', () => {
  it('writes what it found', async () => {
    const d = await deps([ext({ publisher: 'New Owner' })])
    await compare([ext()])
    await journalChanges(d, await compareInventory(d))
    const journal = await (await openDb()).getAll('journal')
    expect(journal.some((entry) => String(entry.detail?.kind) === 'publisher-changed')).toBe(true)
  })

  it('writes one row for a change however many times it is seen', async () => {
    /**
     * The id carried the timestamp, so the daily alarm wrote a row a day for the
     * same unaccepted change and the screen wrote one per visit. One permission
     * change became as many journal rows as the user had visits — in a store the
     * user reads to find out what happened.
     */
    const d = await deps([ext({ publisher: 'New Owner' })])
    await compare([ext()])
    for (let i = 0; i < 5; i += 1) await journalChanges(d, await compareInventory(d))

    const rows = (await (await openDb()).getAll('journal')).filter(
      (entry) => String(entry.detail?.kind) === 'publisher-changed',
    )
    expect(rows).toHaveLength(1)
  })

  it('refreshes the row when the same kind of change says something new', async () => {
    await compare([ext()])
    const first = await deps([ext({ permissions: ['storage', 'cookies'] })])
    await journalChanges(first, await compareInventory(first))
    const second = await deps([ext({ permissions: ['storage', 'cookies', 'history'] })])
    await journalChanges(second, await compareInventory(second))

    const rows = (await (await openDb()).getAll('journal')).filter(
      (entry) => String(entry.detail?.kind) === 'permission-added',
    )
    expect(rows).toHaveLength(1)
    /**
     * The refresh is what this is about: one row per extension and kind, rewritten when
     * what changed changed. It is compared on `explainArgs` rather than on a sentence —
     * a sentence would be rewritten by a change of language alone, pushing `createdAt`
     * to today and making an old change claim it had just happened.
     */
    expect(String(rows[0]?.detail?.explainArgs)).toContain('history')
    expect(rows[0]?.detail?.explainKey).toBe('extensionsChangePermission')
  })
})
