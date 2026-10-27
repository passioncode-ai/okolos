/**
 * What an agent is handed when it asks to see a page.
 *
 * The input is Chrome's accessibility tree (`Accessibility.getFullAXTree`), which
 * is already the page as assistive technology reads it (headings, links, fields
 * and their labels) rather than markup. Four things are done to it before it
 * leaves the bridge, and each one is a security property rather than a
 * formatting choice:
 *
 *   1. **Hidden text is cut, with everything under it.** The caller passes the
 *      DOM nodes the injection detector judged hidden from people; a node whose
 *      own DOM node or any ancestor's is in that set never reaches the agent.
 *   2. **No field ever gives up its value.** What sits inside a field (a text
 *      field, a `contenteditable`, a node the caller classed secret) is what a
 *      person wrote, whatever role Chrome gives it: a link, an image's alt, a
 *      button label inside a rich editor are content too. So nothing inside a
 *      field contributes a name or a text; the field itself is shown by its
 *      role, with its name only where that name is a label and not its content.
 *      The options of an ordinary select keep their names so the agent can
 *      choose one; a secret field gives no option at all, since masking the
 *      chosen one among the others would name it. And because a page can echo a
 *      value into another node's name (a `<label>` around the field, a button
 *      labelled by the code field, a card number split across spans), every
 *      field's value is also cleaned out of all the text of the page, read as
 *      one run (review R4, S4).
 *   3. **References are opaque.** A ref is an HMAC of the DOM node number under
 *      the task's key (`refOf`), and a node is found only by a ref the same task
 *      was given (`resolveRef`, which `rootRef` uses too). Its ancestors are
 *      checked on every call, so a ref cannot reach under a hidden node, and a
 *      subtree under a field is cleaned exactly as the whole page is (review F2).
 *   4. **It comes in pages.** Measured on 2026-10-06, Wikipedia's compacted tree
 *      is about 66 thousand tokens. One answer that size is not a snapshot an
 *      agent can use, so the caller pages through it with a byte ceiling.
 *
 * The cleaner's work is set by the page (values times text), so it has a budget;
 * past it the snapshot is `incomplete` and the verdict is a refusal, never a page
 * cleaned halfway.
 */

/** The parts of a CDP `Accessibility.AXNode` this module reads. */
export interface AxNode {
  readonly nodeId: string
  readonly ignored?: boolean
  readonly role?: { readonly value?: unknown }
  readonly name?: { readonly value?: unknown }
  /** What a field holds: the text typed into it, the option chosen. */
  readonly value?: { readonly value?: unknown }
  /** Read for `editable`, which marks `contenteditable` whatever its role. */
  readonly properties?: readonly { readonly name: string; readonly value?: { readonly value?: unknown } }[]
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
  /**
   * Every ref this snapshot gave out, to the DOM node behind it. The daemon keeps
   * it with the task, and a later `rootRef` is resolved only through it.
   */
  readonly refMap: ReadonlyMap<string, number>
  /** Nodes cut because they, or an ancestor, were hidden from people. */
  readonly hiddenRemoved: number
  /** Text nodes dropped because they sat inside a field: values, never shown. */
  readonly fieldTextDropped: number
  /**
   * Ids in `hidden` that match no node of this tree. Reported, not refused: an
   * element Chrome keeps out of the accessibility tree (`display: none`, the
   * commonest cut) has no node here and neither has anything under it, so the
   * count is high on ordinary pages and is not a lost cut by itself.
   */
  readonly hiddenUnmatched: number
  /**
   * True when the cleaner stopped at its budget (`CLEANING_BUDGET`,
   * `MATCH_BUDGET`). Lines and refMap are then empty, and `snapshotVerdict`
   * answers `cleaning_incomplete`.
   */
  readonly incomplete: boolean
}

