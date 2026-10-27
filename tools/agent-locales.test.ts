import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The Okolos Agent page reads apps/agent/_locales in two languages. A key in one catalogue only,
 * or a placeholder one language declares and the other does not, shows the person `[key]` or a
 * raw `$NAME$` in that language. tools/locales.test.ts holds the extension's catalogues; this
 * holds the daemon's.
 *
 * What it does NOT catch: a translation that says something else. That is copylot_check's and
 * the reviewer's job (spec §9).
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

type Catalogue = Record<string, { message: string; placeholders?: Record<string, { content: string }> }>

const read = (lang: string): Catalogue =>
  JSON.parse(readFileSync(path.join(root, 'apps/agent/_locales', lang, 'messages.json'), 'utf8')) as Catalogue

export function mismatches(a: Catalogue, b: Catalogue): string[] {
  const out: string[] = []
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[key]
    const y = b[key]
    if (x === undefined || y === undefined) {
      out.push(`${key}: in one catalogue only`)
      continue
    }
    for (const [lang, entry] of [['ru', x], ['en', y]] as const) {
      const used = [...entry.message.matchAll(/\$([A-Z]+)\$/g)].map((m) => m[1]!.toLowerCase()).sort()
      const declared = Object.keys(entry.placeholders ?? {}).sort()
      if (JSON.stringify([...new Set(used)]) !== JSON.stringify(declared)) out.push(`${key} (${lang}): placeholders ${used} vs ${declared}`)
    }
    if (JSON.stringify(x.placeholders ?? {}) !== JSON.stringify(y.placeholders ?? {})) out.push(`${key}: placeholders differ between languages`)
  }
  return out
}

describe('the Okolos Agent catalogues say the same keys in both languages', () => {
  const ru = read('ru')
  const en = read('en')

  it('reads both catalogues, so an empty pair cannot pass', () => {
    expect(Object.keys(ru).length).toBeGreaterThan(50)
  })

  it('has the same keys and placeholders in ru and en', () => {
    expect(mismatches(ru, en)).toEqual([])
  })

  it('would notice a key missing in one language and an undeclared placeholder', () => {
    const a: Catalogue = { one: { message: 'Агент $NAME$', placeholders: { name: { content: '$1' } } }, two: { message: 'x' } }
    const b: Catalogue = { one: { message: 'Agent $NAME$' } }
    expect(mismatches(a, b)).toEqual([
      'one (en): placeholders name vs ',
      'one: placeholders differ between languages',
      'two: in one catalogue only',
    ])
  })
})
