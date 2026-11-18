/**
 * What the collector needs to know about a page, and nothing more (B-221).
 *
 * The collector used to take a `Document` and could only run where one exists: in the
 * extension's content script. PassionView builds its own picture of a page from the Chrome
 * DevTools Protocol and wants the same verdict on it, and a `core-*` package may not touch
 * the DOM. So the collector reads a page through this view: the extension passes one backed
 * by the live document (`apps/extension/src/content/collect.ts`), PassionView one backed by a
 * plain tree (`treeView` in `./tree.ts`). The view is read lazily, node by node, so the
 * extension copies nothing and pays nothing for the abstraction on an ordinary page.
 */

/**
 * The eleven computed values the collector reads, named as `CSSStyleDeclaration` names them,
 * so a live `getComputedStyle` result is one already. An empty string reads as the property's
 * initial value.
 */
export interface StyleValues {
  readonly display: string
  readonly visibility: string
  readonly opacity: string
  readonly fontSize: string
  readonly clipPath: string
  readonly clip: string
  readonly position: string
  readonly left: string
  readonly top: string
  readonly color: string
  readonly backgroundColor: string
}

/** A comment anywhere in the page; comments never render, so each one is a candidate. */
export interface CommentView {
  readonly text: string
  /** The caller's name for the comment node, echoed into the candidate as `key`. */
  readonly key?: string
}

export interface PageView<N> {
  /** Every comment of the page, in document order. Read lazily: a walk may stop early. */
  comments(): Iterable<CommentView>
  /** The document element, or `null` for a page with none. */
  root(): N | null
  /** The element children of a node, in document order. A `<template>`'s content is not among them. */
  children(node: N): Iterable<N>
  /** The parent element, or `null` at the document element. */
  parent(node: N): N | null
  /** The tag name, in any case. */
  tag(node: N): string
  attribute(node: N, name: string): string | null
  attributeNames(node: N): Iterable<string>
  /** The text of the node's own text children, not its descendants'. */
  ownText(node: N): string
  /** All the text inside the node, as `textContent` gives it; read for JSON-LD scripts. */
  textContent(node: N): string
  /** The text of a `<template>`'s content, which is not part of the element's own subtree. */
  templateText(node: N): string
  /** The computed style, or `null` when there is no layout to ask: no concealment is then claimed. */
  style(node: N): StyleValues | null
  /** Whether `id` names this one element in the whole page, so a locator may rest on it. */
  idIsUnique(node: N, id: string): boolean
  /** The caller's name for the node, echoed into the candidate unchanged. Optional. */
  key?(node: N): string | undefined
}