export interface SnapshotOptions {
  /** Backend DOM node ids the injection detector judged hidden from people. */
  readonly hidden: ReadonlySet<number>
  /** Take only the subtree under this ref. */
  readonly rootRef?: string
  /**
   * The task's key (at least 16 bytes). Refs are `refOf(node, taskKey)` and
   * `rootRef` is resolved only through `refMap`. Required (decided 2026-10-27):
   * there is no keyless form, so no ref is ever the guessable `e<node>`.
   */
  readonly taskKey: Uint8Array
  /** The `refMap` of an earlier snapshot of the same task. */
  readonly refMap?: ReadonlyMap<string, number>
  /**
   * Backend DOM node ids of fields the caller classed as secret (`secretFieldIds`
   * over the DOM, or `isSecretInput` over one element's attributes). The
   * accessibility tree carries neither `type` nor `autocomplete`, so this cannot
   * be read from the tree itself. Required (certification round 1): left out, a
   * 3-digit card code echoed into its label reached the agent, so there is no
   * default; an empty set says "no secret field on this page".
   */
  readonly secretFields: ReadonlySet<number>
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

/** A field value shorter than this, once bare, is left in names: "ab" would cut half the page (S4). */
const MIN_CLEANED_VALUE = 4

/**
 * The floor for a secret field (decided 2026-10-27, SCN-045): a card security
 * code is three digits, and at the floor of 4 a CVV typed in a field wrapped by
 * its `<label>` reached the agent through the label's name. Below 3 a value
 * would match too much of any page, so it is still not looked for in names; it
 * is never given out as the field's own text either way.
 */
const MIN_CLEANED_SECRET = 3

/**
 * A value longer than this is looked for as consecutive pieces of this length
 * (and its last piece), not whole: an echo of the whole value contains every
 * piece, so it is still masked end to end, and no single search runs a pattern
 * the page made arbitrarily long.
 */
const VALUE_PIECE = 256

/**
 * The most cleaning work one snapshot may do: characters of page text times
 * the values looked for in them. Measured 2026-10-27 on a 30 000-line page
 * (about 1.1 million characters): 100 field values (about 110 million) built in
 * 229 ms against 189 ms with none; 5 000 field values are about 18 times past
 * the budget and were refused in 54 ms instead of a stall.
 */
const CLEANING_BUDGET = 300_000_000

/**
 * The most matches one snapshot may mark. A repetitive value in a repetitive
 * text matches at every position; past this the page is refused, not walked.
 */
const MATCH_BUDGET = 1_000_000

/** `autocomplete` tokens of fields whose values are secrets: card number, expiry, security code, one-time code. */
const SECRET_AUTOCOMPLETE: ReadonlySet<string> = new Set(['cc-number', 'cc-csc', 'cc-exp', 'cc-exp-month', 'cc-exp-year', 'one-time-code'])

/**
 * Whether an input holds a password, a card number, expiry or security code, or
 * a one-time code, judged from its `type` and `autocomplete` attributes. The
 * caller reads them from the DOM and passes the matching node ids as
 * `secretFields`; `secretFieldIds` does that over a whole CDP DOM tree.
 */
export function isSecretInput(attributes: { readonly type?: string; readonly autocomplete?: string }): boolean {
  if ((attributes.type ?? '').trim().toLowerCase() === 'password') return true
  const tokens = (attributes.autocomplete ?? '').toLowerCase().split(/\s+/)
  return tokens.some((t) => SECRET_AUTOCOMPLETE.has(t) || t.startsWith('cc-exp'))
}

/** The parts of a CDP `DOM.Node` (from `DOM.getDocument` with `depth: -1, pierce: true`) `secretFieldIds` reads. */
export interface CdpDomNode {
  readonly backendNodeId: number
  readonly nodeName?: string
  /** Name, value, name, value: the flat list CDP sends. */
  readonly attributes?: readonly string[]
  readonly children?: readonly CdpDomNode[]
  readonly shadowRoots?: readonly CdpDomNode[]
  readonly contentDocument?: CdpDomNode
}

/** Elements that hold what a person types or chooses. */
const FORM_FIELDS: ReadonlySet<string> = new Set(['INPUT', 'SELECT', 'TEXTAREA'])

/**
 * The `secretFields` of a page: backend node ids of every input, select and
 * textarea `isSecretInput` classes as secret, in shadow roots and frames too.
 * Pass the roots of `DOM.getDocument` (or every node of
 * `DOM.getFlattenedDocument`).
 */
export function secretFieldIds(roots: readonly CdpDomNode[]): Set<number> {
  const out = new Set<number>()
  const stack: CdpDomNode[] = [...roots]
  const seen = new Set<CdpDomNode>()
  while (stack.length > 0) {
    const node = stack.pop()
    if (node === undefined || seen.has(node)) continue
    seen.add(node)
    if (FORM_FIELDS.has(str(node.nodeName).toUpperCase()) && Number.isSafeInteger(node.backendNodeId)) {
      const attributes: { type?: string; autocomplete?: string } = {}
      const list = node.attributes ?? []
      for (let i = 0; i + 1 < list.length; i += 2) {
        const name = str(list[i]).toLowerCase()
        if (name === 'type' && attributes.type === undefined) attributes.type = str(list[i + 1])
        if (name === 'autocomplete' && attributes.autocomplete === undefined) attributes.autocomplete = str(list[i + 1])
      }
      if (isSecretInput(attributes)) out.add(node.backendNodeId)
    }
    stack.push(...(node.children ?? []), ...(node.shadowRoots ?? []))
    if (node.contentDocument !== undefined) stack.push(node.contentDocument)
  }
  return out
}

/** What stands where a field value was cut out of a name. */
const VALUE_MASK = '***'

/** Spaces and separators, ignored when a value is looked for: a card typed with spaces is echoed with dashes. */
const SEPARATOR = /^[\p{White_Space}\p{P}\p{S}\p{Cf}]$/u
const MARK = /^\p{M}$/u
const DIGIT = /^\p{Nd}$/u

function str(value: unknown): string {
  return typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value)
}

