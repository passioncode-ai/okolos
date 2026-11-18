import { readFileSync, globSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * A failure's own words never go inside a sentence a reader is given.
 *
 * Two writers interpolated `String(cause)` into a message from the catalogue, so the reader
 * got a Russian line with an English exception in the middle — "Проверка страницы не
 * завершилась: Error: the background service refused …". Both texts are worth keeping: the
 * sentence is the reader's, the exception is the bug report's. They travel side by side now
 * (`diagnostic`), and the journal shows the second under the first (B-115).
 *
 * The rule is checkable because the shape is specific: a call that resolves a message —
 * `t(…)` or `explained(…)` — with a raw cause among its arguments.
 */

const root = path.resolve(import.meta.dirname, '..')

function sources(): string[] {
  return globSync(['apps/*/src/**/*.ts', 'packages/*/src/**/*.ts'], {
    cwd: root,
    exclude: (p) => p.includes('.test.') || p.includes('/dist/'),
  })
}

/** `String(cause)`, `cause.message`, `String(err)` — the raw text of a failure. */
const RAW_CAUSE = /String\(\s*(?:cause|err|error|e)\s*\)|\b(?:cause|err|error)\.message\b/

/**
 * Is the raw cause *inside* the resolving call, rather than beside it?
 *
 * The first version of this rule asked only whether both appeared on the line, and its very
 * first run flagged the line this whole change created — `explained(KEY, [])` followed by
 * `String(cause)` as the **next argument**, which is the fix rather than the defect. Depth is
 * what separates them: inside means the call's parenthesis is still open where the cause
 * begins.
 */
function insideResolvingCall(line: string): boolean {
  const call = /\b(?:t|explained)\s*\(/g
  for (const match of line.matchAll(call)) {
    let depth = 1
    let i = (match.index ?? 0) + match[0].length
    const from = i
    for (; i < line.length && depth > 0; i += 1) {
      const ch = line[i]
      if (ch === '(') depth += 1
      else if (ch === ')') depth -= 1
    }
    // `i` now sits just past the closing parenthesis, or at the end of the line.
    if (RAW_CAUSE.test(line.slice(from, depth > 0 ? line.length : i - 1))) return true
  }
  return false
}

/**
 * Nothing owed, and the list is gone with the debt.
 *
 * Eight sites predated this rule, on four surfaces — the queue's and the journal's read
 * errors, the data screen's export and wipe refusals, the trusted list, the package
 * analysis, the password-unchecked journal line, and the page failure slot. **One of them
 * this session's own work added**, two iterations before the rule existed, which is the
 * argument for a gate rather than a habit. All eight are paid (B-117): every surface now has
 * somewhere to put a diagnostic, and the map below is empty because there is nothing to
 * record — not because the walk found nothing, which the second check keeps honest.
 */
const OWED: Readonly<Record<string, number>> = {}

describe('a reader’s sentence', () => {
  it('never has a failure’s own words substituted into it, outside what B-117 still owes', () => {
    const found: Record<string, number> = {}
    for (const source of sources()) {
      const text = readFileSync(path.join(root, source), 'utf8')
      for (const line of text.split(/\r?\n/)) {
        const commented = /^\s*(?:\/\/|\*|\/\*)/.test(line)
        if (!commented && insideResolvingCall(line)) found[source] = (found[source] ?? 0) + 1
      }
    }
    expect(
      found,
      'pass it beside the sentence as a diagnostic — the reader gets their language and the bug report gets the exception. A file not in the list owes nothing; a count that moved means the ledger has to move with it',
    ).toEqual(OWED)
  })

  it('is looking at real sources, so an empty walk cannot pass', () => {
    expect(sources().length).toBeGreaterThan(50)
    // The mechanism this rule depends on: the journal entry has somewhere to put it.
    expect(readFileSync(path.join(root, 'packages/core-queue/src/diff.ts'), 'utf8')).toContain(
      'readonly diagnostic?: string',
    )
  })
})
