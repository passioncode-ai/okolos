import { describe, expect, it } from 'vitest'
import type { CarrierKind, ConcealmentTechnique, HiddenTextCandidate, PageCandidates, Verdict } from '@okolos/contracts'
import { classifyUndecided, detectHidden } from '@okolos/core-injection'

import positives from '../../../corpora/injections/positives.json' with { type: 'json' }
import negatives from '../../../corpora/injections/negatives.json' with { type: 'json' }
import { buildSnapshot, renderLine, snapshotVerdict, type AxNode } from '@okolos/core-snapshot'

/*
 * The injection corpus through the snapshot, at the level of the function
 * (REQ-55). The real check runs the same corpus as HTML fixtures in Chrome
 * (node N-011); here the detector's own output decides what is hidden, the way
 * the probe's locators do once `DOM.describeNode` has turned them into node ids.
 */

interface Case {
  readonly name: string
  readonly candidate: HiddenTextCandidate
}

const positiveCases = positives.cases as Case[]
const negativeCases = negatives.cases as Case[]

const KEY = new Uint8Array(32).fill(7)
const ctx = { now: '2026-10-27T00:00:00.000Z', newId: () => 'v' }
/** The backend id the probe's locator resolves to, and the node carrying the text under it. */
const ELEMENT = 10
const CARRIER = 11

function pageOf(candidate: HiddenTextCandidate): PageCandidates {
  return { url: 'https://example.test/article', frameId: 0, nodeCount: 100, candidates: [candidate], truncated: false }
}

/** Where Chrome's tree carries each kind of text: a text node, or the name of an element. */
function carrierRole(candidate: HiddenTextCandidate): string {
  switch (candidate.carrier) {
    case 'alt':
      return 'img'
    case 'title':
      return 'link'
    case 'aria-label':
      return 'button'
    default:
      return 'StaticText'
  }
}

function articleWith(candidate: HiddenTextCandidate): AxNode[] {
  return [
    { nodeId: 'root', role: { value: 'RootWebArea' }, backendDOMNodeId: 1, childIds: ['h', 'el'] },
    { nodeId: 'h', parentId: 'root', role: { value: 'heading' }, name: { value: 'Visible article' }, backendDOMNodeId: 2 },
    { nodeId: 'el', parentId: 'root', role: { value: 'generic' }, backendDOMNodeId: ELEMENT, childIds: ['t'] },
    { nodeId: 't', parentId: 'el', role: { value: carrierRole(candidate) }, name: { value: candidate.text }, backendDOMNodeId: CARRIER },
  ]
}

/** What the probe hands the snapshot: the node ids behind the verdicts' locators. */
function hiddenBy(verdicts: readonly Verdict[], candidate: HiddenTextCandidate): Set<number> {
  const hidden = new Set<number>()
  for (const v of verdicts) for (const e of v.evidence) if (e.locator === candidate.locator) hidden.add(ELEMENT)
  return hidden
}

