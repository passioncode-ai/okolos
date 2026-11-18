import type { CommentView, PageView, StyleValues } from './view.js'

/**
 * A page as a plain tree, for a caller that has no DOM (B-221).
 *
 * PassionView builds it from `DOMSnapshot.captureSnapshot` and `DOM.getDocument`; any caller
 * can build it from anything that knows the page's elements and their computed style. Only
 * element nodes are nodes here: an element's own text and the comments directly inside it are
 * fields of it, and a `<template>`'s content is its `template` text.
 */
export interface AbstractNode {
  readonly tag: string
  readonly attributes?: Readonly<Record<string, string>>
  /** The text of the element's own text children, in order, joined. */
  readonly text?: string
  /**
   * The comments directly inside the element, in order. Where a comment stands among the
   * element's children is not kept, so comments are walked element by element rather than in
   * strict document order; that changes which comment a full comment allowance cuts, never
   * whether a comment is read.
   */
  readonly comments?: readonly CommentView[]
  /** For a `<template>`: the text of its content. */
  readonly template?: string
  /**
   * The computed values the collector reads. A value left out reads as its initial value;
   * a node with no `style` at all reads as one with no layout to ask, so no concealment by
   * style is claimed for it. PassionView gives a node without a layout object
   * `display: none`, which is what it is.
   */
  readonly style?: Partial<StyleValues>
  readonly children?: readonly AbstractNode[]
  /** The caller's own name for the node, echoed into a candidate as `key`. */
  readonly key?: string
}

const NO_STYLE: StyleValues = {
  display: '',
  visibility: '',
  opacity: '',
  fontSize: '',
  clipPath: '',
  clip: '',
  position: '',
  left: '',
  top: '',
  color: '',
  backgroundColor: '',
}

/**
 * The view the collector reads a plain tree through.
 *
 * Parents and id counts are taken in one pass when the view is made, so every later question
 * is a lookup. Comments outside the document element (before `<html>`) go in `outside`.
 */
export function treeView(root: AbstractNode | null, outside: readonly CommentView[] = []): PageView<AbstractNode> {
  const parents = new Map<AbstractNode, AbstractNode | null>()
  const ids = new Map<string, number>()
  const order: AbstractNode[] = []

  if (root !== null) {
    parents.set(root, null)
    const pending: AbstractNode[] = [root]
    while (pending.length > 0) {
      const node = pending.pop() as AbstractNode
      order.push(node)
      const id = node.attributes?.['id']
      if (id) ids.set(id, (ids.get(id) ?? 0) + 1)
      const children = node.children ?? []
      for (let i = children.length - 1; i >= 0; i -= 1) {
        const child = children[i] as AbstractNode
        parents.set(child, node)
        pending.push(child)
      }
    }
  }

  return {
    *comments() {
      yield* outside
      for (const node of order) yield* node.comments ?? []
    },
    root: () => root,
    children: (node) => node.children ?? [],
    parent: (node) => parents.get(node) ?? null,
    tag: (node) => node.tag,
    attribute: (node, name) => node.attributes?.[name] ?? null,
    attributeNames: (node) => Object.keys(node.attributes ?? {}),
    ownText: (node) => node.text ?? '',
    textContent: (node) => textOf(node),
    templateText: (node) => node.template ?? '',
    style: (node) => (node.style ? { ...NO_STYLE, ...node.style } : null),
    idIsUnique: (_node, id) => ids.get(id) === 1,
    key: (node) => node.key,
  }
}

/** All the text inside a node, its own first: what `textContent` gives a JSON-LD script. */
function textOf(node: AbstractNode): string {
  let text = node.text ?? ''
  for (const child of node.children ?? []) text += textOf(child)
  return text
}
