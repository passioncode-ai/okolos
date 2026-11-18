import type { PageCandidates } from '@okolos/contracts'
import { collectFrom, type CollectOptions, type PageView } from '@okolos/core-collect'

export { DEFAULT_BUDGET, type Budget, type CollectOptions } from '@okolos/core-collect'

/**
 * The collector over the live document: the DOM adapter of `@okolos/core-collect` (B-221).
 *
 * The walk, the budget and every rule about what is a candidate live in the package, so
 * PassionView gets the same verdict from a tree it builds without a DOM. What stays here is
 * how a document answers the package's questions, read lazily so nothing is copied: a
 * computed style is asked for only when the walk needs it, as before.
 */
export function collect(doc: Document, options: CollectOptions): PageCandidates {
  return collectFrom(domView(doc), options)
}

function domView(doc: Document): PageView<Element> {
  const window = doc.defaultView
  return {
    *comments() {
      // Comments never render anywhere, which is why roughly seven in ten real
      // injections live in them and in metadata rather than behind CSS.
      const walker = doc.createTreeWalker(doc, NodeFilter.SHOW_COMMENT)
      while (walker.nextNode()) yield { text: walker.currentNode.nodeValue ?? '' }
    },
    root: () => doc.documentElement,
    children: (element) => element.children,
    parent: (element) => element.parentElement,
    tag: (element) => element.tagName,
    attribute: (element, name) => element.getAttribute(name),
    attributeNames: (element) => element.getAttributeNames(),
    ownText,
    textContent: (element) => element.textContent ?? '',
    // A template's children live in a document fragment, not in the element.
    templateText: (element) => (element as HTMLTemplateElement).content?.textContent ?? '',
    style: (element) => (window ? window.getComputedStyle(element) : null),
    idIsUnique: (element, id) => {
      // The id has passed the collector's shape check, so the selector needs no escaping.
      try {
        return element.ownerDocument.querySelectorAll(`#${id}`).length === 1
      } catch {
        return false
      }
    },
  }
}

/** Text belonging to this element itself, not to its descendants. */
function ownText(element: Element): string {
  let text = ''
  for (const node of element.childNodes) {
    if (node.nodeType === 3) text += node.nodeValue ?? ''
  }
  return text
}
