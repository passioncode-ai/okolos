import { expect, type BrowserContext, type Frame, type Page, type Worker } from '@playwright/test'

import { RECORD_VISIBLE_MS, SURFACE_MOUNT_MS } from './budgets.js'

/**
 * Waiting for the banner, and saying which link broke when it does not come.
 *
 * `await expect(page.locator('okolos-banner')).toHaveCount(1, …)` reports
 * *"44 × locator resolved to 0 elements"* and nothing else. Between the navigation
 * and the banner there are five links — the extension loaded, the service worker
 * booted, the content script ran, it produced a verdict, the RPC came back — and
 * that message distinguishes none of them. The class has now failed twice on CI in
 * tests that were not about mounting: four checks in `scn-010` on 2026-08-20, and
 * "Allow once lets that one action through" the same night, 20.6 s for a surface its
 * four siblings mounted in 700 ms.
 *
 * So the wait carries a report. It changes nothing about a passing run — the same
 * assertion, the same budget — and turns the next failure from a guess into a
 * reading. It does not attempt a fix: what makes one spec out of five hang is
 * recorded as B-73 and unknown.
 */
export async function expectBanner(page: Page, context?: BrowserContext): Promise<void> {
  await expectSurface(page, 'okolos-banner', context)
}

/**
 * The same wait and the same report, for a surface named some other way.
 *
 * Ten spec files reached for `expectBanner`; eight hand-rolled the assertion beside it,
 * and one of those is the reason this paragraph exists. `hostile-page.spec.ts` matches on
 * `[data-okolos=banner]` rather than on the tag — deliberately, because the host takes an
 * unpredictable name when a page has claimed the canonical one — so it could not use the
 * helper and had no report. It then failed on CI three times for a banner that never
 * arrived (B-65 twice, B-108 once), and each failure said "0 elements" and nothing else:
 * the third one cost a downloaded trace and an hour of hypotheses to reach a fact this
 * function prints in one line.
 *
 * A helper the sibling case cannot call is a helper that will be hand-rolled beside it,
 * which is why the selector is a parameter now and `tools/surface-waits.test.ts` refuses
 * the hand-rolled form.
 */
export async function expectSurface(
  page: Page,
  selector: string,
  context?: BrowserContext,
): Promise<void> {
  try {
    await expect(page.locator(selector)).toHaveCount(1, { timeout: SURFACE_MOUNT_MS })
  } catch (cause) {
    throw new Error(`${(cause as Error).message}\n\n${await diagnose(page, context)}`)
  }
}

/**
 * What is true at the moment the banner is not there.
 *
 * Every line is a fact this test can still read after the wait ran out, and each one
 * eliminates a link: no service worker means the extension never started; a page
 * with no content-script trace means it never ran; a trace with no host means the
 * verdict never came back.
 */
