import { describe, expect, it } from 'vitest'
import { WITHHELD_MARKER } from '@okolos/storage'

import { EXPORT_WORDS } from './export-words.js'

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fromCatalogue, useResolver, type Catalogue } from '@okolos/i18n'

/**
 * The words inside the file the user downloads.
 *
 * `exportAll` wrote them in English until 2026-08-20 (B-75), from a package with no
 * catalogue. Asserted against the *shipped* Russian catalogue: this is the one artefact
 * the product hands a person to keep, and `[exportWithheldNote]` in a downloaded file is
 * a defect nobody would ever report — they would read it as the file being broken.
 */
const CATALOGUE = JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, '../../_locales/ru/messages.json'), 'utf8'),
) as Catalogue

useResolver(fromCatalogue(CATALOGUE))

const message = (key: string): string => {
  const entry = CATALOGUE[key]
  if (!entry) throw new Error(`the shipped catalogue has no key "${key}"`)
  return entry.message
}

describe('the note that says what the file does not contain', () => {
  it('states plainly that nothing was withheld, when nothing was', () => {
    // Otherwise the note becomes decoration: present on every file, therefore read on
    // none. It has to be a sentence, not an empty string.
    expect(EXPORT_WORDS.note([])).toBe(message('exportNothingWithheld'))
  })

  it('names every path it was given, and says why they are missing', () => {
    const note = EXPORT_WORDS.note([
      { path: 'settings/reuse:key' },
      { path: 'settings/hibp:apiKey' },
      { path: 'models/bytes', bytes: 20971520 },
    ])

    expect(note).toContain('settings/reuse:key')
    expect(note).toContain('settings/hibp:apiKey')
    expect(note).toContain('models/bytes')
    // The "why" is the whole point of the note: a list of paths tells the reader what is
    // absent and leaves them to guess whether we are hiding something from them.
    expect(note).toMatch(/восстановить|защища/)
    expect(note).not.toMatch(/\$[A-Z]+\$/)
  })

  it('says different things for a withheld secret and for a named size', () => {
    /**
     * Two kinds of omission, and conflating them would be the dishonest version: a key
     * is withheld *because exporting it would undo the rest*, while model weights are
     * named by size because they are a download rather than anything learned about the
     * user. One sentence for both would make the second look like a secret.
     */
    const secret = EXPORT_WORDS.marker({ path: 'settings/reuse:key' })
    const sized = EXPORT_WORDS.marker({ path: 'models/bytes', bytes: 20971520 })

    expect(secret).not.toBe(sized)
    expect(secret).toBe(`${WITHHELD_MARKER} ${message('exportWithheldSecret')}`)
    expect(sized).toContain('20971520')
  })

  it('keeps the marker token in front of both, so the file is searchable', () => {
    // A reader who does not speak the interface language still has to be able to answer
    // "is anything withheld from this file" — and so does a test.
    expect(EXPORT_WORDS.marker({ path: 'settings/reuse:key' })).toContain(WITHHELD_MARKER)
    expect(EXPORT_WORDS.marker({ path: 'models/bytes', bytes: 1 })).toContain(WITHHELD_MARKER)
  })

  it('leaves no placeholder unresolved in anything it writes', () => {
    const written = [
      EXPORT_WORDS.note([]),
      EXPORT_WORDS.note([{ path: 'settings/reuse:key' }]),
      EXPORT_WORDS.marker({ path: 'settings/reuse:key' }),
      EXPORT_WORDS.marker({ path: 'models/bytes', bytes: 7 }),
    ]
    for (const text of written) {
      expect(text).not.toMatch(/\$[A-Z]+\$/)
      expect(text).not.toMatch(/^\[export/)
    }
  })
})

/**
 * B-125 round 2: once a Have I Been Pwned key could be saved, the file marked it with the
 * reuse key's reason ("this value makes the rest reversible"), which is false for it. Each
 * withheld path now carries its own reason, and the note gives only the reasons that apply.
 */
describe('each withheld value carries its own reason', () => {
  const OWN = { path: 'settings/hibp:apiKey' }
  const REUSE = { path: 'settings/reuse:key' }
  const BYTES = { path: 'models/bytes', bytes: 7 }

  it('marks the person\'s own key as theirs, not as a key to the rest', () => {
    expect(EXPORT_WORDS.marker(OWN)).toBe(`${WITHHELD_MARKER} ${message('exportWithheldOwnKey')}`)
    expect(EXPORT_WORDS.marker(OWN)).not.toContain(message('exportWithheldSecret'))
    expect(EXPORT_WORDS.marker(REUSE)).toBe(`${WITHHELD_MARKER} ${message('exportWithheldSecret')}`)
  })

  it('gives in the note only the reasons for what this file left out', () => {
    const own = EXPORT_WORDS.note([OWN])
    expect(own).toContain(message('exportWhyOwnKey'))
    expect(own).not.toContain(message('exportWhyReuseKey'))
    expect(own).not.toContain(message('exportWhyBytes'))

    const reuse = EXPORT_WORDS.note([REUSE])
    expect(reuse).toContain(message('exportWhyReuseKey'))
    expect(reuse).not.toContain(message('exportWhyOwnKey'))

    const all = EXPORT_WORDS.note([REUSE, OWN, BYTES])
    for (const key of ['exportWhyReuseKey', 'exportWhyOwnKey', 'exportWhyBytes']) {
      expect(all).toContain(message(key))
    }
    expect(all).not.toMatch(/\$[A-Z]+\$/)
  })
})