/** A text field by role, or anything Chrome marks editable: `contenteditable` without a role counts (R4). */
function isField(node: AxNode): boolean {
  if (FIELD_ROLES.has(str(node.role?.value))) return true
  const editable = node.properties?.find((p) => p.name === 'editable')
  if (editable === undefined) return false
  const value = editable.value?.value
  return value !== false && value !== '' && value !== 'false'
}

/** Where a node sits, from the outside in; a child is at least as far in as its parent. */
const OUTSIDE = 0
/** Inside an ordinary select: its options keep their names. */
const CHOICE = 1
/** Inside a text field or a `contenteditable`: nothing keeps a name. */
const FIELD = 2
/** Inside a field the caller classed secret: nothing is shown at all. */
const SECRET = 3
type Inside = typeof OUTSIDE | typeof CHOICE | typeof FIELD | typeof SECRET

function isSecret(node: AxNode, secretFields: ReadonlySet<number>): boolean {
  return node.backendDOMNodeId !== undefined && secretFields.has(node.backendDOMNodeId)
}

/** What a node makes of its own descendants. */
function kindOf(node: AxNode, secretFields: ReadonlySet<number>): Inside {
  if (isSecret(node, secretFields)) return SECRET
  if (!isField(node)) return OUTSIDE
  return str(node.role?.value) === 'combobox' ? CHOICE : FIELD
}

function isSetLike(value: unknown): value is ReadonlySet<number> {
  return typeof value === 'object' && value !== null && typeof (value as { has?: unknown }).has === 'function'
}

/** A line before it is cleaned: the walk's output, in document order. */
interface Entry {
  readonly nodeId: string
  readonly backend: number
  readonly role: string
  name: string
  readonly depth: number
}

/**
 * Builds the snapshot of a tree, or of the subtree under `rootRef`.
 * Throws a RangeError when `options.taskKey` is absent, not bytes or shorter
 * than 16 bytes, as `refOf` does, and when `hidden` or `secretFields` is not a set.
 */
