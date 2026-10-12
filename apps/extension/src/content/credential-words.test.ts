import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { explained, fromCatalogue, useResolver, type Catalogue } from '@okolos/i18n'
import type { CredentialWarning } from '@okolos/core-credential'
import type { FrameLine } from '@okolos/contracts'

import { credentialDetail, credentialLines, credentialSentence } from './credential-words.js'

const CATALOGUE = JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, '../../_locales/ru/messages.json'), 'utf8'),
) as Catalogue

useResolver(fromCatalogue(CATALOGUE))

/**
 * The claim the contract makes about itself, checked rather than asserted in prose.
 *
 * `FrameLine` in `@okolos/contracts` is declared to be structurally `Explained` from
 * `@okolos/i18n`, because that package has no dependencies and must not grow one for a
 * shape three fields wide. Two declarations of one shape drift silently — unless one is
 * assigned to the other somewhere a typechecker looks. This is that place: a required
 * field added to `Explained` fails `pnpm typecheck` here, on this line.
 */
const COMPATIBLE: FrameLine = explained('credFactFirstDay', [])

function warning(over: Partial<CredentialWarning> = {}): CredentialWarning {
  return { severity: 'major', facts: [], missing: [], ...over }
}

describe('the lines a frame hands upward', () => {
  it('is the same shape the journal uses for a deferred sentence', () => {
    expect(COMPATIBLE.explainKey).toBe('credFactFirstDay')
    expect(COMPATIBLE.explainArgs).toEqual([])
    expect(COMPATIBLE.explainArgKeys).toEqual([])
  })

  it('carries data as data, so a host is never translated', () => {
    const [line] = credentialLines(
      warning({ facts: [{ code: 'imitates', resembles: 'paypal.com' }] }),
    )
    expect(line?.explainArgs).toEqual(['paypal.com'])
    expect(line?.explainArgKeys).toEqual([null])
    expect(credentialSentence(line as FrameLine)).toContain('paypal.com')
  })

  /**
   * An unresolvable code is bracketed rather than dropped. A fact silently lost is a
   * warning that under-states itself, which is the one direction this product must not
   * fail in.
   */
  it('shows an unknown code as itself', () => {
    const lines = credentialLines(
      warning({
        // A code the union does not contain, which is the point: the guard can grow a
        // fact before this module learns its word, and the double cast is the honest
        // way to reach that state from a typed test.
        facts: [{ code: 'weather-is-bad' } as unknown as CredentialWarning['facts'][number]],
      }),
    )
    expect(credentialDetail(lines)).toBe('[weather-is-bad]')
  })

  it('names what is not known, once, at the end', () => {
    const lines = credentialLines(
      warning({
        facts: [{ code: 'not-encrypted' }],
        missing: [{ code: 'how-long-visited' }, { code: 'when-registered' }],
      }),
    )
    expect(lines).toHaveLength(2)
    const detail = credentialDetail(lines)
    expect(detail).toContain(CATALOGUE['credUnknownHowLong']?.message)
    expect(detail).toContain(CATALOGUE['credUnknownWhenRegistered']?.message)
    // One sentence for both, joined — not one "неизвестно" per unknown.
    expect(detail.match(/Неизвестно/g)).toHaveLength(1)
  })

  it('produces nothing to say when there is nothing known and nothing missing', () => {
    expect(credentialDetail(credentialLines(warning()))).toBe('')
  })
})
