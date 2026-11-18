import { expect, test } from './fixtures.js'
import { RECORD_VISIBLE_MS } from './budgets.js'

/**
 * SCN-023 — wiping every local store, from the settings screen, for real.
 *
 * REQ-32 named `e2e SCN-023` as the gate that closes it, and **the file did not
 * exist**: the requirement had been reported closed on unit tests plus a
 * scenario whose own Coverage line said "no end-to-end run yet, since asserting a
 * real wipe needs a profile seeded with data first". Seeding it is what this file
 * does, by the same route `e2e/scn-024.spec.ts` already uses.
 *
 * What only a browser can say here: that the button in the shipped options page
 * reaches `wipeAll` over the real database, that every store the confirmation
 * names is actually emptied, and that cancelling leaves all of it alone. The
 * failure paths — a database that will not open, a partial wipe — are unit tests,
 * because nothing in a browser makes IndexedDB refuse on request.
 */

/** Every store the schema declares, so a new one cannot be quietly left out. */
const STORES = [
  'findings',
  'journal',
  'outbound_log',
  'exceptions',
  'settings',
  'models',
  'feeds',
  'snapshots',
  'reuse',
] as const

async function seedEverything(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(async () => {
    const open = indexedDB.open('okolos')
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      open.onsuccess = () => resolve(open.result)
      open.onerror = () => reject(open.error)
      open.onupgradeneeded = () => undefined
    })
    const at = '2026-08-20T00:00:00.000Z'
    const rows: Record<string, unknown> = {
      findings: { id: 'f1', createdAt: at, subject: 'page:https://e.test/a', resolvedAt: null, verdict: {} },
      journal: { id: 'j1', createdAt: at, kind: 'verdict', detail: { explain: 'seeded' } },
      outbound_log: { id: 'o1', createdAt: at, purpose: 'feed', host: 'e.test' },
      exceptions: { scope: 'domain', ref: 'seeded.test', createdAt: at },
      settings: { key: 'seeded', value: 'yes' },
      // `models` is keyed by `key`, not by `id` — the seeding failed loudly on
      // that, which is the right way for a fixture to be wrong.
      models: { key: 'm1', id: 'm1', bytes: new ArrayBuffer(4), savedAt: at },
      feeds: { name: 'seeded', version: '1', updatedAt: at, entries: [] },
      snapshots: { extensionId: 'x1', takenAt: at, version: '1', permissions: [] },
      reuse: { host: 'seeded.test', tag: 't1', seenAt: at },
    }
    const names = [...db.objectStoreNames].filter((name) => name in rows)
    const tx = db.transaction(names, 'readwrite')
    for (const name of names) tx.objectStore(name).put(rows[name])
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
    db.close()
  })
}

async function counts(page: import('@playwright/test').Page): Promise<Record<string, number>> {
  return page.evaluate(async () => {
    const open = indexedDB.open('okolos')
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      open.onsuccess = () => resolve(open.result)
      open.onerror = () => reject(open.error)
    })
    const out: Record<string, number> = {}
    for (const name of [...db.objectStoreNames]) {
      const store = db.transaction(name, 'readonly').objectStore(name)
      out[name] = await new Promise<number>((resolve, reject) => {
        const request = store.count()
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
    }
    db.close()
    return out
  })
}

test('the confirmation names every kind of data, and the wipe empties every store', async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage()
  await page.goto(`chrome-extension://${extensionId}/options.html#data`)
  await expect(page.locator('[data-role=data-controls]')).toHaveCount(1)

  await seedEverything(page)
  const before = await counts(page)
  const seeded = Object.entries(before).filter(([, n]) => n > 0).map(([name]) => name)
  // The seeding has to have worked, or an empty database would pass this test by
  // being empty already — absence of data reading as a pass.
  expect(seeded.sort(), `nothing was seeded, so a wipe would prove nothing`).toEqual(
    [...STORES].sort(),
  )

  await page.locator('[data-role=wipe]').click()
  const listed = await page.locator('[data-role=confirm] li').allTextContents()
  expect(listed.length, 'one line per store the wipe clears').toBe(STORES.length)
  expect(
    listed.every((line) => line.trim().length > 0),
    'a confirmation naming nothing reads as "nothing will be deleted"',
  ).toBe(true)

  await page.locator('[data-role=confirm-yes]').click()

  await expect
    .poll(async () => Object.values(await counts(page)).reduce((a, b) => a + b, 0), {
      timeout: RECORD_VISIBLE_MS,
    })
    .toBe(0)

  // And no failure was reported, because none happened.
  await expect(page.locator('[data-role=wipe-failed]')).toHaveCount(0)
})

test('cancelling the confirmation leaves every store exactly as it was', async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage()
  await page.goto(`chrome-extension://${extensionId}/options.html#data`)
  await expect(page.locator('[data-role=data-controls]')).toHaveCount(1)

  await seedEverything(page)
  const before = await counts(page)

  await page.locator('[data-role=wipe]').click()
  await expect(page.locator('[data-role=confirm]')).toHaveCount(1)
  await page.locator('[data-role=confirm-no]').click()
  await expect(page.locator('[data-role=confirm]')).toHaveCount(0)

  // No wait before the count, and none is owed: the dialog's "No" only removes the dialog
  // (`confirm.remove()` in packages/ui/src/settings/data-controls.ts), synchronously, and the
  // wipe is reachable only from "Yes". The dialog gone is the handler done (B-189).
  expect(await counts(page)).toEqual(before)
})

test('the first click asks rather than deletes', async ({ context, extensionId }) => {
  // The destructive action behind a confirmation is the whole of REQ-32, and the
  // one thing worth checking twice.
  const page = await context.newPage()
  await page.goto(`chrome-extension://${extensionId}/options.html#data`)
  await seedEverything(page)
  const before = await counts(page)

  await page.locator('[data-role=wipe]').click()
  // The confirmation on screen is the click handled: `askFirst` builds it synchronously and
  // starts nothing else, so the stores are read after the only work the click does (B-189).
  await expect(page.locator('[data-role=confirm]')).toHaveCount(1)
  expect(await counts(page)).toEqual(before)
})