export function buildSnapshot(nodes: readonly AxNode[], options: SnapshotOptions): Snapshot {
  const given = options as Partial<SnapshotOptions> | undefined
  const key: unknown = given?.taskKey
  // i18n-exempt: a programming error in the daemon's call, thrown to its caller; never shown to a person
  if (!(key instanceof Uint8Array) || key.length < 16) throw new RangeError('taskKey must be at least 16 bytes')
  // i18n-exempt: a programming error in the daemon's call, thrown to its caller; never shown to a person
  if (!isSetLike(given?.secretFields)) throw new RangeError('secretFields is required: pass an empty set when no field is secret')
  // i18n-exempt: a programming error in the daemon's call, thrown to its caller; never shown to a person
  if (!isSetLike(given?.hidden)) throw new RangeError('hidden must be a set of backend node ids')
  const { hidden, secretFields, taskKey } = options

  const backends = new Set<number>()
  for (const n of nodes) if (n.backendDOMNodeId !== undefined) backends.add(n.backendDOMNodeId)
  let hiddenUnmatched = 0
  for (const id of hidden) if (!backends.has(id)) hiddenUnmatched++
  const empty = (incomplete: boolean): Snapshot => ({
    lines: [], refMap: new Map(), hiddenRemoved: 0, fieldTextDropped: 0, hiddenUnmatched, incomplete,
  })

  // The subtree's root, checked the same way any ref is (`resolveRef`).
  let root: AxNode | undefined
  if (options.rootRef !== undefined) {
    const found = resolveRef(options.refMap ?? new Map<string, number>(), options.rootRef, taskKey, nodes, { hidden, secretFields })
    if (!found.found) return empty(false)
    root = nodes.find((n) => n.backendDOMNodeId === found.backendDOMNodeId)
    if (root === undefined) return empty(false)
  }

  // The whole page is always walked and cleaned, so a subtree is cleaned with the
  // page around it in view: a value split across spans, one of which is the
  // subtree, is masked in the subtree too.
  const walk = walkTree(nodes, hidden, secretFields)
  const { patterns, content } = fieldValues(nodes, walk.byId, secretFields)
  for (const entry of walk.entries) {
    if (entry.name !== '' && content.has(entry.nodeId) && fromContent(entry.name, content.get(entry.nodeId) ?? [])) entry.name = ''
  }
  const cleaned = withoutValues(
    walk.entries.map((e) => e.name),
    patterns,
  )
  if (cleaned === null) return empty(true)

  let chosen = walk.entries.map((e, i) => ({ entry: e, name: cleaned[i] ?? '' }))
  let base = 0
  let hiddenRemoved = 0
  let fieldTextDropped = 0
  if (root === undefined) {
    for (const [, count] of walk.cut) hiddenRemoved += count
    fieldTextDropped = walk.dropped.length
  } else {
    const under = subtreeOf(root, walk.byId)
    const depth = walk.frameDepth.get(root.nodeId)
    if (depth === undefined) return empty(false)
    base = depth
    chosen = chosen.filter((c) => under.has(c.entry.nodeId))
    for (const [nodeId, count] of walk.cut) if (under.has(nodeId)) hiddenRemoved += count
    fieldTextDropped = walk.dropped.filter((id) => under.has(id)).length
  }

  const lines: SnapshotLine[] = []
  const refMap = new Map<string, number>()
  const refs = new Map<number, string>()
  for (const { entry, name } of chosen) {
    let ref = refs.get(entry.backend)
    if (ref === undefined) {
      ref = refOf(entry.backend, taskKey)
      refs.set(entry.backend, ref)
    }
    refMap.set(ref, entry.backend)
    lines.push({ ref, role: entry.role, name: name.length > NAME_LIMIT ? `${name.slice(0, NAME_LIMIT)}…` : name, depth: entry.depth - base })
  }
  return { lines, refMap, hiddenRemoved, fieldTextDropped, hiddenUnmatched, incomplete: false }
}

/**
 * The page in document order, before cleaning: what each node shows, by where
 * it sits. Iterative: a page's tree can be deep enough to blow a recursive
 * stack, and depth is data the page controls.
 */
function walkTree(
  nodes: readonly AxNode[],
  hidden: ReadonlySet<number>,
  secretFields: ReadonlySet<number>,
): {
  entries: Entry[]
  byId: ReadonlyMap<string, AxNode>
  frameDepth: ReadonlyMap<string, number>
  cut: Array<[string, number]>
  dropped: string[]
} {
  const byId = new Map(nodes.map((n) => [n.nodeId, n]))
  const roots = nodes.filter((n) => n.parentId === undefined || !byId.has(n.parentId))
  const entries: Entry[] = []
  const frameDepth = new Map<string, number>()
  const cut: Array<[string, number]> = []
  const dropped: string[] = []

  const stack: Array<{ node: AxNode; depth: number; inside: Inside }> = []
  for (let i = roots.length - 1; i >= 0; i--) {
    const node = roots[i]
    if (node !== undefined) stack.push({ node, depth: 0, inside: OUTSIDE })
  }
  const seen = new Set<string>()
  while (stack.length > 0) {
    const frame = stack.pop()
    if (frame === undefined) break
    const { node, depth, inside } = frame
    if (seen.has(node.nodeId)) continue // a malformed tree with a cycle is walked once
    seen.add(node.nodeId)
    frameDepth.set(node.nodeId, depth)

    if (node.backendDOMNodeId !== undefined && hidden.has(node.backendDOMNodeId)) {
      cut.push([node.nodeId, 1 + countDescendants(node, byId)])
      continue
    }

    const role = str(node.role?.value)
    const own = kindOf(node, secretFields)
    let shownDepth = depth
    if (!node.ignored) {
      if (role === 'StaticText' && inside !== OUTSIDE) {
        dropped.push(node.nodeId)
      } else {
        const shown = lineOf(node, role, inside, own)
        if (shown !== null && node.backendDOMNodeId !== undefined) {
          entries.push({ nodeId: node.nodeId, backend: node.backendDOMNodeId, role: shown.role, name: shown.name, depth })
          shownDepth = depth + 1
        }
      }
    }

    const childInside = Math.max(inside, own) as Inside
    const children = node.childIds ?? []
    for (let i = children.length - 1; i >= 0; i--) {
      const child = byId.get(children[i] ?? '')
      if (child !== undefined) stack.push({ node: child, depth: shownDepth, inside: childInside })
    }
  }
  return { entries, byId, frameDepth, cut, dropped }
}

