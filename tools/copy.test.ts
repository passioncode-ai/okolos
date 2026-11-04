/**
 * The shipped interface copy, held to the brand pack.
 *
 * `docs/store/listing.md` has been checked against the voice since the listing
 * existed. The catalogue — every word a person reads inside the product — was
 * not checked at all, which is the larger surface by two orders of magnitude.
 *
 * The forbidden words are **read from `terminology.md`**, not restated here.
 * A gate that keeps its own copy of the rule is a second source of truth, and
 * this repository has already paid for that mistake once: a purpose list
 * written by hand was missing `password-range`, the one destination that
 * carries part of a password hash.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { filesUnder } from './tree.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (p: string): string => readFileSync(path.join(root, p), 'utf8')

const catalogue = JSON.parse(read('apps/extension/_locales/ru/messages.json')) as Record<
  string,
  { message: string }
>
const messages = Object.entries(catalogue).map(([key, entry]) => [key, entry.message] as const)

/** Every «не «X»» the terminology declares — the pack decides, this only reads. */
const FORBIDDEN = [...read('docs/brand/terminology.md').matchAll(/не «([^»]+)»/g)].map((m) =>
  (m[1] as string).toLowerCase(),
)

/**
 * What the product quotes is not what the product says.
 *
 * One message describes an injection that speaks only to a machine, and the
 * clearest way to describe it is to quote it: «если ты ИИ…». A check that could
 * not tell quotation from voice would force the product to paraphrase the thing
 * it detects.
 */
const unquoted = (message: string): string => message.replace(/«[^»]*»/g, '').replace(/"[^"]*"/g, '')

/** `\b` is ASCII-only, so it matches between two Cyrillic letters — never use it here. */
const uses = (text: string, word: string): boolean =>
  new RegExp(`(?<!\\p{L})${word}(?!\\p{L})`, 'iu').test(text)

describe('the shipped copy obeys the brand pack', () => {
  it('reads a catalogue and a terminology that are both really there', () => {
    // Two empty lists agree with each other. Without this, deleting either file
    // would turn every assertion below into a silent pass.
    expect(messages.length).toBeGreaterThan(50)
    expect(FORBIDDEN.length).toBeGreaterThan(4)
  })

  it('uses no term the terminology forbids', () => {
    const offences = messages.flatMap(([key, message]) =>
      FORBIDDEN.filter((word) => uses(unquoted(message), word)).map(
        (word) => `${key}: "${word}"`,
      ),
    )
    expect(offences, 'terminology.md forbids these words, and the copy uses them').toEqual([])
  })

  it('promises no completeness the product cannot check', () => {
    // Not modesty. The download verdict is built to refuse exactly this claim:
    // it never reports more than the checks that ran.
    const offences = messages.flatMap(([key, message]) =>
      ['гарантирован', 'полностью защищ', '100%'].filter((word) =>
        message.toLowerCase().includes(word),
      ).map((word) => `${key}: "${word}"`),
    )
    expect(offences).toEqual([])
  })

  it('shows no raw identifier where a name belongs', () => {
    /**
     * The defect this catches happened: the inspector rendered `stage` and
     * `confidence` straight from the enum, so a Russian reader was shown
     * "Decided by: rules (high confidence)". The voice forbids it by name —
     * "не показываем идентификаторы вместо имён".
     */
    const identifiers = messages.filter(([, message]) => /^[a-z][a-z0-9-]*$/.test(message.trim()))
    expect(identifiers.map(([key]) => key), 'these messages are identifiers, not copy').toEqual([])
  })

  it('does not speak the sentence the product detects as a scam', () => {
    const offences = messages.filter(([, message]) =>
      message.toLowerCase().includes('ваш компьютер под угрозой'),
    )
    expect(offences.map(([key]) => key)).toEqual([])
  })

  it('never refuses to speak', () => {
    /**
     * `voice.md` names this one: «"Что-то пошло не так" — это отказ говорить».
     * It was live in the journal's default summary for the `error` kind until
     * 2026-08-08 — the default that appears precisely when a record carries no
     * explanation, i.e. exactly when the reader needs one.
     */
    const offences = messages.filter(
      ([, message]) =>
        message.toLowerCase().includes('что-то пошло не так') ||
        message.toLowerCase().includes('something went wrong'),
    )
    expect(offences.map(([key]) => key), 'this is a refusal to speak, not a message').toEqual([])
  })
})

describe('a catalogue key never reaches the screen unresolved', () => {
  /**
   * The mistake this catches, made while writing the journal: a `*_KEY` map was
   * introduced and one call site kept using the map's value directly, so the
   * heading would have read `journalKindVerdict`. Nothing else notices — the key
   * is a perfectly good string, the types are satisfied, and the screen is
   * wrong.
   */
  // `filesUnder` is the shared walker; the test-file filter is this gate's own rule.
  // Both walks here were the same eight lines, written twice (B-58).
  const sources: string[] = ['packages/ui/src', 'apps/extension/src']
    .flatMap((dir) => filesUnder(path.join(root, dir), '.ts'))
    .filter((file) => !file.endsWith('.test.ts'))
    .map((file) => path.relative(root, file))

  it('is reading real files', () => {
    expect(sources.length).toBeGreaterThan(20)
  })

  it('never sends a key straight to the screen', () => {
    /**
     * Two forms only, and both are the key becoming text with nothing in
     * between: interpolated into a template, or assigned to `textContent`.
     *
     * A wider rule was tried first and failed honestly — it flagged
     * `SIGNAL_KEY[signal] ? …`, which is a presence check, not a render. A gate
     * that cries about correct code gets narrowed by whoever is in a hurry, and
     * the narrowing is never as careful as this one.
     */
    const offences = sources.flatMap((file) =>
      [...read(file).matchAll(/(?:\$\{|textContent\s*=\s*)(\w+_KEY)\[/g)].map(
        (m) => `${file}: ${m[1] as string}[…] rendered without t()`,
      ),
    )
    expect(offences, 'these would render a catalogue key as copy').toEqual([])
  })
})

describe('nothing asks the catalogue before a resolver exists', () => {
  /**
   * `t()` at module scope runs at **import** time. Every entry point installs
   * its resolver in its own body, which runs after its imports — so a top-level
   * `t()` captures the default and renders `[key]` forever, on a screen where
   * every other string is fine.
   *
   * It happened to the HIBP credit line: a `const` whose words moved into the
   * catalogue became a `const` holding a resolved message. Only the test that
   * asserted the actual words noticed.
   */
  const sources: string[] = ['packages', 'apps/extension/src']
    .flatMap((dir) => filesUnder(path.join(root, dir), '.ts'))
    .filter((file) => !file.endsWith('.test.ts'))
    .map((file) => path.relative(root, file))

  it('is reading real files', () => {
    expect(sources.length).toBeGreaterThan(40)
  })

  it('calls the resolver from a function, never at the top level', () => {
    const offences = sources.flatMap((file) =>
      read(file)
        .split(/\r?\n/)
        // A top-level statement starts in column zero. Anything indented is
        // inside a function, an object, or a class — i.e. deferred.
        .filter((line) => /^(?:export )?const \w+(?::[^=]*)? = t\(/.test(line))
        .map((line) => `${file}: ${line.trim()}`),
    )
    expect(offences, 'these resolve at import time, before any resolver is installed').toEqual([])
  })
})