async function diagnose(page: Page, context?: BrowserContext): Promise<string> {
  const lines: string[] = ['what was true when the banner did not appear:']

  const workers = context?.serviceWorkers() ?? []
  lines.push(
    workers.length === 0
      ? '  - no service worker: the extension had not started, or failed to load'
      : `  - ${workers.length} service worker(s): ${workers.map((w) => w.url().split('/')[2]).join(', ')}`,
  )

  /**
   * The other half of the same question, read from the worker's own timeline.
   *
   * "A worker is registered" and "the worker heard this question" are different facts,
   * and the report used to carry only the first. When the page says it asked and no
   * banner came, three cases are indistinguishable from the page alone: the message
   * never reached the worker, the worker took it and stalled, or it answered and the
   * answer was lost. The product marks the arrival and measures the answer (B-78), so
   * the lines below eliminate two of the three — and the worker's age is the fourth
   * fact, because a worker two hundred milliseconds old had been asleep for the whole
   * wait, which is Chrome's cost and not this code's.
   */
  const worker = workers[0]
  let answered: number | null = null
  if (worker) {
    try {
      const w = await worker.evaluate(() => ({
        aliveMs: performance.now(),
        asked: performance.getEntriesByName('okolos:verdict:start').length,
        answers: performance.getEntriesByName('okolos:verdict').length,
        lastMs: performance.getEntriesByName('okolos:verdict').at(-1)?.duration ?? null,
      }))
      lines.push(`  - the worker has been alive ${(w.aliveMs / 1000).toFixed(1)} s`)
      if (w.asked === 0) {
        lines.push('  - this worker NEVER RECEIVED a verdict request: either nothing reached it,')
        lines.push('    or the worker that took the question was torn down and this is a new one.')
        lines.push('    Compare its age against the wait: a young worker had been asleep.')
      } else if (w.answers === 0) {
        lines.push(`  - the worker RECEIVED ${w.asked} verdict request(s) and ANSWERED NONE:`)
        lines.push('    the handler took the question and did not come back. This one is ours.')
      } else {
        answered = w.answers
        lines.push(
          `  - the worker answered ${w.answers} of ${w.asked} request(s), the last in ` +
            `${w.lastMs?.toFixed(1) ?? '?'} ms: the background did its part, so the loss is`,
        )
        lines.push('    on the way back or in the mount, not in the scan.')
      }
    } catch (cause) {
      // An extension worker that cannot be evaluated is itself worth printing: it is
      // either gone or not the kind of worker this report assumed.
      lines.push(`  - the worker could not be read: ${String(cause)}`)
    }
  }

  try {
    const page_ = await page.evaluate(() => ({
      url: location.href,
      // Custom elements are upgraded lazily; asking the DOM directly separates
      // "the element is absent" from "the element is there and empty".
      hosts: document.querySelectorAll('okolos-banner, okolos-gate, okolos-comparison').length,
      neutralised: document.querySelectorAll('[data-okolos-neutralised]').length,
      ready: document.readyState,
      nodes: document.querySelectorAll('*').length,
      /**
       * Did the content script get as far as scanning?
       *
       * The one fact that separates "it never ran" from "it ran and the verdict never
       * came back" — and the one this report did not carry on its first live firing.
       * CI, 2026-08-20: a worker registered, the page complete with ten nodes, zero
       * hosts, and nothing to say which of the two links had broken. The product marks
       * its own scan (`performance.measure('okolos:collect')`), so the answer was
       * already on the page and nobody asked for it.
       */
      scanned: performance.getEntriesByName('okolos:collect')[0]?.duration ?? null,
      /**
       * Did the scan give up rather than finish?
       *
       * The product marks this when its fail-open wrapper catches — which on a slow
       * worker means the RPC deadline fired and the check was journalled as unfinished.
       * From outside, that looks identical to a broken relay: no banner either way. This
       * is the fact that separates them (B-78).
       */
      gaveUp: performance.getEntriesByName('okolos:scan-failed').length > 0,
      /**
       * Did the walk stop before anything was asked?
       *
       * The third state, and the one this report got wrong. A truncated traversal with no
       * candidates sends no RPC at all — so "the verdict is what did not arrive" named a
       * link that was never reached. Four CI failures read that way before the cause was
       * measured: the collector's budget had a wall-clock component of eight milliseconds,
       * and on a loaded runner that fires on a seven-node page (B-110).
       */
      blinded: performance.getEntriesByName('okolos:scan-blinded').length > 0,
      /**
       * Was the page read in full, whatever the walk found?
       *
       * `blinded` is the narrower fact — cut short *and* nothing to ask about. A walk
       * that was cut short and did find something can still miss the finding this test
       * is waiting for, which looks identical from outside to a finding that was never
       * there. Written by the product since B-121 and unread here until the gate in
       * `tools/marks-read.test.ts` said so.
       */
      partial: performance.getEntriesByName('okolos:scan-partial').length > 0,
      /**
       * If a banner did arrive, how long it took from the navigation.
       *
       * The number SCN-003 promises in words. On a run where the wait ran out and the
       * surface is here a moment later, this says by how much — which is the difference
       * between "the budget is too tight for this machine" and "the mount is broken".
       */
      bannerMs: performance.getEntriesByName('okolos:banner')[0]?.duration ?? null,
      /**
       * Did a scan settle, its answer back and handled in this page?
       *
       * The product writes `okolos:scan` only once the verdict came back and the warning
       * was drawn, or there was nothing to ask. With it present and no host on the page,
       * the reply arrived and was acted on, so the loss is in the mount (B-78).
       */
      settledMs: performance.getEntriesByName('okolos:scan')[0]?.duration ?? null,
    }))
    lines.push(`  - page ${page_.url} (${page_.ready}), ${page_.nodes} nodes`)
    lines.push(
      page_.scanned === null
        ? '  - the content script never finished a scan: it did not run, or it threw'
        : `  - the content script scanned in ${page_.scanned.toFixed(1)} ms`,
    )
    if (page_.blinded) {
      lines.push(
        '  - the collector STOPPED SHORT and asked nothing: the traversal hit its ceiling',
      )
      lines.push(
        '    with no candidates, so no verdict was ever requested. Check the budget against',
      )
      lines.push('    the page — and against the load on this machine, if the ceiling is time.')
    } else if (page_.scanned !== null) {
      /**
       * Only when nothing on the worker side contradicts it.
       *
       * This line used to be printed on the strength of the page alone, and the page
       * cannot see the answer — so a run where the background had answered every
       * request still read "the verdict is what did not arrive" and sent the next
       * reader down the relay. Measured on the probe that added the worker lines. The
       * rule the product already keeps for `okolos:scan-blinded` applies to the report
       * itself: a named link that was never checked is worse than no name at all.
       */
      lines.push(
        answered === null || answered === 0
          ? '  - the scan asked, so the verdict is what did not arrive'
          : '  - the scan asked and the worker answered, so what is missing is downstream of' +
              ' both — the reply, or the mount',
      )
    }
    if (page_.settledMs !== null) {
      lines.push(
        `  - a scan SETTLED in ${page_.settledMs.toFixed(1)} ms: its answer came back and was` +
          ' handled in this page',
      )
    }
    if (page_.gaveUp) {
      /**
       * Then this is not a broken relay. The background did not answer inside
       * `RPC_TIMEOUT_MS`, the scan failed open and journalled "the check did not
       * finish", and no banner can appear after that however long the wait is — which
       * is why waiting longer is not the fix.
       */
      lines.push(
        '  - the scan GAVE UP: the background did not answer within the RPC deadline,',
      )
      lines.push(
        '    so the check was journalled as unfinished. A banner cannot arrive after that;',
      )
      lines.push('    this is the product degrading honestly on a worker that was too slow.')
    }
    if (page_.partial && !page_.blinded) {
      lines.push('  - the walk was CUT SHORT but did find candidates: the finding this test')
      lines.push('    waits for may have been past the ceiling. Check the budget, not the relay.')
    }
    lines.push(
      `  - ${page_.hosts} okolos host element(s), ${page_.neutralised} neutralised node(s)`,
    )
    if (page_.bannerMs !== null) {
      lines.push(
        `  - a banner was measured at ${(page_.bannerMs / 1000).toFixed(1)} s from the navigation`,
      )
    }
    if (page_.hosts > 0) {
      /**
       * The report is taken *after* the wait ran out, so a surface that is here now
       * was not here then. Said out loud because the alternative reading — "the
       * assertion is lying" — is the one a reader arrives at on their own, and it
       * sends them to rewrite a working check.
       */
      lines.push(
        '  - it is here NOW, which means the wait ended before the mount did, not that',
      )
      lines.push('    the assertion was wrong: this report is a moment later than the failure')
    }
  } catch (cause) {
    // The page may be gone; that is itself the answer.
    lines.push(`  - the page could not be read: ${String(cause)}`)
  }

  lines.push(
    '  - the trace holds the network and console for every step: `pnpm exec playwright show-trace`',
  )
  return lines.join('\n')
}