/** The line a node shows, by where it sits; `null` when it shows none. */
function lineOf(node: AxNode, role: string, inside: Inside, own: Inside): { role: string; name: string } | null {
  if (inside === SECRET) return null
  const kept = KEPT_ROLES.has(role)
  if (inside === CHOICE && role === 'option') return { role, name: nameOf(node) }
  if (inside !== OUTSIDE) return kept ? { role, name: '' } : null
  if (own !== OUTSIDE) {
    // A field is shown by its role; a `contenteditable` without one reads as the text box it is.
    if (kept) return { role, name: nameOf(node) }
    return isField(node) ? { role: 'textbox', name: nameOf(node) } : null
  }
  if (!kept) return null
  const name = nameOf(node)
  if (role === 'StaticText') return name.length >= 2 ? { role: 'text', name } : null
  return { role, name }
}

function nameOf(node: AxNode): string {
  return str(node.name?.value).replace(/\s+/g, ' ').trim()
}

/**
 * Whether a field's name is its content rather than a label: Chrome names a
 * `contenteditable` (and some roles) from what is inside it. Such a name is the
 * content, so it is not shown.
 */
function fromContent(name: string, pieces: readonly string[]): boolean {
  const own = bare(name).text
  if (own === '' || pieces.length === 0) return false
  return pieces.join('').includes(own) || pieces.some((p) => p.length >= 2 && own.includes(p))
}

/** Node ids under `root`, itself included. */
function subtreeOf(root: AxNode, byId: ReadonlyMap<string, AxNode>): Set<string> {
  const out = new Set<string>([root.nodeId])
  const stack = [...(root.childIds ?? [])]
  while (stack.length > 0) {
    const id = stack.pop()
    if (id === undefined || out.has(id)) continue
    const node = byId.get(id)
    if (node === undefined) continue
    out.add(id)
    stack.push(...(node.childIds ?? []))
  }
  return out
}

/** How `resolveRef` answers. `reason` tells the caller why, and gives the agent no text either way. */
export type RefResolution =
  | { readonly found: true; readonly backendDOMNodeId: number; readonly inField: boolean }
  | { readonly found: false; readonly reason: 'unknown' | 'hidden' }

const UNKNOWN: RefResolution = { found: false, reason: 'unknown' }
const HIDDEN: RefResolution = { found: false, reason: 'hidden' }

/**
 * The DOM node a ref names, for a verb that acts on it (`open {ref}`, `click`),
 * and whether it sits inside a field. The one resolver: `buildSnapshot` takes
 * its `rootRef` through it too.
 *
 * `unknown` when the ref is not in the task's map, does not match the task key
 * (a ref of another task, a map of another task, a guessed node number), or
 * names a node no longer in the tree. `hidden` when the node or any ancestor is
 * now in `hidden`: the ancestors are checked on every call, because the page may
 * have changed since the ref was given out.
 */
