/**
 * A secret the product stores must be one the export refuses to hand out.
 *
 * The defect: `settings` held `reuse:key` — the HMAC key the password-reuse index
 * is tagged with — and `exportAll` dumped every store verbatim. One file carried
 * both the tags and the key that reverses them, so whoever received it could run
 * a dictionary of common passwords against the tags and recover which password is
 * used on which sites. It also carried `hibp:apiKey`, the user's own paid
 * credential, in plain text. The button that produced that file is the one the
 * privacy page offers as proof of good faith.
 *
 * `packages/storage/src/export.test.ts` proves the two known secrets do not
 * appear in the file. This gate is about the *next* one: it reads the settings
 * keys the extension actually writes, decides by the shape of the name which of
 * them look like credentials, and requires each to be declared withheld. A list
 * maintained by hand stops being maintained; a rule about shape keeps applying to
 * keys nobody has written yet.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { WITHHELD_SETTINGS } from '../packages/storage/src/schema.js'

import { filesUnder } from './tree.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Words that make a stored value a credential rather than a fact.
 *
 * Matched against the part after the colon, not the whole literal, because
 * `reuse:key` is a secret and `seen:bank.test` is not and both are settings keys.
 */
const SECRET_WORDS = /(^|[-_.])(key|token|secret|password|credential)($|[-_.])/i

/**
 * A camel hump is a word boundary, and forgetting that left a hole a plant found.
 *
 * The first version tested the raw segment, so `hibp:apiKey` matched only because
 * `apikey` happened to be in the word list as one word — and `vt:apiToken`,
 * planted to check the rule, sailed through green. `token` was in the list; the
 * pattern wanted a `-`, `_` or `.` in front of it and camelCase gives neither.
 * Splitting the humps first makes the list mean what it reads as, and `apikey`
 * could then come out of it.
 */
const withBoundaries = (segment: string): string => segment.replace(/([a-z0-9])([A-Z])/g, '$1-$2')

/**
 * The settings keys the extension writes — read from the *call sites*, not from
 * every `namespace:name` literal in the tree.
 *
 * The first version took any such literal and reported `user:password-check` as a
 * leaked credential. That is a `triggeredBy` label for the audit log, and a gate
 * that calls a log label a leaked password is a gate somebody mutes. So: literals
 * on a line that touches the settings store, plus the constants that hold a key by
 * name. Both forms are in use — `db.get('settings', REUSE_KEY_SETTING)` and
 * ``db.put('settings', { key: `seen:${host}` })`` — and missing either would blind
 * this to exactly the kind of key it exists for.
 */
function settingKeys(): Array<{ key: string; where: string }> {
  const found: Array<{ key: string; where: string }> = []

  // Was its own eight-line walk, and it skipped nothing — so it also read `dist`.
  const sources = (dir: string): string[] =>
    filesUnder(dir, '.ts').filter((file) => !file.endsWith('.test.ts'))

  for (const file of sources(path.join(root, 'apps/extension/src'))) {
    const where = path.relative(root, file)
    const text = readFileSync(file, 'utf8')

    // A constant that names a settings key, wherever it is later used. Shaped
    // `namespace:name`, which is what excludes `FEED_PUBLIC_KEY` — a base64
    // public key, matched by the name pattern and not a setting at all.
    for (const m of text.matchAll(/const\s+\w*(?:KEY|SETTING)\w*\s*=\s*'([^']+)'/g)) {
      const key = m[1] as string
      if (/^[A-Za-z][\w.-]*:[A-Za-z][\w.-]*$/.test(key)) found.push({ key, where })
    }

    for (const line of text.split(/\r?\n/)) {
      if (!line.includes("'settings'") && !line.includes('readSetting(')) continue
      // A plain literal: db.get('settings', 'popup:lastCheck')
      for (const m of line.matchAll(/'([A-Za-z][\w.-]*:[A-Za-z][\w.-]*)'/g)) {
        found.push({ key: m[1] as string, where })
      }
      // A template whose prefix is the namespace: `seen:${host}`
      for (const m of line.matchAll(/`([A-Za-z][\w.-]*:)\$\{/g)) {
        found.push({ key: `${m[1] as string}<value>`, where })
      }
    }
  }

  return found
}

describe('a stored secret is a withheld secret', () => {
  const keys = settingKeys()

  it('found settings keys to check, so an empty sweep cannot pass as a clean one', () => {
    // The failure this guards: a regex that stops matching, or a directory that
    // moved, turns this whole file into a green report about nothing. Named keys
    // rather than a count, because a count is satisfied by the wrong keys.
    expect(keys.length, 'no settings keys found at all — the sweep is broken').toBeGreaterThan(4)
    const names = keys.map((k) => k.key)
    expect(names, 'the sweep no longer sees the key this gate exists for').toContain('reuse:key')
    expect(names, 'the sweep no longer sees template-formed keys').toContain('seen:<value>')
  })

  it('declares every credential-shaped settings key as withheld from the export', () => {
    const undeclared = [
      ...new Set(
        keys
          .filter(({ key }) => SECRET_WORDS.test(withBoundaries(key.slice(key.indexOf(":") + 1))))
          .filter(({ key }) => !WITHHELD_SETTINGS.has(key))
          .map(({ key, where }) => `${key} (${where})`),
      ),
    ]

    expect(
      undeclared,
      'these settings look like credentials and the export would hand them out. ' +
        'Add them to WITHHELD_SETTINGS in packages/storage/src/schema.ts, or rename ' +
        'them if they are not secrets.',
    ).toEqual([])
  })

  it('withholds nothing it cannot find, so the set does not outlive its keys', () => {
    // The other direction. A withheld key for a setting the product no longer
    // writes reads as protection and protects nothing — and it is how a set of two
    // grows into a list nobody trusts.
    const written = new Set(keys.map((k) => k.key))
    for (const declared of WITHHELD_SETTINGS) {
      expect(
        written.has(declared),
        `WITHHELD_SETTINGS holds ${declared}, which nothing in the extension writes`,
      ).toBe(true)
    }
  })
})
