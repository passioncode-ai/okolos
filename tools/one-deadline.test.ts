import { readFileSync, globSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { toPosix } from './tree.mjs'

/**
 * One implementation of "reject if this never settles".
 *
 * It existed twice — `packages/platform/src/adapter.ts` for a message to a service worker
 * that may never answer, and `apps/extension/src/background/leaks.ts` for a source that may
 * never reply — and the copies had already drifted in how they tested the timer handle.
 *
 * This is the third pair of copies swept in one session: the instant formatters
 * (`tools/instants.test.ts`), the severity table (`tools/severity-words.test.ts`), and this.
 * The pattern is the same every time — the second caller needs the same fifteen lines, and
 * writing them is faster than finding them — and the cost is not the duplication but what
 * happens next: one copy gets a fix and the other does not. Here the copies decide
 * **behaviour under failure**, which is the worst place in a security product for two
 * answers to live.
 */

const root = path.resolve(import.meta.dirname, '..')
const HOME = 'packages/platform/src/adapter.ts'

function sources(): string[] {
  // fs.globSync answers in the platform's spelling; HOME is the repository's (B-164).
  return globSync(['apps/*/src/**/*.ts', 'packages/*/src/**/*.ts'], {
    cwd: root,
    exclude: (p) => p.includes('.test.') || toPosix(p).includes('/dist/'),
  }).map((p) => toPosix(p))
}

describe('the deadline wrapper', () => {
  it('is declared in one place', () => {
    const offenders: string[] = []
    for (const source of sources()) {
      if (source === HOME) continue
      const text = readFileSync(path.join(root, source), 'utf8')
      // A declaration, not a call: `withDeadline(...)` is what every caller should write.
      if (/(?:function|const)\s+withDeadline\b/.test(text)) offenders.push(source)
    }
    expect(
      offenders,
      `import withDeadline from @okolos/platform — two copies of a failure path drift, and the drift shows up as one caller behaving differently under load`,
    ).toEqual([])
  })

  it('is used by more than one caller, so the sharing is real', () => {
    const callers = sources().filter(
      (source) =>
        source !== HOME && /\bwithDeadline\s*\(/.test(readFileSync(path.join(root, source), 'utf8')),
    )
    expect(callers.length, 'nobody outside the home module calls it').toBeGreaterThan(0)
  })

  it('is looking at real sources, so an empty walk cannot pass', () => {
    expect(sources().length).toBeGreaterThan(50)
    expect(readFileSync(path.join(root, HOME), 'utf8')).toContain('export async function withDeadline')
  })
})