export function resolveRef(
  refs: Snapshot | ReadonlyMap<string, number>,
  ref: string,
  taskKey: Uint8Array,
  nodes: readonly AxNode[],
  scope: { readonly hidden: ReadonlySet<number>; readonly secretFields: ReadonlySet<number> },
): RefResolution {
  const map: ReadonlyMap<string, number> = 'refMap' in refs ? refs.refMap : refs
  const backend = typeof ref === 'string' ? map.get(ref) : undefined
  if (backend === undefined || !Number.isSafeInteger(backend) || backend < 0) return UNKNOWN
  if (refOf(backend, taskKey) !== ref) return UNKNOWN
  const node = nodes.find((n) => n.backendDOMNodeId === backend)
  if (node === undefined) return UNKNOWN

  const byId = new Map(nodes.map((n) => [n.nodeId, n]))
  const parentOf = new Map<string, string>()
  for (const n of nodes) for (const c of n.childIds ?? []) if (!parentOf.has(c)) parentOf.set(c, n.nodeId)
  for (const n of nodes) if (n.parentId !== undefined && byId.has(n.parentId)) parentOf.set(n.nodeId, n.parentId)

  let inField = false
  const seen = new Set<string>()
  for (let cur: AxNode | undefined = node; cur !== undefined && !seen.has(cur.nodeId); ) {
    seen.add(cur.nodeId)
    if (cur.backendDOMNodeId !== undefined && scope.hidden.has(cur.backendDOMNodeId)) return HIDDEN
    if (cur !== node && (isField(cur) || isSecret(cur, scope.secretFields))) inField = true
    const parent = parentOf.get(cur.nodeId)
    cur = parent === undefined ? undefined : byId.get(parent)
  }
  return { found: true, backendDOMNodeId: backend, inField }
}

/**
 * Every value a person typed or chose, bare (see `bare`) and cut into the
 * patterns that are looked for: the AX `value` of each field, and the name and
 * value of everything inside it except a select's options (page text, not
 * typed). Read from the whole tree, not the subtree, since a field outside a
 * subtree can be echoed by a name inside it. Also each field's content, piece
 * by piece, to tell a name that is a label from one that is the content.
 *
 * Secret fields are walked first, so text inside a secret field is held to the
 * secret floor even when an ordinary field also contains it.
 */
function fieldValues(
  nodes: readonly AxNode[],
  byId: ReadonlyMap<string, AxNode>,
  secretFields: ReadonlySet<number>,
): { patterns: readonly string[]; content: ReadonlyMap<string, readonly string[]> } {
  const found = new Set<string>()
  const content = new Map<string, string[]>()
  const inside = new Set<string>()
  const fields = nodes.filter((n) => isField(n) || isSecret(n, secretFields))
  fields.sort((a, b) => Number(isSecret(b, secretFields)) - Number(isSecret(a, secretFields)))
  for (const field of fields) {
    const floor = isSecret(field, secretFields) ? MIN_CLEANED_SECRET : MIN_CLEANED_VALUE
    const pieces: string[] = []
    content.set(field.nodeId, pieces)
    const add = (raw: unknown): void => {
      const value = bare(str(raw)).text
      if (value === '') return
      pieces.push(value)
      if ([...value].length < floor) return
      if (value.length <= VALUE_PIECE) {
        found.add(value)
        return
      }
      for (let at = 0; at < value.length; at += VALUE_PIECE) found.add(value.slice(at, at + VALUE_PIECE))
      found.add(value.slice(value.length - VALUE_PIECE))
    }
    add(field.value?.value)
    const stack = [...(field.childIds ?? [])]
    while (stack.length > 0) {
      const id = stack.pop()
      if (id === undefined || inside.has(id)) continue
      inside.add(id)
      const child = byId.get(id)
      if (child === undefined || str(child.role?.value) === 'option') continue
      add(child.value?.value)
      add(child.name?.value)
      stack.push(...(child.childIds ?? []))
    }
  }
  return { patterns: [...found], content }
}

/** Each printable ASCII character, folded: lower case, or nothing for a separator. */
const ASCII_FOLD: readonly string[] = Array.from({ length: 128 }, (_, cp) => {
  const ch = String.fromCharCode(cp)
  return SEPARATOR.test(ch) ? '' : ch.toLowerCase()
})

/** Folded non-ASCII code points, kept so a page in one script folds each letter once. */
const FOLDED = new Map<number, string>()
const FOLDED_LIMIT = 65_536

/**
 * One code point as it is compared: compatibility-decomposed (NFKD, so a
 * full-width digit is a digit and a ligature its letters), case-folded (upper
 * then lower, so ß matches SS and a dotted capital I matches i), without
 * combining marks, with every decimal digit of any script as its ASCII digit,
 * and nothing for a separator. Decomposing and dropping marks is NFKC with the
 * marks gone, done per code point so the index back into the name stays exact.
 */
function fold(ch: string, cp: number): string {
  if (cp < 0x80) return ASCII_FOLD[cp] ?? ''
  const known = FOLDED.get(cp)
  if (known !== undefined) return known
  let out = ''
  for (const c of ch.normalize('NFKD').toUpperCase().toLowerCase().normalize('NFKD')) {
    if (MARK.test(c) || SEPARATOR.test(c)) continue
    out += DIGIT.test(c) ? String(digitValue(c)) : c
  }
  if (FOLDED.size >= FOLDED_LIMIT) FOLDED.clear()
  FOLDED.set(cp, out)
  return out
}

