import { readFileSync, globSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * A spec waiting for one of this product's in-page surfaces goes through `e2e/surfaces.ts`.
 *
 * Between a navigation and a banner there are five links — the extension loaded, the worker
 * booted, the content script ran, it produced a verdict, the RPC came back — and
 * `expect(locator).toHaveCount(1)` distinguishes none of them: it reports
 * *"74 × locator resolved to 0 elements"*. `expectSurface` runs the same assertion with
 * the same budget and, on failure, prints which link broke.
 *
 * The helper existed and ten files used it. Eight hand-rolled the assertion beside it, and
 * the cost is measured: the class has failed on CI three times for a banner that never
 * arrived (B-65 twice, B-108 once), each time from a file that had no report — and the last
 * one cost a downloaded trace and an hour of hypotheses to reach a fact the helper prints
 * in one line. One of those files could not have called the helper at all: it matches the
 * host by attribute, because the host takes an unpredictable name when a page claims the
 * canonical one, and the helper took no selector until 2026-08-21.
 *
 * So: a helper the sibling case cannot call gets hand-rolled beside it, and a helper
 * nothing enforces gets hand-rolled anyway.
 */

const root = path.resolve(import.meta.dirname, '..')

/** The product's own surfaces, by every name a spec can match them under. */
const SURFACE = /okolos-(?:banner|gate|comparison)|data-okolos/

function specs(): string[] {
  return globSync('e2e/*.spec.ts', { cwd: root })
}

describe('waiting for a surface', () => {
  it('goes through the helper that reports, in every spec', () => {
    const offenders: string[] = []
    for (const spec of specs()) {
      const text = readFileSync(path.join(root, spec), 'utf8')
      for (const [index, line] of text.split(/\r?\n/).entries()) {
        // The hand-rolled shape: a count assertion naming one of this product's surfaces.
        // A `waitFor`, a `poll` or an assertion about *absence* is a different question and
        // is left alone — this rule is about the wait that hangs. Written as one positive
        // condition rather than two guard-and-return lines, which `test-quality.test.ts`
        // refuses in a test file and is right to: that shape is indistinguishable from an
        // assertion skipping itself.
        if (/toHaveCount\(1/.test(line) && SURFACE.test(line)) offenders.push(`${spec}:${index + 1}`)
      }
    }
    expect(
      offenders,
      'use expectSurface(page, selector, context) from e2e/surfaces.ts — a bare count assertion reports "0 elements" and nothing about which link broke',
    ).toEqual([])
  })

  it('is looking at real specs, so an empty walk cannot pass', () => {
    expect(specs().length).toBeGreaterThan(20)
    const helper = readFileSync(path.join(root, 'e2e/surfaces.ts'), 'utf8')
    expect(helper).toContain('export async function expectSurface')
    // The helper itself holds the one assertion this rule permits.
    expect(helper).toContain('toHaveCount(1')
  })
})
