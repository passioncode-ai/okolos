import type {
  CarrierKind,
  CharClass,
  ConcealmentTechnique,
  HiddenTextCandidate,
  PageCandidates,
} from '@okolos/contracts'

import type { PageView, StyleValues } from './view.js'

/**
 * The collector runs where the layout is and hands out candidates, not a
 * document. Serialising a page with its computed styles across the process
 * boundary would cost megabytes per tab and give the background context a copy
 * of everything the user reads — which is the arrangement this product exists
 * to avoid.
 */

export interface Budget {
  /** Elements to visit before giving up. The real budget: deterministic, same on every machine. */
  readonly maxNodes: number
  /**
   * Milliseconds to spend, measured by the caller's clock — a **hang guard**, not a budget.
   *
   * It was 8, and it decided how much of a page got read. A wall-clock ceiling makes that
   * decision a function of machine load, and on a busy machine eight milliseconds is one
   * scheduler slice: the collector gave up on a **seven-node page**, returned zero
   * candidates, and the content script journalled "could not finish" and showed nothing.
   * Four CI runs failed that way before the report was detailed enough to say so — the
   * measure printed `8.1 ms`, which is the ceiling, and the pipeline behind it never ran.
   *
   * This project already wrote the rule down, on the day it gated bundle *bytes* and
   * refused to gate milliseconds: a deterministic ceiling may decide things, a wall-clock
   * one may not, because it is a claim about the runner rather than about the work. The same
   * applies inside the product, where the cost of getting it wrong is a security check that
   * abandons itself exactly when the machine is under strain.
   *
   * So the number is now what it was always described as — protection against making a page
   * unresponsive. 500 ms is far above any honest scan (the product's own median is 1–2 ms,
   * and 4000 nodes measure in the tens) and far below a hang a person would notice as one.
   */
  readonly maxMillis: number
  /** Candidates to report from one page. */
  readonly maxCandidates: number
  /** Characters kept per candidate. */
  readonly maxTextLength: number
}

export const DEFAULT_BUDGET: Budget = {
  maxNodes: 5000,
  maxMillis: 500,
  maxCandidates: 50,
  maxTextLength: 2000,
}

export interface CollectOptions {
  readonly url: string
  readonly frameId: number
  readonly budget: Budget
  /** Milliseconds since the scan started. Injected so tests own the clock. */
  readonly elapsed: () => number
}

const ZERO_WIDTH = /[\u200B-\u200D\u2060-\u2064\uFEFF]/u
const UNICODE_TAG = /[\u{E0000}-\u{E007F}]/u
const RTL_OVERRIDE = /[\u202A-\u202E\u2066-\u2069]/u

/** Elements whose text is code or styling, not something anyone reads. */
const NOT_PROSE = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT'])

/** Carriers read from attributes; they share one part of the candidate ceiling (B-187). */
const ATTRIBUTE_KINDS: ReadonlySet<CarrierKind> = new Set<CarrierKind>([
  'alt',
  'title',
  'aria-label',
  'meta',
  'data-attr',
])

const ATTRIBUTE_CARRIERS: ReadonlyArray<{ attr: string; carrier: CarrierKind }> = [
  { attr: 'alt', carrier: 'alt' },
  { attr: 'title', carrier: 'title' },
  { attr: 'aria-label', carrier: 'aria-label' },
]

/**
 * The collector, over any view of a page: the live document in the extension, a plain tree
 * in PassionView. Same walk, same budget, same candidates (B-221).
 */
