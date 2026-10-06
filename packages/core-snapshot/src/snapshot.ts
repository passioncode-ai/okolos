/**
 * What an agent is handed when it asks to see a page.
 *
 * The input is Chrome's accessibility tree (`Accessibility.getFullAXTree`), which
 * is already the page as assistive technology reads it — headings, links, fields
 * and their labels — rather than markup. Three things are done to it before it
 * leaves the bridge, and each one is a security property rather than a
 * formatting choice:
 *
 *   1. **Hidden text is cut, with everything under it.** The caller passes the
 *      DOM nodes the injection detector judged hidden from people; a node whose
 *      own DOM node or any ancestor's is in that set never reaches the agent.
 *   2. **No field ever gives up its value.** Chrome exposes what is typed into a
 *      text field as a text child of the field. A snapshot that kept "role and
 *      name" and nothing else would still have carried a card number or a code
 *      from SMS through that child, so text inside a field is dropped by role,
 *      not by guessing which fields are sensitive.
 *   3. **It comes in pages.** Measured on 2026-10-06, Wikipedia's compacted tree
 *      is about 66 thousand tokens. One answer that size is not a snapshot an
 *      agent can use, so the caller pages through it with a byte ceiling.
 *
 * References are `e<backendDOMNodeId>`: stable for the life of the document, so
 * an agent can name a node from one page of the snapshot in its next call.
 */

/** The parts of a CDP `Accessibility.AXNode` this module reads. */
export interface AxNode {
  readonly nodeId: string
  readonly ignored?: boolean
  readonly role?: { readonly value?: unknown }
  readonly name?: { readonly value?: unknown }
  readonly parentId?: string
  readonly childIds?: readonly string[]
  readonly backendDOMNodeId?: number
}

export interface SnapshotLine {
  readonly ref: string
  readonly role: string
  readonly name: string
  /** Depth below the snapshot's root, so the text keeps the page's nesting. */
  readonly depth: number
}

export interface Snapshot {
  readonly lines: readonly SnapshotLine[]
  /** Nodes cut because they, or an ancestor, were hidden from people. */
  readonly hiddenRemoved: number
  /** Text nodes dropped because they sat inside a field — values, never shown. */
  readonly fieldTextDropped: number
}

/** Roles an agent acts on or orients by. Everything else is layout. */
const KEPT_ROLES: ReadonlySet<string> = new Set([
  'button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch',
  'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'tab', 'slider', 'spinbutton',
  'heading', 'img', 'image', 'listbox', 'menu', 'tablist', 'dialog', 'alertdialog', 'alert',
  'navigation', 'main', 'form', 'search', 'banner', 'contentinfo', 'region', 'article',
  'cell', 'columnheader', 'rowheader', 'StaticText',
])

/** Roles whose descendants' text is what a person typed, not what the page says. */
const FIELD_ROLES: ReadonlySet<string> = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton'])

const NAME_LIMIT = 160

function str(value: unknown): string {
  return typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value)
}

/**
 * Builds the snapshot of a tree, or of the subtree under `rootRef`.
 *
 * @param hidden backend DOM node ids the injection detector judged hidden from people
 */
