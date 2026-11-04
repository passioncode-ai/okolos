import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { closeDb, openDb } from '@okolos/storage'

import { recordTrap } from './trap-journal.js'

/**
 * One "What changed" row per trap warning, and none lost to another in the same tick.
 *
 * The row id was `trap:<kind>:<ISO millisecond>` in a store keyed by id, so two links a
 * script clicked in one loop wrote the same id and the second row replaced the first
 * (round 2 of the B-165 certification).
 */

const NOW = '2026-10-27T12:00:00.000Z'
const journal = async () => (await openDb()).getAll('journal')

beforeEach(() => {
  indexedDB.deleteDatabase('okolos')
  closeDb()
})

describe('a page trap in the journal', () => {
  it('keeps two warnings written in the same millisecond as two rows', async () => {
    const deps = { db: await openDb(), now: () => NOW }
    await recordTrap(deps, { kind: 'outside-link', signals: 'search-ms,opens-a-program' })
    await recordTrap(deps, { kind: 'outside-link', signals: 'ms-msdt,opens-a-program' })

    const rows = await journal()
    expect(rows).toHaveLength(2)
    expect(new Set(rows.map((row) => row.id)).size).toBe(2)
    expect(rows.map((row) => (row.detail as { signals: string }).signals).sort()).toEqual([
      'ms-msdt,opens-a-program',
      'search-ms,opens-a-program',
    ])
  })

  it('records the message key for the kind, and the generic one for a kind it cannot name', async () => {
    const deps = { db: await openDb(), now: () => NOW }
    await recordTrap(deps, { kind: 'outside-link', signals: 'x' })
    await recordTrap(deps, { kind: 'something-new', signals: 'y' })

    const keys = (await journal()).map((row) => (row.detail as { explainKey: string }).explainKey).sort()
    expect(keys).toEqual(['logTrapGeneric', 'logTrapOutsideLink'])
    for (const row of await journal()) {
      expect(row).toMatchObject({ createdAt: NOW, kind: 'verdict' })
    }
  })
})
