import { readFileSync } from 'node:fs'
import path from 'node:path'

import { globSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * How a finding crosses from the context that found it to the one that shows it.
 *
 * Two rules, both parts of ADR-0013, both written in comments and held by nothing until
 * 2026-08-20. They are in one file because they answer one question — what a report may
 * rely on when it leaves its own context — and separating them would let a reader fix one
 * while breaking the other.
 *
 * ## The background may set a timer to **give up**, never to **wait**.
 *
 * An MV3 service worker is torn down when the browser decides, and a pending `setTimeout`
 * does not stop it. So anything that sleeps in the background is a plan the browser is
 * free to cancel halfway — and the failure it produces is the worst kind: it works most
 * of the time. Measured on 2026-08-20, B-82: a delivery loop of twelve attempts over nine
 * seconds lived here, and the same end-to-end spec passed and failed across identical
 * runs until the loop was replaced by a question the receiving document asks.
 *
 * A deadline is the opposite shape and stays allowed. `setTimeout(() => reject(...))`
 * makes work *end* sooner; the worker dying early only brings forward what the timer was
 * going to do. `setTimeout(resolve, ms)` makes work *continue* later, and the worker dying
 * cancels it. So the rule is about which way the timer points, not about timers.
 *
 * Recorded as [ADR-0013](../docs/adr/0013-a-finding-crosses-contexts-by-being-asked-for.md).
 */

const root = path.resolve(import.meta.dirname, '..')

function backgroundSources(): string[] {
  return globSync('apps/extension/src/background/**/*.ts', {
    cwd: root,
    exclude: (p) => p.includes('.test.') || p.includes('.bench.'),
  }).map((p) => path.join(root, p))
}

/** Every `setTimeout` call with the text of its first argument, roughly. */
function timers(source: string): string[] {
  return [...source.matchAll(/set(?:Timeout|Interval)\s*\(([^;]{0,120})/g)].map((m) => m[1] ?? '')
}

describe('the background may set a timer to give up, never to wait', () => {
  it('finds the files it claims to check', () => {
    // An empty sweep would pass forever. The background is more than five modules.
    expect(backgroundSources().length).toBeGreaterThan(5)
  })

  it('has no timer that resolves — that is a sleep, and a sleep here is cancellable', () => {
    const sleeping: string[] = []
    for (const file of backgroundSources()) {
      const source = readFileSync(file, 'utf8')
      for (const call of timers(source)) {
        // `setTimeout(resolve, ms)` and `setTimeout(() => resolve(...), ms)` both continue
        // work later. A rejecting or aborting timer ends it, which is a deadline.
        if (/\bresolve\b/.test(call)) sleeping.push(`${path.relative(root, file)}: ${call.trim()}`)
      }
    }
    expect(sleeping, 'the worker cannot rely on waking up again').toEqual([])
  })

  /**
   * The pair that keeps the rule readable: a deadline must still be possible, and it is.
   * Without this, someone reading the failure above could conclude timers are banned here
   * and remove the one that stops a hung request.
   *
   * **Where it looks moved on 2026-08-21, and the gate is what said so.** The deadline used
   * to be written out in `background/leaks.ts`; it existed twice, so it was consolidated into
   * `withDeadline` in `@okolos/platform` (B-111) — and this assertion went red, because the
   * background then contained no rejecting timer of its own. Exactly its job: it watches a
   * thing, and the thing moved. It now looks where the deadline lives, while the rule above
   * still applies to the background, which is the half that matters.
   */
  const DEADLINE_HOME = 'packages/platform/src/adapter.ts'

  it('still allows a timer that ends work early', () => {
    const deadlines = timers(readFileSync(path.join(root, DEADLINE_HOME), 'utf8')).filter((call) =>
      /\breject\b|\babort\b/i.test(call),
    )
    expect(
      deadlines.length,
      `no deadline timer in ${DEADLINE_HOME} — has the one shared deadline moved again?`,
    ).toBeGreaterThan(0)
  })

  it('and the background reaches that deadline rather than writing its own', () => {
    // The rule above forbids a *waiting* timer here; this says the giving-up kind is still
    // reachable from the background, which is what makes the rule a rule and not a ban.
    const callers = backgroundSources().filter((file) =>
      /\bwithDeadline\s*\(/.test(readFileSync(file, 'utf8')),
    )
    expect(callers.length, 'nothing in the background sets a deadline at all').toBeGreaterThan(0)
  })
})

/**
 * A frame reports upward through the background, never through the page's own window.
 *
 * `window.top.postMessage` travels through the window of the very page being reported on,
 * so the page can post the same message — and the top frame has no way to tell an
 * extension's report from a claim by the thing under suspicion. The hop therefore goes
 * frame → background → top frame, and the background stamps the sender's origin itself.
 *
 * The decision was written down twice in comments and held by nothing. This is the
 * mechanism: no code under `content/` may post to a parent window. `page-watch/` is a
 * different world and a different problem — it posts to *its own* window on purpose, and
 * is out of scope here by path.
 *
 * Part of [ADR-0013](../docs/adr/0013-a-finding-crosses-contexts-by-being-asked-for.md).
 */
describe('a frame reports through the background, not through the page', () => {
  function contentSources(): string[] {
    return globSync('apps/extension/src/content/**/*.ts', {
      cwd: root,
      exclude: (p) => p.includes('.test.') || p.includes('.bench.'),
    }).map((p) => path.join(root, p))
  }

  it('finds the files it claims to check', () => {
    expect(contentSources().length).toBeGreaterThan(5)
  })

  it('posts nothing to a parent window', () => {
    const posts: string[] = []
    for (const file of contentSources()) {
      const source = readFileSync(file, 'utf8')
      for (const line of source.split(/\r?\n/)) {
        // A comment may name the thing it refuses; a call may not exist. The difference is
        // the leading `//` or `*`, which is why the trimmed line is tested rather than the
        // file: this file's own subject appears in three comments in `content/index.ts`.
        const code = line.trim()
        if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) continue
        if (/\b(?:window\.)?(?:top|parent)\s*(?:\?\.)?\.postMessage\s*\(/.test(code)) {
          posts.push(`${path.relative(root, file)}: ${code.slice(0, 70)}`)
        }
      }
    }
    expect(posts, 'the page can forge anything sent through its own window').toEqual([])
  })
})

