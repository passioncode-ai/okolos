/**
 * The catalogue, held to the same standard as the code that reads it.
 *
 * A missing key is not a blank space — the resolver returns `[key]`, on purpose,
 * so the defect is visible rather than silent. That is the right behaviour at
 * runtime and a terrible thing to discover in a listing, so it is checked here:
 * both locales carry the same keys, every key a renderer asks for exists, and
 * every key in the catalogue is asked for by something.
 *
 * The last of those is the one that matters most over time. A catalogue only
 * ever grows, and a message nobody reads is a translation somebody paid for and
 * a line the next person has to decide about.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { directoriesIn, filesUnder } from './tree.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const localesDir = path.join(root, 'apps/extension/_locales')

type Catalogue = Record<string, { message: string }>

/**
 * The locale directories, not the entries of `_locales`.
 *
 * Every use below joins the name with `messages.json`, so a name that is not a
 * directory is a read of a path that cannot exist. A `.DS_Store` here failed
 * five of this file's ten checks — in the gate that guards the message
 * catalogue, and therefore the gate `package:check` leans on to prove the
 * default locale answers every `__MSG__`. It was latent rather than absent:
 * `_locales` simply had not been opened in Finder yet, which is not a property
 * anyone should be relying on. `tree.mjs` carries the class and the two other
 * gates it broke.
 */
const locales = directoriesIn(localesDir)
const read = (locale: string): Catalogue =>
  JSON.parse(readFileSync(path.join(localesDir, locale, 'messages.json'), 'utf8')) as Catalogue

/**
 * Every key any source file asks the resolver for, plus the manifest's own.
 *
 * Two shapes count, and the second was added when the first stopped being
 * enough. A surface may call `t('gateBlock')` directly; it may also hold a map
 * from a domain value to a key — `SEVERITY_KEY[props.severity]` — and pass the
 * result. The second is not a workaround, it is the only way to keep the
 * mapping (which severity gets which label) in code while the wording stays in
 * `_locales`; reading only direct calls declared eleven live keys dead.
 *
 * The map form is recognised by a convention the code follows and this gate
 * enforces: it must be a `const NAME_KEY: Record<...>`. A first attempt counted
 * every identifier-shaped literal in any file importing `@okolos/i18n`, which
 * swept up `'panel'` and `'primary'` and then demanded messages for them — a
 * check that widens until it fails is not stricter, it is broken.
 */
