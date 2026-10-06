import type { ConcealmentTechnique, Verdict } from '@okolos/contracts'
import { detectHidden } from '@okolos/core-injection'

import { collect, DEFAULT_BUDGET } from './content/collect.js'

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
 * Same collector, same rules, same budget as the extension: one detector, two
 * readers, so the agent is never protected by a weaker copy.
 */

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
}

export function runProbe(
  doc: Document,
  options: { readonly url: string; readonly now: string; readonly elapsed: () => number },
): ProbeResult {
  const page = collect(doc, { url: options.url, frameId: 0, budget: DEFAULT_BUDGET, elapsed: options.elapsed })
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
    let element: Element | null = null
    try {
      element = doc.querySelector(locator)
    } catch {
      element = null // a locator the page made unparseable is reported, not thrown
    }
    if (element === null) unresolved++
    else if (!cut.includes(element)) cut.push(element)
  }

  return { cut, verdicts, candidates: page.candidates.length, truncated: page.truncated, unresolved }
}