export function buildSnapshot(
  nodes: readonly AxNode[],
  options: { readonly hidden: ReadonlySet<number>; readonly rootRef?: string } = { hidden: new Set() },
): Snapshot {
  const byId = new Map(nodes.map((n) => [n.nodeId, n]))
  const roots = nodes.filter((n) => n.parentId === undefined || !byId.has(n.parentId))

  let start: readonly AxNode[] = roots
  if (options.rootRef !== undefined) {
    const backend = Number(options.rootRef.replace(/^e/, ''))
    const root = nodes.find((n) => n.backendDOMNodeId === backend)
    start = root === undefined ? [] : [root]
  }

  const lines: SnapshotLine[] = []
  let hiddenRemoved = 0
  let fieldTextDropped = 0

  // Iterative depth-first walk: a page's tree can be deep enough to blow a
  // recursive stack, and depth is data the page controls.
  const stack: Array<{ node: AxNode; depth: number; inField: boolean }> = []
  for (let i = start.length - 1; i >= 0; i--) {
    const node = start[i]
    if (node !== undefined) stack.push({ node, depth: 0, inField: false })
  }
  const seen = new Set<string>()

  while (stack.length > 0) {
    const frame = stack.pop()
    if (frame === undefined) break
    const { node, depth, inField } = frame
    if (seen.has(node.nodeId)) continue // a malformed tree with a cycle is walked once
    seen.add(node.nodeId)

    if (node.backendDOMNodeId !== undefined && options.hidden.has(node.backendDOMNodeId)) {
      hiddenRemoved += 1 + countDescendants(node, byId)
      continue
    }

    const role = str(node.role?.value)
    let shownDepth = depth
    if (!node.ignored && KEPT_ROLES.has(role)) {
      if (role === 'StaticText' && inField) {
        fieldTextDropped++
      } else {
        const name = str(node.name?.value).replace(/\s+/g, ' ').trim()
        const keep = role !== 'StaticText' || name.length >= 2
        if (keep && node.backendDOMNodeId !== undefined) {
          lines.push({
            ref: `e${node.backendDOMNodeId}`,
            role: role === 'StaticText' ? 'text' : role,
            name: name.length > NAME_LIMIT ? `${name.slice(0, NAME_LIMIT)}…` : name,
            depth,
          })
          shownDepth = depth + 1
        }
      }
    }

    const childInField = inField || FIELD_ROLES.has(role)
    const children = node.childIds ?? []
    for (let i = children.length - 1; i >= 0; i--) {
      const child = byId.get(children[i] ?? '')
      if (child !== undefined) stack.push({ node: child, depth: shownDepth, inField: childInField })
    }
  }

  return { lines, hiddenRemoved, fieldTextDropped }
}

function countDescendants(node: AxNode, byId: ReadonlyMap<string, AxNode>): number {
  let count = 0
  const stack = [...(node.childIds ?? [])]
  const seen = new Set<string>()
  while (stack.length > 0) {
    const id = stack.pop()
    if (id === undefined || seen.has(id)) continue
    seen.add(id)
    const child = byId.get(id)
    if (child === undefined) continue
    count++
    stack.push(...(child.childIds ?? []))
  }
  return count
}

/** One line of the text an agent reads: indentation, reference, role, name. */
export function renderLine(line: SnapshotLine): string {
  const indent = '  '.repeat(Math.min(line.depth, 12))
  return `${indent}${line.ref} ${line.role}${line.name ? ` "${line.name.replace(/"/g, '\\"')}"` : ''}`
}

export interface SnapshotPage {
  readonly text: string
  /** Index of the first line of the next page, or `null` when this was the last. */
  readonly next: number | null
  readonly from: number
  readonly to: number
  readonly total: number
}

/** Bytes of a string as UTF-8, without a platform encoder. */
export function utf8Bytes(text: string): number {
  let bytes = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4
  }
  return bytes
}

/**
 * A page of the snapshot that fits `maxBytes`, starting at line `from`.
 *
 * Lines are never split. A page always carries at least one line, so a reader
 * paging forward cannot loop on a line longer than the ceiling — names are cut at
 * 160 characters, which keeps every line far below any sane ceiling anyway.
 */
export function pageOf(lines: readonly SnapshotLine[], from: number, maxBytes: number): SnapshotPage {
  const start = Math.max(0, Math.min(from, lines.length))
  const out: string[] = []
  let bytes = 0
  let i = start
  for (; i < lines.length; i++) {
    const line = lines[i]
    if (line === undefined) break
    const rendered = renderLine(line)
    const cost = utf8Bytes(rendered) + 1
    if (out.length > 0 && bytes + cost > maxBytes) break
    out.push(rendered)
    bytes += cost
  }
  return { text: out.join('\n'), next: i < lines.length ? i : null, from: start, to: i, total: lines.length }
}

/**
 * A URL as an agent may see it: no fragment.
 *
 * The fragment never reaches a server, which is why HashJack hid its instructions
 * there; an agent that never sees it cannot be told anything through it.
 */
export function withoutFragment(url: string): string {
  const hash = url.indexOf('#')
  return hash === -1 ? url : url.slice(0, hash)
}
