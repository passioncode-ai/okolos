import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { filesIn, filesUnder } from './tree.mjs'

/**
 * The shapes a test takes when it stops testing.
 *
 * Two of them, both written in this repository and both found by sweeping for
 * the pattern rather than by anything failing.
 *
 * `if (state !== 'ready') return` inside a spec reads as caution and behaves as
 * a skip: the assertions below it never run, the run is green, and the report
 * says the scenario passed. The one in `scn-017` would have hidden exactly the
 * regression that screen exists to survive — losing the `management`
 * permission — and it was written by the same hand that has spent this session
 * hunting vacuous greens.
 *
 * The rule is narrow on purpose. A bare `return` inside a spec body abandons
 * the test; a `return <value>` is a helper computing something, which is fine.
 * A branch that genuinely cannot be asserted belongs in a unit test where the
 * condition can be constructed, not in an end-to-end run where it is left to
 * chance.
 */

const root = process.cwd()
const specs = filesIn(path.join(root, 'e2e'), '.spec.ts')

/**
 * Files under a directory, found rather than listed.
 *
 * The walk is `filesUnder`'s. `keep` stays, because every caller here filters on
 * something different and that is the caller's business, not the walker's (B-58).
 */
function walk(dir: string, keep: (name: string) => boolean): string[] {
  return filesUnder(path.join(root, dir), '')
    .filter((file) => keep(path.basename(file)))
    .map((file) => path.relative(root, file))
}

const unitTests = (dir: string): string[] => walk(dir, (name) => name.endsWith('.test.ts'))
const productCode = (dir: string): string[] =>
  walk(dir, (name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))

const units = [...unitTests('packages'), ...unitTests('apps'), ...unitTests('tools')]

describe('no end-to-end test can pass by giving up', () => {
  it('has specs to check at all', () => {
    // Otherwise an empty list would make every assertion below vacuous — the
    // very fault this file exists to catch.
    expect(specs.length).toBeGreaterThan(10)
  })

  for (const name of specs) {
    it(`${name} contains no bare early return`, () => {
      const lines = readFileSync(path.join(root, 'e2e', name), 'utf8').split('\n')
      const offenders = lines
        .map((line, index) => ({ line: line.trim(), number: index + 1 }))
        .filter((entry) => /^if\s*\(.*\)\s*return\s*;?$/.test(entry.line))

      expect(
        offenders,
        `a bare early return skips the assertions after it and still reports green`,
      ).toEqual([])
    })
  }
})

