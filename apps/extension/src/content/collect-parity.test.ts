/** @vitest-environment happy-dom */
import type { HiddenTextCandidate } from '@okolos/contracts'
import { collectFrom, DEFAULT_BUDGET, treeView, type AbstractNode, type CommentView } from '@okolos/core-collect'
import { describe, expect, it } from 'vitest'

import carriers from '../../../../corpora/collect/carriers.json' with { type: 'json' }
import { collect } from './collect.js'

/**
 * The live document and a plain tree of the same page give the same candidates (B-221).
 *
 * PassionView calls the collector with a tree it builds without a DOM; the product calls it
 * over the document. The rules are tested once, over the document, in `collect.test.ts`; this
 * file is what lets the tree inherit them: every page below is collected both ways and the
 * answers compared. The tree is built here the way a caller would build it, from the computed
 * style of every element.
 */

const STYLE_KEYS = [
  'display',
  'visibility',
  'opacity',
  'fontSize',
  'clipPath',
  'clip',
  'position',
  'left',
  'top',
  'color',
  'backgroundColor',
] as const

function toTree(element: Element): AbstractNode {
  const computed = getComputedStyle(element)
  const style = Object.fromEntries(STYLE_KEYS.map((key) => [key, computed[key] ?? '']))
  const attributes = Object.fromEntries(element.getAttributeNames().map((name) => [name, element.getAttribute(name) ?? '']))
  let text = ''
  const comments: CommentView[] = []
  for (const node of element.childNodes) {
    if (node.nodeType === 3) text += node.nodeValue ?? ''
    if (node.nodeType === 8) comments.push({ text: node.nodeValue ?? '' })
  }
  const template = element instanceof HTMLTemplateElement ? element.content.textContent ?? '' : undefined
  return {
    tag: element.tagName,
    attributes,
    text,
    comments,
    style,
    children: [...element.children].map(toTree),
    ...(template === undefined ? {} : { template }),
  }
}

const options = {
  url: 'https://example.test/a?b=c',
  frameId: 0,
  budget: DEFAULT_BUDGET,
  elapsed: () => 0,
}

/** Compared as sets: the tree walks comments element by element (see `AbstractNode.comments`). */
const sorted = (candidates: readonly HiddenTextCandidate[]) =>
  candidates.map((candidate) => JSON.stringify(candidate)).sort()

const pages: Array<[string, string, string?]> = (carriers.cases as Array<{ name: string; body: string; head?: string }>).map(
  (page): [string, string, string?] => (page.head === undefined ? [page.name, page.body] : [page.name, page.body, page.head]),
)

describe('the document and a tree of it say the same thing', () => {
  for (const [name, body, head] of pages) {
    it(name, () => {
      document.head.innerHTML = head ?? ''
      document.body.innerHTML = body
      const fromDocument = collect(document, options)
      const root = document.documentElement
      const outside: CommentView[] = []
      for (const node of document.childNodes) {
        if (node.nodeType === 8) outside.push({ text: node.nodeValue ?? '' })
      }
      const fromTree = collectFrom(treeView(toTree(root), outside), options)

      expect(fromDocument.candidates.length, 'the page must give at least one candidate').toBeGreaterThan(0)
      expect(sorted(fromTree.candidates)).toEqual(sorted(fromDocument.candidates))
      expect(fromTree.nodeCount).toBe(fromDocument.nodeCount)
      expect(fromTree.truncated).toBe(fromDocument.truncated)
    })
  }
})
