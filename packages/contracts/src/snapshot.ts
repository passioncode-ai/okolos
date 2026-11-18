/**
 * What a collector hands to a detector. Never a DOM, never a document — a
 * collector runs where the layout is, extracts candidates, and passes those.
 * Serialising a whole page across the process boundary would cost megabytes
 * and hand the background context data it has no business holding.
 */

/** How the text was kept away from human eyes while staying in the DOM. */
export type ConcealmentTechnique =
  | 'color-on-color'
  | 'display-none'
  | 'visibility-hidden'
  | 'opacity-zero'
  | 'clip'
  | 'offscreen'
  | 'font-size-zero'
  | 'aria-hidden'
  | 'non-rendered'

/** Which part of the document carried it. */
export type CarrierKind =
  | 'text-node'
  | 'html-comment'
  | 'meta'
  | 'alt'
  | 'title'
  | 'aria-label'
  | 'data-attr'
  | 'json-ld'
  | 'template'

/** Character classes that survive rendering but change what a model reads. */
export type CharClass = 'zero-width' | 'unicode-tag' | 'rtl-override' | 'private-use'

export interface HiddenTextCandidate {
  readonly locator: string
  /** Truncated by the collector; a candidate is a sample, not a payload. */
  readonly text: string
  readonly concealment: readonly ConcealmentTechnique[]
  readonly carrier: CarrierKind
  readonly charClasses: readonly CharClass[]
  /**
   * The caller's own name for the node the candidate came from, echoed unchanged and never
   * interpreted (B-222). PassionView passes its `backendNodeId` in the abstract tree it hands
   * `@okolos/core-collect`, and maps a finding back to its snapshot by it. Absent when the
   * input carried none, which is how the extension's DOM adapter calls the collector: a key
   * is never guessed.
   */
  readonly key?: string
}

/**
 * A stable name for one candidate: its locator and a hash of its text (B-222).
 *
 * The locator alone is not enough, because one element yields two candidates when it carries
 * text in an attribute and hidden text of its own, and a caller that marks or cuts what was
 * found has to tell them apart. The hash is FNV-1a over the UTF-16 code units of the text the
 * candidate reports, so the same candidate gets the same name in every runtime and on every
 * run; it is a name, not a secret, and it is not meant to resist anyone choosing a collision.
 */
export function candidateSpanId(candidate: Pick<HiddenTextCandidate, 'locator' | 'text'>): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < candidate.text.length; i += 1) {
    hash ^= candidate.text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `${candidate.locator}@${hash.toString(16).padStart(8, '0')}`
}

export interface PageCandidates {
  /**
   * Origin and path only. Query strings and fragments carry tokens, and they
   * are stripped in the page before this ever crosses a boundary.
   */
  readonly url: string
  readonly frameId: number
  /** Size of the traversal, so a verdict can say how much it actually saw. */
  readonly nodeCount: number
  readonly candidates: readonly HiddenTextCandidate[]
  /** True when the traversal hit its budget: the verdict is partial and says so. */
  readonly truncated: boolean
}
