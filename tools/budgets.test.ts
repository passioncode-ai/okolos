import { globSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

// Relative paths, not package names: `tools/` is not a workspace member, so vitest
// cannot resolve `@okolos/platform` from here (the same reason `docs.test.ts` reaches
// for `../packages/net/src/destinations.js`). The file is what matters anyway.
import { SURFACE_MOUNT_MS, WORKER_REGISTER_MS } from '../e2e/budgets.js'
import { RPC_TIMEOUT_MS } from '../packages/platform/src/adapter.js'

/**
 * Three waits in three files, and their order is the whole point.
 *
 * They were inverted and nothing said so. `SURFACE_MOUNT_MS` was 20 s while the
 * extension's own `RPC_TIMEOUT_MS` is 30 s, so a test abandoned the wait ten seconds
 * before the product would have called the call failed — and Playwright's per-test
 * timeout was 30 s, the same number as the product's deadline, so it killed the test
 * at the instant either side might have said something. The observable result was
 * "44 × locator resolved to 0 elements" and two nights of guessing (B-73, and the
 * SURFACE_MOUNT_MS incident before it).
 *
 * Asserted rather than commented, because three numbers in three files drift into an
 * inversion the moment one is tuned alone — and the inversion is invisible: every
 * test still passes, right up to the one run where the worker is slow.
 */

const root = path.resolve(import.meta.dirname, '..')

/** The per-test timeout, read from the config rather than restated here. */
function playwrightTimeout(): number {
  const config = readFileSync(path.join(root, 'playwright.config.ts'), 'utf8')
  const found = /^\s*timeout:\s*([\d_]+),/m.exec(config)
  if (found === null) throw new Error('playwright.config.ts declares no timeout')
  return Number((found[1] as string).replaceAll('_', ''))
}

describe('the waits an e2e test can stack', () => {
  it('lets the product reach its own deadline before the test stops watching', () => {
    // Otherwise a slow answer and a broken product are the same observation, and
    // the message names neither.
    expect(SURFACE_MOUNT_MS).toBeGreaterThan(RPC_TIMEOUT_MS)
  })

  it('leaves room after that deadline for the give-up to become observable', () => {
    /**
     * The margin is not spare waiting — waiting longer cannot produce a banner once the
     * RPC deadline has fired. It is the room for the fail-open path to run: catch,
     * `performance.mark('okolos:scan-failed')`, journal. The diagnosis reads that mark
     * and the failure then names itself instead of looking like a broken relay (B-78).
     *
     * A second is generous for three statements and one message; the assertion exists so
     * that tuning `RPC_TIMEOUT_MS` up to `SURFACE_MOUNT_MS` — which satisfies the check
     * above — cannot silently take the room away.
     */
    expect(SURFACE_MOUNT_MS - RPC_TIMEOUT_MS).toBeGreaterThanOrEqual(1000)
  })

  it('gives a single test room for both of its waits', () => {
    /**
     * A test waits for the worker to register and then for the surface to mount.
     * When the outer timeout is smaller than that sum, the failure is Playwright's
     * — "Test timeout of N exceeded" — and the two budgets, each with a sentence
     * ready to explain itself, never get to print it.
     */
    expect(playwrightTimeout()).toBeGreaterThan(WORKER_REGISTER_MS + SURFACE_MOUNT_MS)
  })

  it('reads the config rather than restating it', () => {
    // A number copied into this file would agree with itself forever.
    expect(playwrightTimeout()).toBe(75_000)
    const config = readFileSync(path.join(root, 'playwright.config.ts'), 'utf8')
    expect(config).toContain('75_000')
  })

  it('keeps every wait under the ceiling a person will sit through', () => {
    // The other direction matters too: budgets exist so a slow runner cannot fail a
    // CSS test, not so a hung suite can hang for a quarter of an hour.
    for (const [name, ms] of Object.entries({ SURFACE_MOUNT_MS, WORKER_REGISTER_MS })) {
      expect(ms, `${name} is longer than two minutes`).toBeLessThan(120_000)
    }
    expect(playwrightTimeout()).toBeLessThan(300_000)
  })
})

/**
 * A wait in a browser spec carries a name, or it carries its reason.
 *
 * `e2e/budgets.ts` exists because ten seconds was written into thirteen spec files and
 * measured nowhere; it produced failures on CI that had nothing to do with what the tests
 * were about. The conversion happened — and **the siblings were missed**: fourteen literal
 * waits were still there on 2026-08-20, one of them at ten seconds in `budget.spec.ts`,
 * which is the check that reddened CI that evening, and one of them in the very helper
 * written that afternoon to fix a different flake.
 *
 * That is the class appearing a third time, so it becomes a check rather than a third
 * edit. What it protects is a reader's ability to tell a busy machine from a broken
 * fixture: a named budget says which of the two ran out, and a literal says nothing.
 *
 * **Short waits stay allowed, and must say why.** A wait that asserts a *failure* — a
 * control that cannot be clicked — has to be short, or the suite pays for a truth it
 * already knows. Those are listed here by file and reason rather than pattern-matched,
 * because "this number is deliberate" is a claim somebody has to make out loud.
 */
describe('a wait in a browser spec is named', () => {
  /** Deliberate short waits: file, and why the number must stay small. */
  const DELIBERATE: Readonly<Record<string, string>> = {
    'scn-008.spec.ts':
      'asserts that a click does NOT reach a control behind a blocking banner — the wait is the assertion, and a long one would only slow the suite down to learn the same thing',
  }

  function specs(): string[] {
    return globSync('e2e/*.spec.ts', { cwd: root }).map((p) => path.join(root, p))
  }

  it('is looking at the specs it claims to check', () => {
    expect(specs().length).toBeGreaterThan(20)
  })

  it('has no literal timeout outside the ones declared deliberate', () => {
    const literals: string[] = []
    for (const file of specs()) {
      const name = path.basename(file)
      for (const [i, line] of readFileSync(file, 'utf8').split(/\r?\n/).entries()) {
        const code = line.trim()
        if (code.startsWith('//') || code.startsWith('*')) continue
        if (!/\btimeout:\s*\d/.test(code)) continue
        if (DELIBERATE[name] !== undefined) continue
        literals.push(`${name}:${i + 1}: ${code.slice(0, 60)}`)
      }
    }
    expect(literals, 'name the budget in e2e/budgets.ts, or declare the wait deliberate').toEqual(
      [],
    )
  })

  it('declares nothing deliberate that has no literal left to justify', () => {
    // An exemption outliving its case is how a list stops describing the tree.
    const stale = Object.keys(DELIBERATE).filter((name) => {
      const file = specs().find((f) => path.basename(f) === name)
      return file === undefined || !/\btimeout:\s*\d/.test(readFileSync(file, 'utf8'))
    })
    expect(stale, 'these exemptions no longer describe anything').toEqual([])
  })
})

