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
  'e2e/scn-049.spec.ts': {
    sites: 6,
    why: 'a link warning that must not come back after a dispute, a right click that must not be stopped and a page that must not raise anything before the click have no completion signal to wait for; same class as B-169, left open under B-224',
  },
}

function specs(): string[] {
  // globSync answers with the platform's separator; the allowed list is written with '/', so
  // Windows read e2e\\scn-007.spec.ts and failed a list that was right (CI, gates (windows)).
  return globSync('e2e/*.spec.ts', { cwd: root }).map((file) => file.split(path.sep).join('/'))
}

/** The Gecko harness has its own spelling of the same wait. */
const GECKO = 'tools/firefox-e2e.mjs'
const GECKO_SLEEP = new RegExp('driver\\.' + 'sleep\\(', 'g')

/** Its remaining site, with why. */
const GECKO_KNOWN = {
  sites: 1,
  why: 'the pause before asserting that a scripted submit raised the gate: a wait before a presence check, which can only fail late, never pass early',
}

/**
 * The same wait in other spellings (B-189): `await new Promise((r) => setTimeout(r, …))` in
 * a spec or a helper, and `waitForTimeout` in `tools/gecko-layout.mjs`, which the walk above
 * did not read. Each remaining site is a pause inside a loop with its own deadline, which can
 * only make a check late, never let it pass early.
 */
const TIMER = new RegExp('set' + 'Timeout\\(', 'g')

const TIMER_KNOWN: Record<string, { sites: number; why: string }> = {
  'e2e/surfaces.ts': {
    sites: 1,
    why: 'the poll in expectSettled, between reads of a settle mark, inside its own deadline',
  },
  'tools/firefox-e2e.mjs': {
    sites: 1,
    why: 'the poll for geckodriver to answer /status, inside its own deadline',
  },
}

/** Every file that drives a browser for a check: specs, their helpers, both Gecko tools. */
function drivers(): string[] {
  const e2e = globSync('e2e/*.ts', { cwd: root }).map((file) => file.split(path.sep).join('/'))
  return [...e2e, 'tools/firefox-e2e.mjs', 'tools/gecko-layout.mjs']
}

describe('timers standing in for a signal', () => {
  it('appear only where they are named, and no more often', () => {
    const found: Record<string, number> = {}
    for (const file of drivers()) {
      const count = readFileSync(path.join(root, file), 'utf8').match(TIMER)?.length ?? 0
      if (count > 0) found[file] = count
    }
    const allowed = Object.fromEntries(Object.entries(TIMER_KNOWN).map(([file, { sites }]) => [file, sites]))
    expect(found, 'wait for the product to say the check settled, not for a timer').toEqual(allowed)
  })

  it('reads the Gecko layout tool for the Playwright spelling too', () => {
    const text = readFileSync(path.join(root, 'tools/gecko-layout.mjs'), 'utf8')
    expect(text.match(FIXED_WAIT)?.length ?? 0, 'tools/gecko-layout.mjs: wait for the area to paint').toBe(0)
  })

  it('refuses the shape it exists for', () => {
    const planted = '  await new Promise((resolve) => setTimeout(resolve, 500))'
    expect(planted.match(TIMER)?.length).toBe(1)
  })
})

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