describe('no unit test hides its assertions behind a branch', () => {
  it('found the unit tests to check', () => {
    expect(units.length).toBeGreaterThan(40)
  })

  for (const file of units) {
    it(`${file} asserts unconditionally`, () => {
      const lines = readFileSync(path.join(root, file), 'utf8').split('\n')
      const offenders: string[] = []

      lines.forEach((raw, index) => {
        const line = raw.trim()
        // `if (x) expect(...)` — the assertion vanishes when x is false.
        if (/^if\s*\(.*\)\s*expect\(/.test(line)) {
          offenders.push(`${index + 1}: ${line}`)
          return
        }
        // `if (x) return` — the same fault, and it slipped through the rule
        // above until it was written into this very file.
        if (/^if\s*\(.*\)\s*return\s*;?$/.test(line)) {
          offenders.push(`${index + 1}: ${line}`)
          return
        }
        // `if (x) {` opening a block whose first statement is an assertion.
        // A narrowing helper that throws is the fix; this is the pattern it
        // replaces.
        if (/^if\s*\(.*\)\s*\{$/.test(line)) {
          const next = lines.slice(index + 1).find((candidate) => candidate.trim() !== '')
          if (next && /^expect\(/.test(next.trim())) offenders.push(`${index + 1}: ${line}`)
        }
      })

      expect(
        offenders,
        'an assertion inside a branch does not run when the branch is not taken, and the test passes anyway',
      ).toEqual([])
    })
  }
})

describe('every message type is both served and sent', () => {
  const rpc = readFileSync(path.join(root, 'packages/contracts/src/rpc.ts'), 'utf8')
  const types = [...rpc.matchAll(/^\s*'([a-z/-]+)':\s*\{/gm)].map((m) => m[1] as string)

  const product = [...productCode('apps'), ...productCode('packages')]
    .map((file) => readFileSync(path.join(root, file), 'utf8'))
    .join('\n')

  const CONTENT_ENTRY = 'apps/extension/src/content/index.ts'
  const sources = [
    'apps/extension/src/background/index.ts',
    CONTENT_ENTRY,
  ]
    .map((file) => readFileSync(path.join(root, file), 'utf8'))
    .join('\n')

  /** Read on its own, because *where* a type is handled decides how it may be sent. */
  const content = readFileSync(path.join(root, CONTENT_ENTRY), 'utf8')

  /**
   * Types whose only sender is a test, named here rather than excused by a
   * loosened rule. `rules/refresh` exists so an end-to-end run can tell the
   * worker to rebuild its blocking rules after seeding a feed — the product
   * itself calls `refreshBlockRules()` directly. A visible exception with a
   * reason is a decision; a weakened assertion is an accident waiting.
   */
  const TEST_FACING = new Set(['rules/refresh'])

  it('found the contract', () => {
    expect(types.length).toBeGreaterThan(10)
  })

  it('can still tell a content-script handler from a sender', () => {
    /**
     * The channel rule below reads `message.type === '…'` out of the content
     * script to decide where a type is served. If that shape ever changes — a
     * switch instead of an if, a destructured `type` — the regex stops matching,
     * every type silently becomes "background-handled", and the rule goes on
     * passing while checking nothing. So the one type that *is* handled there is
     * named, and its absence fails here rather than quietly everywhere.
     */
    const handled = [...content.matchAll(/message\.type\s*[!=]==\s*'([a-z/-]+)'/g)].map(
      (m) => m[1] as string,
    )
    expect(handled, 'the content script no longer handles anything this way').toContain(
      'download/verdict',
    )
  })

  it('every named exception is still a real endpoint', () => {
    // Otherwise the exception list becomes the place dead types go to hide.
    for (const type of TEST_FACING) {
      expect(types, `${type} is excused but not in the contract`).toContain(type)
      expect(sources, `${type} is excused but has no handler`).toContain(`'${type}'`)
    }
  })

  for (const type of types) {
    it(`${type} has a handler`, () => {
      // Four types sat here with neither handler nor caller: a contract entry
      // nobody serves is a promise the product does not keep.
      expect(sources).toContain(`'${type}'`)
    })

    if (!TEST_FACING.has(type)) {
      it(`${type} has a sender`, () => {
        // `download/verdict` had a sender and no listener for a week, so a
        // blocked download was journalled and the user was told nothing.
        //
        // The exception is applied here, where the test is or is not created,
        // rather than as an early return inside it — a test that exists and
        // returns is the shape this very file forbids.
        expect(product).toMatch(new RegExp(`send\\w*\\(\\s*'${type.replace('/', '\\/')}'`))
      })

      it(`${type} is sent on the channel that reaches its handler`, () => {
        /**
         * Having a sender and having a *reachable* sender are different facts, and
         * the second one is what `download/verdict` failed for a week: it was sent
         * with `runtime.send` from the background, its only listener lived in
         * `content/index.ts`, and `runtime.sendMessage` from a background context
         * reaches the extension's own pages and never a content script. A module
         * with nine tests could not run in the product, and the check above was
         * green the whole time because a sender existed.
         *
         * So the channel is decided by where the handler is, and the two are
         * compared. `tabs.sendToActive` is the only way into a content script;
         * `runtime.send` is the way to the background and to extension pages.
         */
        /**
         * Handled-here, not mentioned-here. The first version asked whether the
         * type's name appeared in the content script and got ten false positives
         * at once: the content script both sends and handles, so `page/candidates`
         * — sent from the page, served by the background — looked content-handled.
         * A discriminator that cannot tell a sender from a handler is no
         * discriminator, and it is the third over-matching extractor this session,
         * so the shape is asserted below rather than assumed.
         */
        const escaped = type.replace('/', '\\/')
        const handledInContent = new RegExp(`message\\.type\\s*[!=]==\\s*'${escaped}'`).test(
          content,
        )
        const pattern = (fn: string): RegExp => new RegExp(`${fn}\\(\\s*'${escaped}'`)

        /**
         * One assertion, no branch. Written as `if (…) expect(…) else expect(…)` it
         * asserted in both arms and was still refused by the rule at the top of this
         * file — which cannot see that both arms assert, and is right to refuse the
         * shape rather than special-case it.
         *
         * Two channels reach a content script, not one: `sendToActive` for the tab
         * the user is looking at, `sendToFrame` for a named frame of a named tab. The
         * first version of this rule allowed only the former and failed
         * `frame/finding`, which is delivered by the latter — a rule that names one
         * correct answer when there are two is a rule that will be edited to shut up
         * rather than to be right.
         */
        const CONTENT_CHANNELS = ['sendToActive', 'sendToFrame']
        const sentOn = (fn: string): boolean => pattern(fn).test(product)
        const ok = handledInContent
          ? CONTENT_CHANNELS.some(sentOn)
          : sentOn('send') && !CONTENT_CHANNELS.some(sentOn)
        const why = handledInContent
          ? `${type} is handled in the content script, so it must be sent with ` +
            `tabs.${CONTENT_CHANNELS.join(' or tabs.')} — runtime.send from the ` +
            `background never arrives there`
          : `${type} is handled in a background or extension-page context, which the ` +
            `tabs channels do not address — send it with runtime.send`
        expect(ok, why).toBe(true)
      })
    }
  }
})

describe('retention is not left to an alarm that may never fire', () => {
  /**
   * `alarms.create` replaces an alarm of the same name, the background
   * re-creates it on every service-worker start, and an MV3 worker starts many
   * times a day — so a twenty-four hour alarm on a browser in daily use can be
   * reset before it fires. The journal screen promises that anything older
   * than ninety days is deleted.
   *
   * The decision of *when* is unit-tested in packages/storage. What no unit
   * test can reach is whether the background actually asks at start: the
   * module runs on import and cannot be loaded in isolation. This is a source
   * check, and a source check is weaker than a behavioural one — it would not
   * notice a sweep that ran and did nothing. It is here because deleting the
   * call was otherwise caught by nothing at all.
   */
  const background = readFileSync(
    path.join(root, 'apps/extension/src/background/index.ts'),
    'utf8',
  )

  it('sweeps at start, not only when the alarm fires', () => {
    const atModuleScope = /^void sweepIfDue\(\)$/m.test(background)
    expect(atModuleScope, 'the startup sweep is gone; retention rests on the alarm alone').toBe(
      true,
    )
  })

  it('still sweeps on the alarm, for a session that never restarts', () => {
    const inHandler = /RETENTION_ALARM\)[\s\S]{0,400}sweepIfDue\(\)/.test(background)
    expect(inHandler, 'the alarm no longer sweeps').toBe(true)
  })

  it('records when it swept, or the next start cannot tell', () => {
    expect(background).toContain('LAST_SWEEP_KEY')
    expect(background).toContain('dueForSweep')
  })
})

describe('a wake-up does only what is owed (LC-08)', () => {
  /**
   * The background runs on import and cannot be loaded in isolation, so its wiring is
   * held by source checks; the behaviour behind each call is counted on a fake clock in
   * apps/extension/src/background/wake.test.ts. Before this, every wake-up rebuilt every
   * blocking rule and listed every installed extension at the top of the file.
   */
  const background = readFileSync(
    path.join(root, 'apps/extension/src/background/index.ts'),
    'utf8',
  )

  it('does not rebuild the blocking rules at module scope', () => {
    expect(background).not.toMatch(/^void refreshBlockRules\(\)/m)
  })

  it('does not review the extension inventory at module scope, only when a day has passed', () => {
    expect(background).not.toMatch(/^void reviewExtensions\(\)/m)
    expect(background).toMatch(/^void reviewIfDue\(\)$/m)
    expect(background).toContain('LAST_INVENTORY_KEY')
  })

  it('repairs the rules on browser start and install, through a count check', () => {
    expect(background).toMatch(/onBrowserStart\(\(\) => \{\s*void ensureBlockRules\(\)/)
    expect(background).toContain('ensureRules(')
  })

  it('reads the feed when the interstitial asks, not on every navigation', () => {
    const handler = /platform\.blocking\.onBlocked\(([\s\S]*?)\n\}\)/.exec(background)?.[1] ?? ''
    expect(handler, 'the navigation handler').not.toBe('')
    expect(handler).not.toContain('currentFeed')
  })
})

describe('silence is not an empty list', () => {
  /**
   * `send()` resolves to the handler's answer, and a handler that never ran
   * resolves to nothing. `?? []` on that turns "the background did not answer"
   * into "there is nothing here" — the reassuring answer, and possibly the
   * wrong one.
   *
   * The trusted-domains panel did exactly that, three lines above a comment
   * forbidding it. The surfaces go through `answered()` now, which is unit
   * tested; this stops the shortcut coming back, because no unit test reaches
   * the wiring where it lives.
   *
   * Content-script code is deliberately outside this rule and is listed with
   * its reason: there, an unanswered lookup falls to the cautious side.
   */
  const SURFACES = [
    'apps/extension/src/options/index.ts',
    'apps/extension/src/popup/index.ts',
    'apps/extension/src/first-run/index.ts',
    'apps/extension/src/interstitial/index.ts',
  ]

  it('reads surfaces that exist, so an empty sweep cannot pass', () => {
    const present = SURFACES.filter((file) => existsSync(path.join(root, file)))
    expect(present.length).toBeGreaterThan(2)
  })

  it('no surface defaults an unanswered RPC to an empty list', () => {
    /**
     * Two shapes, and the second is the one the first version of this rule
     * missed. Inline — `(await send(...))?.x ?? []` — is a single line and easy
     * to spot. Assigned first and defaulted later is not, and that is exactly
     * how the trusted-domains panel was written, so the variable is followed.
     */
    const offenders: string[] = []
    for (const file of SURFACES) {
      const full = path.join(root, file)
      if (!existsSync(full)) continue
      const body = readFileSync(full, 'utf8')

      if (/\(\s*(?:await\s+)?[\w.]*send\([^)]*\)\s*\)?\??\.?\w*\s*\?\?\s*[[{]/.test(body)) {
        offenders.push(`${file} (inline)`)
      }

      for (const match of body.matchAll(
        /(?:const|let)\s+(\w+)\s*=\s*(?:await\s+)?[\w.]*send\(/g,
      )) {
        const name = match[1] as string
        const defaulted = new RegExp(`\\b${name}\\s*\\??\\.[\\w.]+\\s*\\?\\?\\s*[[{]`)
        if (defaulted.test(body.slice(match.index))) offenders.push(`${file} (${name})`)
      }
    }
    expect(
      [...new Set(offenders)],
      'these turn "the background did not answer" into "there is nothing here" — use answered()',
    ).toEqual([])
  })

  it('the helper that makes the distinction is tested where it lives', () => {
    expect(existsSync(path.join(root, 'apps/extension/src/options/answered.test.ts'))).toBe(true)
  })
})

describe('a periodic job asks whether it is owed', () => {
  /**
   * An MV3 service worker starts many times a day — it wakes for every message a
   * content script sends, which is nearly every page — and `alarms.create`
   * replaces an alarm of the same name, so an alarm re-created at start can be
   * reset before it ever fires. Every periodic job therefore needs a timestamp in
   * storage, and a job called unconditionally at start is a job that runs per
   * page.
   *
   * The retention sweep had that timestamp. The feed pull did not, and made one
   * request per page for as long as it shipped — each writing a row to
   * `outbound_log`, because the audit entry is mandatory before a request leaves.
   * This reads the background's source and requires every start-time job to
   * consult a due-check, because the shape is the defect and the shape is what a
   * reader misses.
   */
  const source = readFileSync(path.join(root, 'apps/extension/src/background/index.ts'), 'utf8')

  /** The jobs started at load, and the due-check each must consult. */
  const PERIODIC: ReadonlyArray<readonly [string, string]> = [
    ['pullFeed', 'dueForFeed'],
    ['sweepIfDue', 'dueForSweep'],
  ]

  it('is reading the background that actually starts them', () => {
    // An empty read would make every assertion below pass on nothing.
    expect(source).toContain('platform.alarms.create')
    expect(source.length).toBeGreaterThan(5000)
  })

  /**
   * Whether `body` **acts on** the check rather than merely naming it.
   *
   * The first version of this asked whether the function's text contained the
   * check's name, and a plant of `void dueForFeed` — which does nothing at all —
   * kept it green. That is the same weak discriminator this file has caught
   * before, when a type merely *mentioned* in the content script counted as a
   * type *handled* there.
   *
   * So the pattern is the shape that matters: the check negated in a condition
   * whose body returns. Narrow enough to reject a mention, and asserted against
   * both a passing and a failing snippet below — a matcher nobody has watched
   * fail is a matcher that matches anything.
   */
  const guardsWith = (body: string, check: string): boolean =>
    new RegExp(`if\\s*\\(\\s*!${check}\\(([\\s\\S]{0,400}?)\\)\\s*\\)\\s*\\{?[\\s\\S]{0,80}?\\breturn\\b`).test(body)

  const bodyOf = (job: string): string => {
    const from = source.indexOf(`async function ${job}(`)
    const body = source.slice(from)
    const end = body.indexOf('\n}\n')
    return body.slice(0, end === -1 ? body.length : end)
  }

  it('rejects a mention that does nothing, which is how this check first passed', () => {
    // The discriminator, checked against the plant that defeated its predecessor.
    expect(guardsWith('void dueForFeed', 'dueForFeed'), 'a bare mention counts as a guard').toBe(
      false,
    )
    expect(guardsWith('const x = dueForFeed(a, b)', 'dueForFeed')).toBe(false)
    expect(guardsWith('if (!dueForFeed(last, Date.now())) {\n  return\n}', 'dueForFeed')).toBe(true)
    expect(guardsWith('if (!dueForFeed(last, now)) return', 'dueForFeed')).toBe(true)
  })

  for (const [job, check] of PERIODIC) {
    it(`${job} refuses to work unless ${check} says it is owed`, () => {
      expect(guardsWith(bodyOf(job), check), `${job} does not act on ${check}`).toBe(true)
    })
  }

  it('records the feed’s attempt before the request, not after it', () => {
    /**
     * After would mean a pull that throws leaves no mark, and the next wake-up
     * tries again immediately — the flood, arriving only when something is
     * already wrong. The order is the rule, so the order is what is checked.
     */
    const body = source.slice(source.indexOf('async function pullFeed('))
    const marked = body.indexOf('LAST_FEED_KEY, value:')
    const sent = body.indexOf('await syncFeed(')
    expect(marked, 'the attempt is never recorded').toBeGreaterThan(0)
    expect(sent).toBeGreaterThan(0)
    expect(marked, 'the attempt is recorded after the request').toBeLessThan(sent)
  })
})
