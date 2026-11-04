import { readFileSync } from 'node:fs'
import process from 'node:process'

import { fromCatalogue, t, useResolver, type Catalogue } from '@okolos/i18n'

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

/** Where `run` writes and how it ends; the process by default, a fake in a test. */
export interface RunIo {
  /** Resolves with the error the write ended with, or `undefined` when it was written. */
  readonly write: (text: string) => Promise<NodeJS.ErrnoException | undefined>
  readonly exit: (code: number) => void
}

/**
 * A failed write to stdout is reported twice: to the write's callback, and as
 * an `error` event a tick later. With no listener for the event node exits 1,
 * which here means "signals found"; the callback is where it is handled.
 */
const ignore = (): void => undefined

const processIo: RunIo = {
  write: (text) =>
    new Promise((resolve) => {
      if (!process.stdout.listeners('error').includes(ignore)) process.stdout.on('error', ignore)
      process.stdout.write(text, (error) => resolve(error ?? undefined))
    }),
  exit: (code) => {
    process.exitCode = code
  },
}

/**
 * The command, as `index.ts` hands it over: from `bin/okolos-mail.mjs` through
 * the launcher, or from a direct start of `index.ts` through the same launcher.
 *
 * A `main` that throws is not caught here. The launcher catches it, writes one
 * line that starts with `okolos-mail:` and ends with `EXIT.unreadable`: a throw
 * left to node exits 1, which is `EXIT.signalsFound`, and a crash is neither a
 * finding nor a clean message. One place formats every failure, so the prefix
 * the launcher promises cannot be missing from one of them.
 *
 * A reader that closed the pipe (`| head -1`, `| grep -q`) does not change the
 * verdict, so EPIPE ends with the verdict's code. Any other failed write lost
 * the verdict by accident, and a caller cannot tell an empty report from a
 * clean one: it goes to the launcher like a crash.
 */
export async function run(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  io: RunIo = processIo,
  command: typeof main = main,
): Promise<void> {
  const result = command(argv, env)
  const failure = await io.write(`${result.text}\n`)
  if (failure !== undefined && failure.code !== 'EPIPE') throw failure
  io.exit(result.code)
}
