#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs'
import process from 'node:process'

import { fromCatalogue, t, useResolver, type Catalogue } from '@okolos/i18n'

import { isEntry } from './entry.js'
import { EXIT, scan } from './scan.js'

/**
 * The command, and the three ways it can end.
 *
 * One catalogue for the whole product, read from the extension's `_locales`:
 * a second catalogue beside the first is a second place for a term to drift,
 * and `docs/brand/terminology.md` exists precisely so one concept has one word
 * on each language. The locale is taken from the environment because a command
 * line has no host to ask.
 */
function catalogue(locale: string): Catalogue {
  const url = new URL(`../../extension/_locales/${locale}/messages.json`, import.meta.url)
  return JSON.parse(readFileSync(url, 'utf8')) as Catalogue
}

/**
 * The default is the product's, not the shell's.
 *
 * The first version read `LC_ALL`/`LANG`, and on this machine that printed an
 * English verdict while the extension — `default_locale: ru` — speaks Russian:
 * two surfaces of one product disagreeing about its language, found by running
 * the command rather than by reading the diff. The shell says what the terminal
 * is set to; it does not say what this product speaks. `OKOLOS_LOCALE` is the
 * deliberate override, and `DEFAULT_LOCALE` is held equal to the manifest's by
 * a test so the two cannot drift.
 */
export const DEFAULT_LOCALE = 'ru'

export function localeFromEnv(env: NodeJS.ProcessEnv): 'ru' | 'en' {
  const raw = env.OKOLOS_LOCALE ?? DEFAULT_LOCALE
  return raw.toLowerCase().startsWith('en') ? 'en' : DEFAULT_LOCALE
}

export function main(argv: readonly string[], env: NodeJS.ProcessEnv): ScriptResult {
  // Installed rather than threaded: every entry point in this product does it
  // this way, and `tools/entry-resolver.test.ts` refuses an entry that reaches
  // `t()` without one — because the fallback for a missing resolver renders
  // every label as `[key]`, which is a screen of identifiers rather than words.
  const resolver = fromCatalogue(catalogue(localeFromEnv(env)))
  useResolver(resolver)
  const [command, target] = argv

  if (command !== 'scan' || target === undefined) {
    return { text: t('mailUsage'), code: EXIT.unreadable }
  }

  let source: string
  try {
    source = readFileSync(target, 'utf8')
  } catch (cause) {
    // The reason belongs to the reader, and the exception's own words are not
    // put inside our sentence (B-117): the file is simply not readable, and
    // that is a refusal rather than a clean verdict.
    void cause
    return { text: t('mailUnreadable', t('mailParseUnreadableFile')), code: EXIT.unreadable }
  }

  // Colour only when a person is looking. A pipe, a log and a CI transcript get
  // the same words with no escape codes, because the words carry the meaning.
  return scan(source, resolver, { colour: process.stdout.isTTY === true })
}

export interface ScriptResult {
  readonly text: string
  readonly code: number
}

/* c8 ignore start -- the entry point; `main` is what the tests drive. */
if (isEntry(import.meta.url, process.argv[1], { platform: process.platform, realpath: realpathSync, cwd: process.cwd })) {
  const result = main(process.argv.slice(2), process.env)
  process.stdout.write(`${result.text}\n`)
  process.exitCode = result.code
}
/* c8 ignore stop */