function keysAsked(): Set<string> {
  const keys = new Set<string>()
  const walk = (dir: string): void => {
    // `filesUnder` walks and skips `node_modules` and `dist`, which this function did
    // by hand. The test-file filter stays here: it is this gate's rule, not the
    // walker's (B-58).
    for (const p of filesUnder(dir, '.ts')) {
      if (!p.endsWith('.test.ts')) {
        const text = readFileSync(p, 'utf8')
        /**
         * A quoted key as the first argument of a message-composing call.
         *
         * `t` resolves one now; `explained` builds the key-and-arguments pair a journal
         * row stores and `summarise` resolves later (B-77). Both take the key as a
         * quoted literal in the same position, and reading only `t` made three live
         * messages — `feedNowAtVersion`, `logRulesTruncated` and one more — look
         * translated-and-never-shown the moment their writers moved to `explained`.
         */
        for (const m of text.matchAll(/\b(?:t|explained)\(\s*'([a-zA-Z0-9_.]+)'/g)) {
          keys.add(m[1] as string)
        }
        for (const block of text.matchAll(/const \w+_KEY(?::[^=]*)? = \{([\s\S]*?)\n\}/g)) {
          for (const m of (block[1] as string).matchAll(/:\s*'([a-zA-Z0-9_.]+)'/g)) {
            keys.add(m[1] as string)
          }
        }
        // A `*_KEY` array as well as a `*_KEY` record. An ordered list of keys
        // is what a confirmation dialog naming five categories needs, and it is
        // exactly as explicit as the record form: the discipline that keeps a
        // dead message from staying alive is the name ending in `_KEY`, not the
        // bracket that follows it.
        for (const block of text.matchAll(/const \w+_KEY(?::[^=]*)? = \[([\s\S]*?)\n\]/g)) {
          for (const m of (block[1] as string).matchAll(/'([a-zA-Z0-9_.]+)'/g)) {
            keys.add(m[1] as string)
          }
        }
        // A key held in a field of a record — `{ messageKey: 'feedNamePhishing' }`,
        // `{ titleKey: 'leaksGroupOlderTitle', whyKey: … }`. The field name must
        // end in `Key`, so a generic `key:` somewhere else cannot keep a dead
        // message alive.
        for (const m of text.matchAll(/\b\w*Key:\s*'([a-zA-Z0-9_.]+)'/g)) keys.add(m[1] as string)
      }
    }
  }
  walk(path.join(root, 'packages'))
  walk(path.join(root, 'apps/extension/src'))
  // The mail command reads the same catalogue; a caller the gate cannot see
  // makes a live key look dead (added with the app, 2026-09-11).
  walk(path.join(root, 'apps/mail-cli/src'))

  for (const target of ['chrome', 'firefox']) {
    const manifest = readFileSync(path.join(root, `apps/extension/manifest.${target}.json`), 'utf8')
    for (const m of manifest.matchAll(/__MSG_([a-zA-Z0-9_]+)__/g)) keys.add(m[1] as string)
  }
  return keys
}

describe('the message catalogue', () => {
  it('ships more than one locale, or none of this means anything', () => {
    expect(locales.length).toBeGreaterThanOrEqual(2)
    expect(locales).toContain('ru')
  })

  it('is declared as the default the product actually ships in', () => {
    // Russian, because that is the market: the phishing feed this product
    // publishes lists Russian banks and the state services portal.
    for (const target of ['chrome', 'firefox']) {
      const manifest = JSON.parse(
        readFileSync(path.join(root, `apps/extension/manifest.${target}.json`), 'utf8'),
      ) as { default_locale?: string }
      expect(manifest.default_locale, `${target} declares no default_locale`).toBe('ru')
    }
  })

  it('carries the same keys in every locale', () => {
    const reference = new Set(Object.keys(read('ru')))
    for (const locale of locales) {
      const here = new Set(Object.keys(read(locale)))
      const missing = [...reference].filter((k) => !here.has(k))
      const extra = [...here].filter((k) => !reference.has(k))
      expect(missing, `${locale} is missing keys ru has`).toEqual([])
      expect(extra, `${locale} has keys ru does not`).toEqual([])
    }
  })

  it('leaves no message empty, which reads as a working screen with nothing on it', () => {
    for (const locale of locales) {
      for (const [key, entry] of Object.entries(read(locale))) {
        expect(entry.message.trim(), `${locale}/${key} is empty`).not.toBe('')
      }
    }
  })

  it('has a message for every key the code and the manifests ask for', () => {
    const catalogue = read('ru')
    const missing = [...keysAsked()].filter((key) => catalogue[key] === undefined).sort()
    expect(
      missing,
      `these would render as [key] on a real screen:\n  ${missing.join('\n  ')}`,
    ).toEqual([])
  })

  it('has nothing nobody asks for', () => {
    const asked = keysAsked()
    const orphans = Object.keys(read('ru'))
      .filter((key) => !asked.has(key))
      .sort()
    expect(
      orphans,
      `translated and never shown:\n  ${orphans.join('\n  ')}`,
    ).toEqual([])
  })

  it('is looking at real keys, not an empty extraction', () => {
    // Both assertions above pass vacuously if the scan breaks.
    expect(keysAsked().size).toBeGreaterThanOrEqual(8)
  })
})

describe('text a person reads carries no em dash (operator rule; B-236)', () => {
  // U+2014, written as an escape so this file is not a counter-example of its own rule.
  const DASH = '\u2014'

  it('in no message of any catalogue', () => {
    for (const locale of locales) {
      const dashed = Object.entries(read(locale))
        .filter(([, entry]) => entry.message.includes(DASH))
        .map(([key]) => key)
      expect(dashed, `${locale}: rewrite with a colon, a full stop or parentheses`).toEqual([])
    }
  })

  it('nor between the time and the line of the journal and the trusted list', () => {
    for (const file of ['packages/ui/src/journal/journal.ts', 'packages/ui/src/trusted/trusted.ts']) {
      const code = readFileSync(path.join(root, file), 'utf8')
      expect(code.includes(`} ${DASH} \${`), `${file} joins two parts of a line with an em dash`).toBe(false)
    }
  })
})

describe('the catalogue in the format the browser will actually parse', () => {
  /**
   * This is not pedantry about syntax. A catalogue Chrome cannot parse does not
   * produce a broken string — it produces **no extension**: no service worker,
   * no content script, and every end-to-end test failing at fixture setup.
   *
   * A first version of this catalogue wrote `$1` straight into the message,
   * which is not the platform's convention however reasonable it looks. Chrome
   * requires named placeholders and treats a bare `$` as an error. The cost of
   * learning that was a suite that ran for ten minutes and failed 72 times at
   * the same line.
   */
  /**
   * Take out what is legal, then look at what is left. A regex that tries to
   * spot the illegal `$` directly flags the closing one of every placeholder —
   * measured, on this very catalogue, before this was written that way.
   */
  const leftoverDollars = (message: string): string =>
    message.replace(/\$[A-Za-z0-9_]+\$/g, '').replace(/\$\$/g, '')

  it('leaves no bare $ in any message, which is what Chrome refuses', () => {
    for (const locale of locales) {
      for (const [key, entry] of Object.entries(read(locale))) {
        expect(
          leftoverDollars(entry.message).includes('$'),
          `${locale}/${key}: "${entry.message}" — a $ outside a declared placeholder`,
        ).toBe(false)
      }
    }
  })

  it('declares every placeholder its messages use', () => {
    for (const locale of locales) {
      const catalogue = JSON.parse(
        readFileSync(path.join(localesDir, locale, 'messages.json'), 'utf8'),
      ) as Record<string, { message: string; placeholders?: Record<string, { content: string }> }>

      for (const [key, entry] of Object.entries(catalogue)) {
        const used = [...entry.message.matchAll(/\$([A-Za-z0-9_]+)\$/g)].map((m) =>
          (m[1] as string).toLowerCase(),
        )
        const declared = Object.keys(entry.placeholders ?? {}).map((n) => n.toLowerCase())
        for (const name of used) {
          expect(declared, `${locale}/${key} uses $${name}$ and declares no such placeholder`).toContain(
            name,
          )
        }
        for (const name of declared) {
          expect(used, `${locale}/${key} declares ${name} and never uses it`).toContain(name)
        }
      }
    }
  })

  it('points every placeholder at a substitution slot', () => {
    for (const locale of locales) {
      const catalogue = JSON.parse(
        readFileSync(path.join(localesDir, locale, 'messages.json'), 'utf8'),
      ) as Record<string, { placeholders?: Record<string, { content: string }> }>
      for (const [key, entry] of Object.entries(catalogue)) {
        for (const [name, place] of Object.entries(entry.placeholders ?? {})) {
          expect(place.content, `${locale}/${key}.${name}`).toMatch(/^\$\d+$/)
        }
      }
    }
  })
})

describe('the naming convention this file depends on is a rule, not folklore', () => {
  /**
   * Keys are read out of tables whose name ends in `_KEY`, and out of nothing looser — so
   * that a stray `key:` somewhere cannot keep a dead message alive. The cost is that a
   * table of real keys under any other name makes its messages read as
   * translated-and-never-shown, and the author finds out only when this file refuses.
   *
   * That happened twice on 2026-08-20: `{ key: … }` instead of `{ messageKey: … }`, then
   * `INCIDENT_LABEL` instead of `INCIDENT_LABEL_KEY`. Both were caught, both cost a
   * round trip, and the second one after writing the note about the first.
   *
   * So the convention checks itself: a table whose values are *all* catalogue keys is a
   * table of catalogue keys, whatever it is called, and it has to be named accordingly.
   * A table of ordinary strings does not match — the values would have to coincide with
   * message names, all of them.
   */
  const catalogueKeys = new Set(Object.keys(read('ru')))

  /** The same tree `keysAsked` reads: packages and the extension's own source. */
  const sources = (): string[] =>
    [path.join(root, 'packages'), path.join(root, 'apps/extension/src')]
      .flatMap((dir) => filesUnder(dir, '.ts'))
      .filter((file) => !file.endsWith('.test.ts'))

  it('finds no table of keys hiding under a name this file cannot read', () => {
    const offenders: string[] = []
    for (const file of sources()) {
      const text = readFileSync(file, 'utf8')
      for (const block of text.matchAll(/const (\w+)(?::[^=]*)? = \{([\s\S]*?)\n\}/g)) {
        const name = block[1] as string
        if (name.endsWith('_KEY')) continue
        const values = [...(block[2] as string).matchAll(/:\s*'([a-zA-Z0-9_.]+)'/g)].map(
          (m) => m[1] as string,
        )
        if (values.length < 2) continue
        if (values.every((value) => catalogueKeys.has(value))) {
          offenders.push(`${path.relative(root, file)}: ${name}`)
        }
      }
    }
    expect(
      offenders,
      'a table of catalogue keys must be named `*_KEY`, or this file reads its messages as dead',
    ).toEqual([])
  })

  it('is looking at real tables, so an empty scan cannot pass', () => {
    // The check above answers "none" both when the convention holds and when the walk is
    // broken. This one separates the two.
    let tables = 0
    for (const file of sources()) {
      tables += [...readFileSync(file, 'utf8').matchAll(/const \w+_KEY(?::[^=]*)? = \{/g)].length
    }
    expect(tables, 'no `*_KEY` table was found at all — the walk is broken').toBeGreaterThan(4)
  })
})