/**
 * The value of a decimal digit of any script. Unicode assigns decimal digits
 * only in runs of ten, 0 to 9 in order (its stability policy), so the value is
 * how far the digit sits from the start of its run, modulo 10.
 */
function digitValue(c: string): number {
  const cp = c.codePointAt(0) ?? 0
  let steps = 0
  while (steps < 100 && cp - steps - 1 >= 0 && DIGIT.test(String.fromCodePoint(cp - steps - 1))) steps++
  return steps % 10
}

/**
 * A text as values are compared (see `fold`), with the index in the original
 * of the code point each of its code units came from.
 */
function bare(text: string): { text: string; from: number[] } {
  let out = ''
  const from: number[] = []
  let index = 0
  for (const ch of text) {
    const folded = fold(ch, ch.codePointAt(0) ?? 0)
    for (let i = 0; i < folded.length; i++) from.push(index)
    out += folded
    index += ch.length
  }
  return { text: out, from }
}

/**
 * `names` with every occurrence of a pattern replaced by a mask, separators
 * inside it included. The names are read as one run of text, in document order,
 * so a value split over several names (a card number in separate spans) is
 * masked in each of them. `null` when the work would pass the budget.
 */
function withoutValues(names: readonly string[], patterns: readonly string[]): string[] | null {
  if (patterns.length === 0) return [...names]
  const parts = names.map(bare)
  const starts: number[] = [0]
  for (const part of parts) starts.push((starts[starts.length - 1] ?? 0) + part.text.length)
  const total = starts[starts.length - 1] ?? 0
  if (total * patterns.length > CLEANING_BUDGET) return null
  const text = parts.map((p) => p.text).join('')

  const cuts: Array<Uint8Array | undefined> = []
  /** Index of the name holding the joined text's unit `at`. */
  const nameAt = (at: number): number => {
    let lo = 0
    let hi = parts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if ((starts[mid] ?? 0) <= at) lo = mid
      else hi = mid - 1
    }
    return lo
  }
  const mark = (from: number, end: number): void => {
    for (let k = nameAt(from); k < parts.length && (starts[k] ?? 0) < end; k++) {
      const start = starts[k] ?? 0
      const s = Math.max(from, start) - start
      const e = Math.min(end, starts[k + 1] ?? 0) - start
      const part = parts[k]
      const name = names[k] ?? ''
      if (part === undefined || s >= e) continue
      const first = part.from[s] ?? 0
      const last = part.from[e - 1] ?? first
      const stop = last + ((name.codePointAt(last) ?? 0) > 0xffff ? 2 : 1)
      const cut = (cuts[k] ??= new Uint8Array(name.length))
      cut.fill(1, first, stop)
    }
  }

  let matches = 0
  for (const pattern of patterns) {
    let covered = 0
    for (let at = text.indexOf(pattern); at !== -1; at = text.indexOf(pattern, at + 1)) {
      if (++matches > MATCH_BUDGET) return null
      const end = at + pattern.length
      const from = Math.max(at, covered)
      if (from < end) mark(from, end)
      covered = Math.max(covered, end)
    }
  }

  return names.map((name, k) => {
    const cut = cuts[k]
    if (cut === undefined) return name
    let out = ''
    for (let i = 0; i < name.length; i++) {
      if (cut[i] === 1) {
        if (i === 0 || cut[i - 1] !== 1) out += VALUE_MASK
      } else {
        out += name[i]
      }
    }
    return out
  })
}

/**
 * The opaque ref of a DOM node within one task: `r` and the first 96 bits of
 * HMAC-SHA-256(taskKey, `ref:<backendId>`) in base64url.
 *
 * An agent cannot turn a node number into a ref, so it cannot name a node it was
 * never shown; and a ref from one task names nothing in another. The hash is
 * computed here, in plain code, because core-* touches no platform API and a
 * snapshot is built synchronously.
 */