/**
 * Waits for a line to appear in the journal, reloading the screen on each attempt.
 *
 * **The journal screen is a snapshot taken when it opens, not a live view** — which is
 * right for a journal and wrong to assume in a test. A locator assertion re-reads the DOM
 * of a page that was rendered before the row existed, so it retries for its whole budget
 * against markup that cannot change, and reports the empty state as the received value.
 *
 * The class has now cost two failures. `scn-036` hit it locally, roughly one run in four,
 * and was fixed there in isolation; `budget.spec.ts` hit it on CI two hours later — the
 * sibling nobody swept for. Hence a helper rather than a third copy: the second occurrence
 * is where a fix stops being a fix and becomes a rule.
 *
 * `text` is matched as a substring, so a caller may pass the opening of a sentence rather
 * than a whole message — a message with substitutions has no single rendered form.
 */
export async function expectJournalLine(
  journal: Page,
  text: string,
  timeoutMs = RECORD_VISIBLE_MS,
): Promise<void> {
  await expect
    .poll(
      async () => {
        await journal.reload()
        return journal.locator('[data-role=journal]').innerText()
      },
      { timeout: timeoutMs },
    )
    .toContain(text)
}


/**
 * The product's own word that a check has finished, one name per check.
 *
 * A test that asserts something is **absent** has to know when the thing could have
 * appeared, and these specs used to guess with a fixed wait: two seconds, three, one and a
 * half. On a loaded machine the wait ran out before the check did, and the assertion passed
 * on a check that had not run yet: green exactly when it should have been red (B-169). Each
 * name below is written by the product at the moment its check has settled, after the
 * warning (if any) is drawn:
 *
 * - `okolos:scan`: a page scan, and the frame report or verdict it set in motion;
 * - `okolos:lookalike`: the address check, top frame only;
 * - `okolos:pending`: the question "does this tab hold a leak verdict nobody was shown?";
 * - `okolos:password` (in the **worker**): a submitted password judged, and a compromised
 *   verdict held and offered to the tab;
 * - `okolos:focus-judged`, `okolos:trap-judged`: a focus judged by the password pause, a
 *   look at the page by the trap watcher. These two are per event, so they exist only in
 *   the build with test hooks (`e2e/hooks.ts`); the shipped bundle does not carry them.
 *
 * None of them is written for a check that failed, so a check that did not finish makes the
 * wait run out with a sentence saying so, rather than an absence that proves nothing.
 */
