import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { exportAll, openDb, STORES } from '@okolos/storage'

import { EXPORT_WORDS } from './export-words.js'
import { HIBP_KEY_SETTING, hasLeakKey, removeLeakKey, saveLeakKey } from './leak-key.js'

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fromCatalogue, useResolver, type Catalogue } from '@okolos/i18n'

useResolver(
  fromCatalogue(
    JSON.parse(
      readFileSync(path.resolve(import.meta.dirname, '../../_locales/ru/messages.json'), 'utf8'),
    ) as Catalogue,
  ),
)

/** Obviously fake: no real credential belongs in a repository, a test one included. */
const FAKE_KEY = 'fake-hibp-key-for-tests-0000'

async function everythingStored(): Promise<string> {
  const db = await openDb()
  const dump: Record<string, unknown> = {}
  for (const store of STORES) dump[store] = await db.getAll(store)
  return JSON.stringify(dump)
}

describe('the Have I Been Pwned key, as the settings screen stores it (B-125)', () => {
  it('is stored under the key the background reads', async () => {
    // The background reads this literal; the two used to be one reader and no writer.
    const background = readFileSync(
      path.resolve(import.meta.dirname, '../background/index.ts'),
      'utf8',
    )
    expect(background).toContain(`readSetting('${HIBP_KEY_SETTING}')`)
  })

  it('is absent until saved, present after, and absent again once removed', async () => {
    const db = await openDb()
    await removeLeakKey(db)
    expect(await hasLeakKey(db)).toBe(false)

    await saveLeakKey(db, FAKE_KEY)
    expect(await hasLeakKey(db)).toBe(true)
    expect((await db.get('settings', HIBP_KEY_SETTING))?.value).toBe(FAKE_KEY)

    await removeLeakKey(db)
    expect(await hasLeakKey(db)).toBe(false)
    expect(await everythingStored()).not.toContain(FAKE_KEY)
  })

  it('replaces the saved key rather than keeping two', async () => {
    const db = await openDb()
    await saveLeakKey(db, FAKE_KEY)
    await saveLeakKey(db, 'fake-replacement-key-0001')
    const stored = await everythingStored()
    expect(stored).not.toContain(FAKE_KEY)
    expect(stored).toContain('fake-replacement-key-0001')
    await removeLeakKey(db)
  })

  it('lives in one place only: not in the journal, and not in the export', async () => {
    const db = await openDb()
    await saveLeakKey(db, FAKE_KEY)

    expect(JSON.stringify(await db.getAll('journal'))).not.toContain(FAKE_KEY)
    expect(JSON.stringify(await db.getAll('outbound_log'))).not.toContain(FAKE_KEY)
    const file = await exportAll(db, EXPORT_WORDS)
    expect(file).not.toContain(FAKE_KEY)
    expect(file).toContain(`settings/${HIBP_KEY_SETTING}`)
    // And with the reason that is true of this key: it is the person's own, not a key to
    // the rest of the file.
    expect(file).toContain(JSON.stringify(EXPORT_WORDS.marker({ path: `settings/${HIBP_KEY_SETTING}` })))
    await removeLeakKey(db)
  })
})

describe('erasing everything says the saved key goes too (B-125 round 2)', () => {
  it('names the key in the confirmation, in every language', async () => {
    const { DATA_KIND_KEY } = await import('@okolos/storage')
    for (const locale of ['ru', 'en']) {
      const catalogue = JSON.parse(
        readFileSync(
          path.resolve(import.meta.dirname, `../../_locales/${locale}/messages.json`),
          'utf8',
        ),
      ) as Record<string, { message: string }>
      expect(catalogue[DATA_KIND_KEY.settings]?.message, locale).toContain('Have I Been Pwned')
    }
  })
})