function collapsed(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

describe('every positive of the corpus, hidden in the tree, is absent from what the agent reads', () => {
  for (const c of positiveCases) {
    it(c.name, () => {
      const verdicts = detectHidden(pageOf(c.candidate), ctx)
      const hidden = hiddenBy(verdicts, c.candidate)
      expect(hidden.has(ELEMENT), 'the detector named the element').toBe(true)

      const snapshot = buildSnapshot(articleWith(c.candidate), { hidden, taskKey: KEY })
      const out = snapshot.lines.map(renderLine).join('\n')
      expect(out).not.toContain(collapsed(c.candidate.text).slice(0, 24))
      expect(snapshot.lines.map((l) => l.name)).toEqual(['Visible article'])
      expect(snapshot.hiddenRemoved).toBe(2)
      expect(snapshotVerdict({ verdicts, truncated: false, unresolved: 0 })).toMatchObject({ level: 'finding' })
    })
  }
})

describe('no negative of the corpus is cut', () => {
  for (const c of negativeCases) {
    it(c.name, () => {
      const verdicts = detectHidden(pageOf(c.candidate), ctx)
      const snapshot = buildSnapshot(articleWith(c.candidate), { hidden: hiddenBy(verdicts, c.candidate), taskKey: KEY })
      expect(snapshot.hiddenRemoved).toBe(0)
      // A one-character text (a decorative glyph) is dropped as text without words, not cut.
      const shown = collapsed(c.candidate.text)
      const present = snapshot.lines.map((l) => l.name).some((n) => n.startsWith(shown.slice(0, 60)))
      expect(present || shown.length < 2).toBe(true)
      expect(snapshotVerdict({ verdicts, truncated: false, unresolved: 0 })).toEqual({ level: 'clean', findings: [] })
    })
  }
})

/*
 * The seam with the detectors (N-001, second round): the finding an agent gets is
 * built from `detail`, which the detectors write as free-form strings. If either
 * stage changes how it writes `concealment` or `carrier`, the finding goes quietly
 * empty; this test is what makes that loud.
 */
describe('a finding built from the detectors’ real output', () => {
  /*
   * Records, so a member added to a contract type without a line here fails to
   * compile. Two positives carry values outside these sets (`alt-text` for `alt`,
   * `font-zero` for `font-size-zero`); the collector never produces them, and the
   * finding drops them as the closed sets require. They are named here so that a
   * new off-type case fails this test instead of passing it empty.
   */
  const CONCEALMENT: Readonly<Record<ConcealmentTechnique, true>> = {
    'color-on-color': true, 'display-none': true, 'visibility-hidden': true, 'opacity-zero': true, clip: true,
    offscreen: true, 'font-size-zero': true, 'aria-hidden': true, 'non-rendered': true,
  }
  const CARRIER: Readonly<Record<CarrierKind, true>> = {
    'text-node': true, 'html-comment': true, meta: true, alt: true, title: true, 'aria-label': true,
    'data-attr': true, 'json-ld': true, template: true,
  }
  const OFF_TYPE = ['инструкция в alt-тексте', 'попытка вызова инструмента']
  const inType = (c: Case): boolean =>
    Object.hasOwn(CARRIER, c.candidate.carrier) && c.candidate.concealment.every((t) => Object.hasOwn(CONCEALMENT, t))

  it('the corpus names every case whose values are outside the contract', () => {
    expect(positiveCases.filter((c) => !inType(c)).map((c) => c.name)).toEqual(OFF_TYPE)
  })

  function expectFilled(verdicts: readonly Verdict[], c: Case, stage: string): void {
    const result = snapshotVerdict({ verdicts, truncated: false, unresolved: 0 })
    if (!('level' in result)) throw new Error('refused')
    expect(result.findings.length).toBe(verdicts.length)
    const concealment = c.candidate.concealment.filter((t) => Object.hasOwn(CONCEALMENT, t))
    const carrier = Object.hasOwn(CARRIER, c.candidate.carrier) ? c.candidate.carrier : null
    for (const finding of result.findings) {
      for (const e of finding.evidence) {
        expect(e.stage).toBe(stage)
        expect(e.concealment).toEqual(concealment)
        expect(e.carrier).toBe(carrier)
        // Filled for every case whose corpus values are in the contract.
        expect(!inType(c) || (e.concealment.length > 0 && e.carrier !== null)).toBe(true)
      }
    }
  }

  it('from stage 1 carries the concealment and the carrier of every positive', () => {
    let seen = 0
    for (const c of positiveCases) {
      const verdicts = detectHidden(pageOf(c.candidate), ctx)
      seen += verdicts.length
      expectFilled(verdicts, c, 'rules')
    }
    expect(seen).toBeGreaterThanOrEqual(positiveCases.length)
  })

  it('from stage 3 carries them too', async () => {
    const host = { available: () => true, score: async () => 0.9 }
    let seen = 0
    for (const c of positiveCases) {
      const verdicts = await classifyUndecided(pageOf(c.candidate), [], host, ctx)
      seen += verdicts.length
      expectFilled(verdicts, c, 'model')
    }
    expect(seen).toBe(positiveCases.length)
  })
})