export function refOf(backendId: number, taskKey: Uint8Array): string {
  // i18n-exempt: a programming error in the daemon's call, thrown to its caller; never shown to a person
  if (!Number.isSafeInteger(backendId) || backendId < 0) throw new RangeError('backendId must be a non-negative integer')
  // i18n-exempt: a programming error in the daemon's call, thrown to its caller; never shown to a person
  if (!(taskKey instanceof Uint8Array) || taskKey.length < 16) throw new RangeError('taskKey must be at least 16 bytes')
  const message = Uint8Array.from(`ref:${backendId}`, (c) => c.charCodeAt(0))
  return `r${base64url(hmacSha256(taskKey, message).subarray(0, 12))}`
}

const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

/** Base64url without padding, for byte counts divisible by three. */
function base64url(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i + 2 < bytes.length; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    out += `${BASE64URL[(n >>> 18) & 63]}${BASE64URL[(n >>> 12) & 63]}${BASE64URL[(n >>> 6) & 63]}${BASE64URL[n & 63]}`
  }
  return out
}

function hmacSha256(key: Uint8Array, message: Uint8Array): Uint8Array {
  const block = new Uint8Array(64)
  block.set(key.length > 64 ? digest(key) : key)
  const inner = new Uint8Array(64 + message.length)
  const outer = new Uint8Array(64 + 32)
  for (let i = 0; i < 64; i++) {
    inner[i] = (block[i] ?? 0) ^ 0x36
    outer[i] = (block[i] ?? 0) ^ 0x5c
  }
  inner.set(message, 64)
  outer.set(digest(inner), 64)
  return digest(outer)
}

/**
 * SHA-256 (FIPS 180-4) of some bytes: the hash under every ref, exported so a
 * cursor's digest of a snapshot (N-004) uses this one and the package has one
 * hash. Checked against `node:crypto` in `secrets.test.ts` and `exports.test.ts`.
 */
export function sha256(data: Uint8Array): Uint8Array {
  // i18n-exempt: a programming error in the daemon's call, thrown to its caller; never shown to a person
  if (!(data instanceof Uint8Array)) throw new RangeError('sha256 takes a Uint8Array')
  return digest(data)
}

const K256 = Uint32Array.from([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

/** SHA-256 over bytes already checked to be bytes. */
function digest(data: Uint8Array): Uint8Array {
  const padded = new Uint8Array((((data.length + 9 + 63) / 64) | 0) * 64)
  padded.set(data)
  padded[data.length] = 0x80
  const view = new DataView(padded.buffer)
  const bits = data.length * 8
  view.setUint32(padded.length - 8, Math.floor(bits / 0x100000000))
  view.setUint32(padded.length - 4, bits >>> 0)

  const h = Uint32Array.from([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19])
  const w = new Uint32Array(64)
  const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n))
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4)
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15] ?? 0
      const b = w[i - 2] ?? 0
      const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3)
      const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10)
      w[i] = ((w[i - 16] ?? 0) + s0 + (w[i - 7] ?? 0) + s1) | 0
    }
    let [a, b, c, d, e, f, g, hh] = [h[0] ?? 0, h[1] ?? 0, h[2] ?? 0, h[3] ?? 0, h[4] ?? 0, h[5] ?? 0, h[6] ?? 0, h[7] ?? 0]
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + (K256[i] ?? 0) + (w[i] ?? 0)) | 0
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0
      hh = g
      g = f
      f = e
      e = (d + t1) | 0
      d = c
      c = b
      b = a
      a = (t1 + t2) | 0
    }
    const add = [a, b, c, d, e, f, g, hh]
    for (let i = 0; i < 8; i++) h[i] = ((h[i] ?? 0) + (add[i] ?? 0)) | 0
  }

  const out = new Uint8Array(32)
  const outView = new DataView(out.buffer)
  for (let i = 0; i < 8; i++) outView.setUint32(i * 4, h[i] ?? 0)
  return out
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

/** The smallest and largest page a caller may ask for (spec section 3, review F10). */
export const MIN_PAGE_BYTES = 1024
export const MAX_PAGE_BYTES = 32 * 1024

/**
 * A page size as the daemon uses it: a whole number of bytes from 1 KB to 32 KB.
 * Below the floor rises to it, above the ceiling falls to it, a fraction is
 * rounded down; anything that is not a number (`NaN`, a string, nothing) reads
 * as the ceiling, which is the default page.
 */
export function clampMaxBytes(n: number): number {
  if (typeof n !== 'number' || Number.isNaN(n)) return MAX_PAGE_BYTES
  return Math.min(MAX_PAGE_BYTES, Math.max(MIN_PAGE_BYTES, Math.floor(n)))
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
 * paging forward cannot loop on a line longer than the ceiling: names are cut at
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
