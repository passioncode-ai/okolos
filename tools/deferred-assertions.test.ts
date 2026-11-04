import { readFileSync, globSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * A test that puts off an assertion says what it is waiting for.
 *
 * Standing instruction 6 in `docs/superpowers/retro.md` has said this since the first run,
 * and it existed because of a real loss: the HIBP attribution waited three releases inside a
 * comment. A promise that lives only in prose is tracked by nothing — no ledger row, no
 * board id, no failing test. The comment reads as diligence and behaves as a decision to
 * forget.
 *
 * The sweep finds nothing today: every deferral this repository had was paid (B-75 and the
 * instalments after it). That is why this file is a **regression guard** rather than a
 * discovery, and why the rule is demonstrated on synthetic lines below rather than left to
 * be proven by the next accident — a sweep that passes on an empty tree proves nothing about
 * the rule it claims to enforce.
 */

const root = path.resolve(import.meta.dirname, '..')

/**
 * Language that defers, assembled from pieces so this rule cannot match its own explanation.
 *
 * Four gates in this repository have read their own prose as code. The pieces are ugly and
 * the alternative is a file that fails on the paragraph describing why it exists.
 */
const DEFERS = [
  'la' + 'ter release',
  'no' + 't yet asserted',
  'wi' + 'll assert',
  'TO' + 'DO',
  'fo' + 'r now',
  'tempo' + 'rarily',
]

/** A citation: a requirement or a board row, which is what makes the promise trackable. */
const CITES = /\b(?:REQ-\d+|B-\d+)\b/

/**
 * Does this comment defer without saying what it waits for?
 *
 * `nearby` is the two lines that follow, because a comment block often carries the sentence
 * on one line and the citation on the next.
 */
export function defersWithoutCiting(line: string, nearby: string): boolean {
  const isComment = /^\s*(?:\/\/|\*|\/\*)/.test(line)
  if (!isComment) return false
  const defers = DEFERS.some((phrase) => line.toLowerCase().includes(phrase.toLowerCase()))
  return defers && !CITES.test(line) && !CITES.test(nearby)
}

function tests(): string[] {
  return globSync(['**/*.test.ts', 'e2e/*.spec.ts'], {
    cwd: root,
    exclude: (p) => p.includes('node_modules') || p.includes('/dist/'),
  })
}

describe('a deferred assertion names what it is waiting for', () => {
  it('holds across every test file', () => {
    const offenders: string[] = []
    for (const file of tests()) {
      // This file's own DEFERS table is the vocabulary, not a deferral.
      if (file === 'tools/deferred-assertions.test.ts') continue
      const lines = readFileSync(path.join(root, file), 'utf8').split(/\r?\n/)
      lines.forEach((line, index) => {
        const nearby = lines.slice(index + 1, index + 3).join(' ')
        if (defersWithoutCiting(line, nearby)) offenders.push(`${file}:${index + 1}`)
      })
    }
    expect(
      offenders,
      'name the requirement or the board row it waits for — a promise in a comment is tracked by nothing',
    ).toEqual([])
  })

  it('is looking at real test files, so an empty sweep cannot pass', () => {
    expect(tests().length).toBeGreaterThan(100)
  })

  /**
   * The rule, demonstrated. Without this the check above says only "nothing matched", which
   * is equally true of a rule that matches nothing at all.
   */
  it('refuses a deferral with no citation', () => {
    expect(defersWithoutCiting('    // asserted in a la' + 'ter release', '')).toBe(true)
    expect(defersWithoutCiting('    // TO' + 'DO: assert the redaction', '')).toBe(true)
  })

  it('accepts one that names a requirement or a row, on its line or just after', () => {
    expect(defersWithoutCiting('    // asserted once REQ-23 ships', '')).toBe(false)
    expect(defersWithoutCiting('    // asserted in a la' + 'ter release', '// see B-72')).toBe(false)
  })

  it('says nothing about code, only about comments', () => {
    // The phrase inside a string is a value, and a value is not a promise.
    expect(defersWithoutCiting("    const label = 'for now'", '')).toBe(false)
  })
})