export function collectFrom<N>(view: PageView<N>, options: CollectOptions): PageCandidates {
  const { budget } = options
  const candidates: HiddenTextCandidate[] = []
  let nodeCount = 0
  let truncated = false

  /**
   * The node budget, shared between two walks that must not starve each other.
   *
   * `nodeCount` is one counter across both, and the comment walk runs first — so a page
   * with 6000 `<!-- -->` in its `<head>` spent the whole allowance before the element
   * walk began. Measured: `candidates=0, nodeCount=5001, truncated=true`, and the same
   * injection with the comments removed was found. Six kilobytes of markup blinded the
   * scan (B-40).
   *
   * Half each, and the element walk inherits whatever the comment walk did not use. On an
   * ordinary page the comments are few and nothing changes; on a hostile one, the half
   * that carries the rendered document is still examined.
   *
   * **Both allowances are shared, and both had to be split.** Skipping empty comments
   * fixed the node half and the attack simply moved down one floor: 6000 `<!--x-->` cost
   * one node each and filled the *candidate* ceiling instead, so the element walk ran with
   * nothing left to report. One carrier class must not be able to spend the whole
   * allowance for all the others.
   */
  const nodeShare = Math.floor(budget.maxNodes / 2)
  const candidateShare = Math.floor(budget.maxCandidates / 2)
  /**
   * The third carrier class that could spend the allowance for the others: attributes.
   *
   * Every non-empty `alt`, `title`, `aria-label`, `meta` and `data-*` is a candidate, and
   * ordinary pages carry hundreds. Measured in Chromium on Wikipedia: the scan stopped after
   * 83 elements with 50 harmless attribute candidates and never reached a hidden instruction
   * at the end of the page; sixty `<img alt>` in front of one do the same on purpose (B-187).
   *
   * So attributes keep a quarter of the ceiling, the walk goes on while hidden text still has
   * room, and an attribute refused for want of room says the scan was cut short.
   */
  const attributeShare = Math.floor(budget.maxCandidates / 4)
  let attributeCount = 0

  const outOfBudget = (nodeLimit: number, candidateLimit: number): boolean =>
    nodeCount >= nodeLimit ||
    candidates.length >= candidateLimit ||
    options.elapsed() >= budget.maxMillis

  /**
   * Adds a candidate, or refuses and says the scan was cut short.
   *
   * The ceiling used to be checked once per **node**, at the top of each walk — and one
   * node can produce candidates without limit. A single element carrying 20 000 `data-*`
   * attributes yielded 20 000 candidates, 40.3 MB of payload and 84.9 ms against an 8 ms
   * budget, with `truncated: false`: the memory ceiling walked around, and the verdict
   * reporting a complete scan of a page it had not finished. A page can do that twice a
   * second, in every frame (B-41).
   *
   * So the ceiling is applied here, where candidates are actually made, and refusing sets
   * `truncated` — because a scan that stopped early and says it did not is worse than one
   * that stops early.
   */
  const add = (
    text: string,
    locator: string,
    carrier: CarrierKind,
    concealment: ConcealmentTechnique[],
    key: string | undefined,
  ): void => {
    const trimmed = text.trim()
    if (!trimmed) return
    if (candidates.length >= budget.maxCandidates) {
      truncated = true
      return
    }
    if (ATTRIBUTE_KINDS.has(carrier)) {
      if (attributeCount >= attributeShare) {
        truncated = true
        return
      }
      attributeCount += 1
    }
    candidates.push({
      locator,
      text: trimmed.slice(0, budget.maxTextLength),
      concealment,
      carrier,
      charClasses: charClassesOf(trimmed),
      ...(key === undefined ? {} : { key }),
    })
  }

  // Comments never render anywhere, which is why roughly seven in ten real
  // injections live in them and in metadata rather than behind CSS.
  for (const comment of view.comments()) {
    /**
     * An empty comment cannot carry anything, so examining it is free and counting it is
     * not honest: the budget bounds the work of *examining*, and there is none here. Six
     * thousand of them is the cheapest way to spend an allowance meant for a document.
     */
    if (comment.text.trim() === '') continue
    nodeCount += 1
    if (outOfBudget(nodeShare, candidateShare)) {
      truncated = true
      break
    }
    add(comment.text, 'comment()', 'html-comment', ['non-rendered'], comment.key)
  }

  /**
   * Elements in document order, each with whether it is the head or inside it.
   *
   * The order is the one a `TreeWalker` over elements gives, which is what the collector
   * walked before it took a view; carrying the head flag down the walk answers "is this the
   * head or inside it" for every element without climbing to the root each time.
   *
   * The browser's own stylesheet gives `<head>` and everything in it `display: none`, so the
   * title a person reads on the tab was a `display-none` candidate on every page in Chrome, and
   * spent a slot of the ceiling doing it (B-193). Nothing in the head renders by design, so
   * `display: none` there conceals nothing; its attributes and `meta` are still read.
   */
  const rootNode = view.root()
  const pending: Array<{ node: N; head: boolean }> = rootNode === null ? [] : [{ node: rootNode, head: false }]

  while (pending.length > 0) {
    const { node, head: parentInHead } = pending.pop() as { node: N; head: boolean }
    nodeCount += 1
    if (outOfBudget(budget.maxNodes, budget.maxCandidates)) {
      truncated = true
      break
    }

    const tag = view.tag(node).toUpperCase()
    const head = parentInHead || tag === 'HEAD'
    const key = view.key?.(node)
    const locator = (): string => locatorFor(view, node)

    if (!NOT_PROSE.has(tag)) {
      for (const { attr, carrier } of ATTRIBUTE_CARRIERS) {
        const value = view.attribute(node, attr)
        if (value) add(value, locator(), carrier, ['non-rendered'], key)
      }
      if (tag === 'META') {
        const content = view.attribute(node, 'content')
        if (content) add(content, locator(), 'meta', ['non-rendered'], key)
      }
      for (const name of view.attributeNames(node)) {
        // Once the ceiling is reached, reading the rest of an element's attributes buys
        // nothing: `add` will refuse every one. The 20 000-attribute element cost 84.9 ms
        // mostly here, in `getAttribute` calls whose results were about to be discarded.
        if (attributeCount >= attributeShare) {
          truncated = true
          break
        }
        if (!name.startsWith('data-')) continue
        const value = view.attribute(node, name)
        if (value) add(value, locator(), 'data-attr', ['non-rendered'], key)
      }
    }

    if (tag === 'TEMPLATE') {
      // A template's children live in a document fragment, not in the element:
      // textContent on the element itself is empty, which is exactly why this
      // carrier is a comfortable hiding place.
      add(view.templateText(node), locator(), 'template', ['non-rendered'], key)
    } else if (tag === 'SCRIPT') {
      if (view.attribute(node, 'type') === 'application/ld+json') {
        add(view.textContent(node), locator(), 'json-ld', ['non-rendered'], key)
      }
    } else if (!NOT_PROSE.has(tag) && !head) {
      const concealment = concealmentOf(view, node)
      if (concealment.length > 0) {
        add(view.ownText(node), locator(), 'text-node', concealment, key)
      }
    }

    const children = [...view.children(node)]
    for (let i = children.length - 1; i >= 0; i -= 1) {
      pending.push({ node: children[i] as N, head })
    }
  }

  return {
    url: stripQueryAndFragment(options.url),
    frameId: options.frameId,
    nodeCount,
    candidates,
    truncated,
  }
}

