import type { ConcealmentTechnique, Verdict } from '@okolos/contracts'
import { detectHidden } from '@okolos/core-injection'

import { collect, type Budget } from './content/collect.js'

/**
 * The extension's own detector, run for Okolos Bridge inside an agent's page.
 *
 * Okolos Agent evaluates this in an isolated world of the page it is about to
 * snapshot (bundled into one script by `tools/build-agent-probe.mjs`). It answers
 * one question: which elements must never reach the agent. The bridge then maps
 * those elements to the accessibility tree and cuts them with everything under
 * them (`@okolos/core-snapshot`).
 *
 * Two rules decide what is cut, and they differ on purpose:
 *
 *   - **Text hidden from people by rendering is cut whether or not it reads as an
 *     instruction.** An agent working for a person has no business reading what
 *     that person cannot see; the injection rules only decide how loudly to say
 *     so. This is the invariant the vision is built on — invisibility cannot be
 *     removed without showing the text to a human.
 *   - **Text in attributes and metadata is cut only when the rules flag it.** An
 *     `aria-label` or an `alt` is the accessible name of a real control; cutting
 *     every one would blind the agent to the page's own buttons. One the rules
 *     flag takes its element with it.
 *
 * Same collector, same rules as the extension: one detector, two readers, so the agent is
 * never protected by a weaker copy. The budget is the agent's own (AGENT_BUDGET).
 */

/**
 * The probe's budget: a whole page, not the person's quick scan.
 *
 * The person's scan (`DEFAULT_BUDGET`: 5000 elements, 50 candidates) keeps a page responsive
 * while someone uses it, and stopping early there only means a weaker warning. Here a stop
 * means `cleaning_incomplete`, a refusal: with that budget the probe stopped on Wikipedia,
 * Hacker News, gov.uk, MDN and GitHub (round 6 of the N-003 certification, measured in
 * Chromium), because every non-empty `alt`, `title`, `aria-label` and `data-*` counts as a
 * candidate. The page's scripts are paused while the probe runs and nobody waits on the page,
 * so the probe can read all of it; the ceilings stay as a guard against a pathological page,
 * which is still refused rather than read in part. Measured with this budget: the English Wikipedia article on the United States (21 955 elements, 11 354 candidates) in 291 ms, untruncated.
 */
export const AGENT_BUDGET: Budget = {
  maxNodes: 200_000,
  maxMillis: 5_000,
  maxCandidates: 50_000,
  maxTextLength: 2000,
}

const RENDERING_CONCEALMENT: ReadonlySet<ConcealmentTechnique> = new Set([
  'color-on-color',
  'display-none',
  'visibility-hidden',
  'opacity-zero',
  'clip',
  'offscreen',
  'font-size-zero',
])

export interface ProbeResult {
  /** Elements to cut from the agent's view, each once. */
  readonly cut: readonly Element[]
  /** Verdicts the injection rules produced on this page. */
  readonly verdicts: readonly Verdict[]
  /** Hidden-text candidates the collector found, cut or not. */
  readonly candidates: number
  /** True when the collector hit its budget: the cut list may be incomplete, and the agent is told so. */
  readonly truncated: boolean
  /** Locators that no longer resolved to an element when the cut list was built. */
  readonly unresolved: number
  /** How many verdicts the rules produced; `verdicts` carries at most MAX_PROBE_VERDICTS of them. */
  readonly verdictsTotal: number
}

/**
 * The most verdicts the probe hands across CDP. With the whole-page budget a page could plant tens
 * of thousands of flagged attributes, and the verdicts that crossed CDP measured 40 to 96 MB, enough
 * to crash the renderer (round 7 of the N-003 certification). A finding is built from closed sets,
 * so a few hundred verdicts already carry every distinct one; the rest only repeat them.
 */
export const MAX_PROBE_VERDICTS = 200

/** A comment's locator: comments have no element and no node in the accessibility tree, so nothing to cut. */
const COMMENT_LOCATOR = 'comment()'

export function runProbe(
  doc: Document,
  options: { readonly url: string; readonly now: string; readonly elapsed: () => number },
): ProbeResult {
  const page = collect(doc, { url: options.url, frameId: 0, budget: AGENT_BUDGET, elapsed: options.elapsed })
  let next = 0
  const verdicts = detectHidden(page, { now: options.now, newId: () => `probe-${++next}` })

  const locators = new Set<string>()
  for (const candidate of page.candidates) {
    if (candidate.carrier === 'text-node' && candidate.concealment.some((c) => RENDERING_CONCEALMENT.has(c))) {
      locators.add(candidate.locator)
    }
  }
  for (const verdict of verdicts) {
    for (const evidence of verdict.evidence) {
      if (evidence.locator) locators.add(evidence.locator)
    }
  }

  const cut: Element[] = []
  let unresolved = 0
  for (const locator of locators) {
    // A hang guard over the lookups too (round 7): they ran unbounded after the collector.
    if (options.elapsed() > AGENT_BUDGET.maxMillis) {
      return { cut, verdicts: verdicts.slice(0, MAX_PROBE_VERDICTS), candidates: page.candidates.length, truncated: true, unresolved, verdictsTotal: verdicts.length }
    }
    // A flagged comment was counted as an element lost, which refused every such page (round 7).
    if (locator === COMMENT_LOCATOR) continue
    let element: Element | null = null
    try {
      element = doc.querySelector(locator)
    } catch {
      element = null // a locator the page made unparseable is reported, not thrown
    }
    if (element === null) unresolved++
    else if (!cut.includes(element)) cut.push(element)
  }

  return {
    cut,
    verdicts: verdicts.slice(0, MAX_PROBE_VERDICTS),
    candidates: page.candidates.length,
    truncated: page.truncated,
    unresolved,
    verdictsTotal: verdicts.length,
  }
}
