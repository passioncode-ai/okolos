/**
 * The wipe confirmation must name every kind of data the wipe clears.
 *
 * REQ-32 asks for a confirmation that names what is about to go, because "are you
 * sure?" tells the reader nothing they did not already know. It named five kinds
 * while `wipeAll` cleared nine stores: `models`, `feeds`, `snapshots` and `reuse`
 * went unmentioned, the last of them the index derived from the user's password
 * that `docs/privacy.md` gives its own section to. The user agreed to five and nine
 * went — safe in direction, and still a confirmation that did not ask.
 *
 * It lived through review because the list was written twice. The renderer held
 * five keys and the renderer's own test held the same five, so the two agreed with
 * each other and neither agreed with the schema. Two copies of a wrong list read as
 * confirmation, which is why this file compares against `STORES` and against the
 * shipped catalogues instead — three artefacts that cannot all be edited by
 * accident.
 *
 * This lives in `tools/` and not beside either side, because it is the only place
 * entitled to see both: `packages/ui` does not depend on `@okolos/storage`, and
 * giving it that dependency to satisfy a test would open the production import too.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { DATA_KIND_KEY, STORES } from '../packages/storage/src/schema.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const catalogue = (locale: string): Record<string, { message: string }> =>
  JSON.parse(
    readFileSync(path.join(root, `apps/extension/_locales/${locale}/messages.json`), 'utf8'),
  ) as Record<string, { message: string }>

describe('the wipe names everything the wipe clears', () => {
  it('has one kind per store, and no kind for a store that does not exist', () => {
    // `Record<StoreName, string>` already fails `tsc` on a missing store, and this
    // says the same thing where a test run can see it — the two directions are
    // both here because the type only guards one of them at the moment it is
    // written, and a store *removed* from `STORES` leaves a key behind silently.
    expect(Object.keys(DATA_KIND_KEY).sort()).toEqual([...STORES].sort())
  })

  it('names each kind in both shipped catalogues', () => {
    // A key with no message renders as `[dataKindReuse]` in the dialog that is
    // supposed to be the honest one.
    for (const locale of ['ru', 'en']) {
      const messages = catalogue(locale)
      for (const [store, key] of Object.entries(DATA_KIND_KEY)) {
        expect(messages[key], `${locale} has no message for ${key} (store ${store})`).toBeDefined()
        expect(messages[key]?.message.trim(), `${locale}: ${key} is empty`).not.toBe('')
      }
    }
  })

  it('is passed whole to the renderer, not a subset written at the call site', () => {
    /**
     * The renderer takes the list as an argument, which fixes who owns
     * completeness and moves the way to get it wrong to one line. So that line is
     * read: it must hand over `DATA_KIND_KEY` itself rather than an array literal
     * that happens to look right today.
     */
    const options = readFileSync(path.join(root, 'apps/extension/src/options/index.ts'), 'utf8')
    const call = /renderDataControls\(([\s\S]*?)\n {2}\)/.exec(options)
    expect(call, 'renderDataControls is no longer called from the options page').not.toBeNull()
    expect(
      call?.[1],
      'the call passes something other than the whole DATA_KIND_KEY — a subset here is ' +
        'exactly the defect this file exists for, and the type cannot see it',
    ).toContain('Object.values(DATA_KIND_KEY)')
  })

  it('gives every kind a retention line on the privacy page', () => {
    /**
     * The wipe dialog and the privacy page are the two places the user is told
     * what the product holds, and they now say it in the same nine words — so a
     * store that gains a name in one and not the other is a gap this can see.
     *
     * The page had four lines where the database had nine stores, and the sweep
     * touched three. `settings` was swept by nothing, which is how the "have I met
     * this host" note became a permanent second-precision list of every site where
     * a password field was focused — a browsing history, in a product that declined
     * the `history` permission in order not to have one.
     *
     * A line is required, not a window. Four stores legitimately have no expiry;
     * what they must not have is silence, because a store with neither a window nor
     * a stated reason is the one nobody notices.
     */
    const privacy = readFileSync(path.join(root, 'docs/privacy.md'), 'utf8')
    const table = /## Что хранится на устройстве и сколько([\s\S]*?)\n## /.exec(privacy)?.[1]
    expect(table, 'the privacy page has no retention section to check').toBeDefined()

    const messages = catalogue('ru')
    for (const [store, key] of Object.entries(DATA_KIND_KEY)) {
      const words = messages[key]?.message
      expect(words, `ru has no message for ${key}`).toBeDefined()
      expect(
        table,
        `the retention table says nothing about ${store} ("${words ?? ''}"). A store with ` +
          `neither a window nor a stated reason is the one nobody notices.`,
      ).toContain(words as string)
    }
  })

  it('describes a kind rather than repeating a store name', () => {
    // The point of the mapping is that the dialog speaks the user's language. A
    // message equal to its store name means someone wired the key through and
    // never wrote the words.
    const messages = catalogue('ru')
    for (const [store, key] of Object.entries(DATA_KIND_KEY)) {
      expect(messages[key]?.message.toLowerCase(), `${key} just repeats the store name`).not.toBe(
        store,
      )
    }
  })
})

/**
 * A retention window that nothing enforces is a promise, not a window.
 *
 * `RETENTION_DAYS` is a published table: the privacy page reads from the same numbers, and
 * a gate above already requires every store to have a line there. What nothing checked is
 * the other half — that each window has code sweeping to it. `pruneExpired` is written by
 * hand, one block per case, so a key added to the table and forgotten in the sweep would be
 * a number a person reads and a product that keeps the data anyway.
 *
 * Measured 2026-08-20: all four keys were enforced, and five of the nine stores were swept by
 * nothing. Since 2026-11-18 (B-134) the password-reuse index ages out a row a year after its
 * last submission, and the snapshot of an extension gone for ninety days is deleted; three
 * stores stay unswept, each for a reason the privacy page states (a blocklist and a model
 * cache replaced wholesale, and the user's own exceptions which a window would silently
 * revoke). So the
 * check is on the table, not on the store list: a store with no window is a decision that
 * the privacy-page gate already reads, while a window with no sweep is nobody's decision.
 */
describe('every retention window has something enforcing it', () => {
  it('reads the table and the sweep, and finds both', () => {
    const schema = readFileSync(path.join(root, 'packages/storage/src/schema.ts'), 'utf8')
    const sweep = readFileSync(path.join(root, 'packages/storage/src/retention.ts'), 'utf8')
    expect(schema).toContain('RETENTION_DAYS')
    expect(sweep).toContain('RETENTION_DAYS')
  })

  it('sweeps to every window the table declares', () => {
    const schema = readFileSync(path.join(root, 'packages/storage/src/schema.ts'), 'utf8')
    const sweep = readFileSync(path.join(root, 'packages/storage/src/retention.ts'), 'utf8')
    const table = /export const RETENTION_DAYS = \{([\s\S]*?)\n\} as const/.exec(schema)?.[1]
    expect(table, 'schema.ts no longer declares RETENTION_DAYS as one block').toBeDefined()

    const windows = [...(table ?? '').matchAll(/^\s*([A-Za-z_]+):\s*\d+/gm)].map((m) => m[1])
    expect(windows.length, 'no windows found — the extraction broke').toBeGreaterThan(2)

    const unenforced = windows.filter((key) => !sweep.includes(`RETENTION_DAYS.${key}`))
    expect(unenforced, 'these windows are published and swept by nothing').toEqual([])
  })
})