/**
 * Query strings and fragments carry session tokens and password-reset links.
 * They are removed here, in the page, before anything crosses a boundary —
 * one place, not every caller downstream.
 */
function stripQueryAndFragment(raw: string): string {
  try {
    const url = new URL(raw)
    return `${url.origin}${url.pathname}`
  } catch {
    return raw
  }
}

/**
 * How the text is being kept from the reader.
 *
 * Known limits, stated rather than hidden: colours are compared as computed
 * values, so text over a background image or a gradient is not caught here,
 * and a parent that clips its children is only seen through the child's own
 * computed style. Both are handled by the later stages rather than pretended
 * away.
 */
function concealmentOf<N>(view: PageView<N>, node: N): ConcealmentTechnique[] {
  const style = view.style(node)
  if (!style) return []
  const found: ConcealmentTechnique[] = []

  if (style.display === 'none') found.push('display-none')
  if (style.visibility === 'hidden' || style.visibility === 'collapse') {
    found.push('visibility-hidden')
  }
  if (parseFloat(style.opacity || '1') === 0) found.push('opacity-zero')
  if (parseFloat(style.fontSize || '16') === 0) found.push('font-size-zero')
  if (style.clipPath === 'inset(50%)' || style.clip === 'rect(0px, 0px, 0px, 0px)') {
    found.push('clip')
  }
  if (isOffscreen(style)) found.push('offscreen')
  if (view.attribute(node, 'aria-hidden') === 'true') found.push('aria-hidden')
  if (sameColour(style.color, effectiveBackground(view, node))) found.push('color-on-color')

  return found
}

