import { readFileSync, globSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * An e2e spec does not wait a fixed time before asserting that something is absent.
 *
 * Eleven sites did (B-169): two seconds, three, one and a half, then
 * `expect(...).toHaveCount(0)`. On a loaded machine the wait runs out before the check it
 * stands in for, and the absence assertion passes on a check that has not run: green
 * exactly when it should be red, which is the one failure a test cannot report. Each of
 * them now waits for the product's own word that its check settled (`expectSettled` and
 * `expectPageSettled` in `e2e/surfaces.ts`).
 *
 * The rule is mechanical so the twelfth site does not get written: `waitForTimeout` in a
 * spec fails here unless the file is listed below with the number of sites and the reason.
 */

const root = path.resolve(import.meta.dirname, '..')

/** Assembled, so this file's own prose cannot match. */
const FIXED_WAIT = new RegExp('\\.' + 'waitForTimeout\\(', 'g')

/**
 * The sites that remain, each with why. A count, not a flag: a second wait added to a
 * listed file is still refused.
 */
const KNOWN: Record<string, { sites: number; why: string }> = {
  'e2e/scn-007.spec.ts': {
    sites: 1,
    why: 'the gap between reads of the installed rules inside a polling loop with its own deadline; not a wait before an assertion',
  },
  'e2e/scn-023.spec.ts': {
    sites: 2,
    why: 'a wipe that must not happen has no completion signal to wait for; same class as B-169, left open under it',
  },
  'e2e/scn-037.spec.ts': {
    sites: 1,
    why: 'a blocked frame whose document never loads has no signal of its own; same class as B-169, left open under it',
  },
}

function specs(): string[] {
  return globSync('e2e/*.spec.ts', { cwd: root })
}

/** The Gecko harness has its own spelling of the same wait. */
const GECKO = 'tools/firefox-e2e.mjs'
const GECKO_SLEEP = new RegExp('driver\\.' + 'sleep\\(', 'g')

/** Its remaining site, with why. */
const GECKO_KNOWN = {
  sites: 1,
  why: 'the pause before asserting that a scripted submit raised the gate: a wait before a presence check, which can only fail late, never pass early',
}

describe('fixed waits in e2e specs', () => {
  it('appear only where they are named, and no more often', () => {
    const found: Record<string, number> = {}
    for (const file of specs()) {
      const count = readFileSync(path.join(root, file), 'utf8').match(FIXED_WAIT)?.length ?? 0
      if (count > 0) found[file] = count
    }
    const allowed = Object.fromEntries(Object.entries(KNOWN).map(([file, { sites }]) => [file, sites]))
    expect(
      found,
      'wait for the product to say the check settled (e2e/surfaces.ts: expectSettled), not for a time',
    ).toEqual(allowed)
  })

  it('appear in the Gecko harness only where they are named', () => {
    const text = readFileSync(path.join(root, GECKO), 'utf8')
    expect(
      text.match(GECKO_SLEEP)?.length ?? 0,
      `${GECKO}: wait for okolos:scan or another settle mark, not for a time (${GECKO_KNOWN.why})`,
    ).toBe(GECKO_KNOWN.sites)
  })

  it('is looking at real specs, so an empty walk cannot pass', () => {
    expect(specs().length).toBeGreaterThan(30)
  })

  it('refuses the shape it exists for', () => {
    const planted = "  await page.waitForTimeout(2_000)\n  await expect(banner).toHaveCount(0)"
    expect(planted.match(FIXED_WAIT)?.length).toBe(1)
  })
})