export const SETTLED = {
  scan: 'okolos:scan',
  lookalike: 'okolos:lookalike',
  pending: 'okolos:pending',
  password: 'okolos:password',
  focus: 'okolos:focus-judged',
  trap: 'okolos:trap-judged',
} as const

export type Settled = (typeof SETTLED)[keyof typeof SETTLED]

/** A page, a frame or the worker: anything with its own performance timeline. */
type Timeline = Pick<Worker, 'evaluate'>

/** How many times the product has said this check settled, in this timeline. */
export async function settledCount(where: Timeline, name: Settled): Promise<number> {
  return where.evaluate((entry) => performance.getEntriesByName(entry).length, name)
}

/**
 * Waits until the product says a check has settled, at least `atLeast` times.
 *
 * The scan has a third outcome, giving up (`okolos:scan-failed`, B-78), and the wait stops
 * on it at once: an absence asserted after a scan that gave up proves nothing, and saying so
 * is worth more than thirty-five seconds of waiting for a measure that cannot come.
 */
export async function expectSettled(where: Timeline, name: Settled, atLeast = 1): Promise<void> {
  const deadline = Date.now() + SURFACE_MOUNT_MS
  for (;;) {
    // A document mid-navigation cannot be read; that is "not yet", not an answer.
    const seen = await where
      .evaluate(
        (entry) => ({
          count: performance.getEntriesByName(entry).length,
          gaveUp: performance.getEntriesByName('okolos:scan-failed').length > 0,
        }),
        name,
      )
      .catch(() => ({ count: 0, gaveUp: false }))
    if (seen.count >= atLeast) return
    if (name === SETTLED.scan && seen.gaveUp) {
      throw new Error(
        'the scan GAVE UP (okolos:scan-failed) before it settled: an absence asserted ' +
          'after it would prove nothing, because the check did not finish',
      )
    }
    if (Date.now() > deadline) {
      throw new Error(
        `${name} was written ${seen.count} time(s), waited for ${atLeast}, within ` +
          `${SURFACE_MOUNT_MS / 1000}s: the check did not finish, so an absence asserted ` +
          'now would prove nothing',
      )
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

/**
 * Waits until a page and every frame in it have scanned, and the top frame has checked its
 * address: the point after which a page that stays silent has been heard out.
 */
export async function expectPageSettled(page: Page): Promise<void> {
  await expectSettled(page, SETTLED.lookalike)
  for (const frame of page.frames()) await expectSettled(frame, SETTLED.scan)
}

/**
 * Waits for at least one row matching `selector` on the journal screen, reloading it.
 *
 * The journal screen is a snapshot taken when it opens (see `expectJournalLine`), so
 * waiting for its container and then reading a row at once measured whatever had been
 * written before the screen opened: `panel-shape.spec.ts` failed on CI with "no journal row
 * to measure" on a fresh profile whose first row (the feed download) landed a moment later.
 */
export async function expectJournalRows(
  journal: Page,
  selector: string,
  timeoutMs = RECORD_VISIBLE_MS,
): Promise<void> {
  await expect
    .poll(
      async () => {
        await journal.reload()
        await journal.locator('[data-role=journal]').waitFor()
        return journal.locator(selector).count()
      },
      { timeout: timeoutMs },
    )
    .toBeGreaterThan(0)
}

/**
 * Waits until this document's content script has run, before a spec acts on the page.
 *
 * Content scripts run at `document_idle`, which Chrome may place after the load event that
 * `page.goto` waits for. A focus or a click before that reaches no listener, and the pause
 * it should raise never comes, because it is asked once per page and the question was
 * missed. Seen 2026-10-29 on `scn-034`, one run in twenty-two under four workers: both
 * scans settled, the worker answered both verdict requests, and no banner for 35 s. That
 * is what a click arriving before the frame's listener looks like; the report cannot prove
 * it was that, and this wait closes it either way (B-78). `okolos:collect` is set at the end
 * of the first scan, after every listener is registered, so its presence means the script
 * is listening.
 */
export async function expectScriptReady(where: Pick<Worker, 'evaluate'>): Promise<void> {
  await expect
    .poll(
      () =>
        where
          .evaluate(() => performance.getEntriesByName('okolos:collect').length)
          .catch(() => 0),
      { timeout: SURFACE_MOUNT_MS, message: 'the content script never ran in this document' },
    )
    .toBeGreaterThan(0)
}

/** The frame of `page` whose address starts with `origin`, once it is attached. */
export async function frameAt(page: Page, origin: string): Promise<Frame> {
  let found: Frame | undefined
  await expect
    .poll(
      () => {
        found = page.frames().find((frame) => frame.url().startsWith(origin))
        return found !== undefined
      },
      { timeout: SURFACE_MOUNT_MS, message: `no frame at ${origin}` },
    )
    .toBe(true)
  return found as Frame
}