/**
 * Backgrounds do not inherit: an element painted white on a white parent has a
 * transparent background of its own. The classic trick is exactly that shape —
 * white text in a span inside a white div — so the ancestors have to be walked
 * to find the colour the reader actually sees behind the text.
 */
function effectiveBackground<N>(view: PageView<N>, element: N): string {
  let node: N | null = element
  let depth = 0
  while (node !== null && depth < 10) {
    const background = view.style(node)?.backgroundColor
    if (background && background !== 'transparent' && background !== 'rgba(0, 0, 0, 0)') {
      return background
    }
    node = view.parent(node)
    depth += 1
  }
  return ''
}

function isOffscreen(style: StyleValues): boolean {
  if (style.position !== 'absolute' && style.position !== 'fixed') return false
  const left = parseFloat(style.left || '0')
  const top = parseFloat(style.top || '0')
  return left <= -1000 || top <= -1000
}

function sameColour(color: string, background: string): boolean {
  if (!color || !background) return false
  if (background === 'transparent' || background === 'rgba(0, 0, 0, 0)') return false
  return normaliseColour(color) === normaliseColour(background)
}

function normaliseColour(value: string): string {
  return value.replace(/\s+/g, '').toLowerCase()
}

function charClassesOf(text: string): CharClass[] {
  const classes: CharClass[] = []
  if (ZERO_WIDTH.test(text)) classes.push('zero-width')
  if (UNICODE_TAG.test(text)) classes.push('unicode-tag')
  if (RTL_OVERRIDE.test(text)) classes.push('rtl-override')
  return classes
}

/**
 * An id that can be trusted to name one element.
 *
 * Duplicate ids are invalid HTML and entirely ordinary on the pages this product
 * reads; a hostile one can have as many as it likes, so the view is asked whether it
 * names one element. The shape check comes first so the selector a view builds from it
 * is always valid without escaping — an id the check rejects simply falls through to
 * the positional path, which is correct rather than clever.
 */
const SAFE_ID = /^[A-Za-z][\w-]*$/

/**
 * Where the node is, precisely enough that the executor edits *that* node.
 *
 * The first version joined tag names and stopped after five levels, so an injection
 * in the seventh `div > p` of a page produced `html > body > div > p` — a selector
 * matching the first paragraph on the page. `Sanitiser` resolves it with
 * `querySelector`, which returns the first match, so the product emptied an innocent
 * paragraph, left the injection in place, and marked the wrong element as
 * neutralised. Every fixture in `sanitize.test.ts` used an `id`, and the corpus
 * carries hand-written `:nth-child(…)` selectors that the collector never produced,
 * so nothing in the suite ever saw an ambiguous locator.
 *
 * So: `nth-of-type` at every step and no depth cap, walking to the document element.
 * An id short-circuits it, but only one that provably names a single element. The
 * result is longer and it is shown to the user in the inspector — a locator that
 * points at the wrong node is worse than an ugly one.
 */
function locatorFor<N>(view: PageView<N>, element: N): string {
  const parts: string[] = []
  let node: N | null = element

  while (node !== null) {
    const tag = view.tag(node).toLowerCase()
    const id = view.attribute(node, 'id')
    if (id && SAFE_ID.test(id) && view.idIsUnique(node, id)) {
      parts.unshift(`${tag}#${id}`)
      return parts.join(' > ')
    }

    const parent: N | null = view.parent(node)
    if (parent === null) {
      // The document element: one of its kind by definition, so no index.
      parts.unshift(tag)
      break
    }

    let index = 0
    for (const sibling of view.children(parent)) {
      if (view.tag(sibling).toLowerCase() === tag) index += 1
      if (sibling === node) break
    }
    parts.unshift(`${tag}:nth-of-type(${index})`)
    node = parent
  }

  return parts.join(' > ')
}
