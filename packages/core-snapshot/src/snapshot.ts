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
 *   2. **No field ever gives up its value.** Chrome exposes what is typed into a
 *      text field as a text child of the field. A snapshot that kept "role and
 *      name" and nothing else would still have carried a card number or a code
 *      from SMS through that child, so text inside a field is dropped by role,
 *      not by guessing which fields are sensitive. And because a page can echo a
 *      value into another node's name (a `<label>` around the field, a button
 *      labelled by the code field), every field's value is also cleaned out of
 *      every name (review R4, S4).
 *   3. **References are opaque.** A ref is an HMAC of the DOM node number under
 *      the task's key (`refOf`), and a subtree is taken only by a ref the same
 *      task was given (`refMap`). A subtree is checked against its ancestors, so
 *      a ref cannot reach under a hidden node or into a field (review F2).
 *   4. **It comes in pages.** Measured on 2026-10-06, Wikipedia's compacted tree
 *      is about 66 thousand tokens. One answer that size is not a snapshot an
 *      agent can use, so the caller pages through it with a byte ceiling.
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
}

export interface SnapshotOptions {
  /** Backend DOM node ids the injection detector judged hidden from people. */
  readonly hidden: ReadonlySet<number>
  /** Take only the subtree under this ref. */
  readonly rootRef?: string
  /**
   * The task's key (at least 16 bytes). With it, refs are `refOf(node, taskKey)`
   * and `rootRef` is resolved only through `refMap`. Without it, refs are the
   * plain `e<node>` form, which is guessable: the daemon always passes a key.
   */
  readonly taskKey?: Uint8Array
  /** The `refMap` of an earlier snapshot of the same task. */
  readonly refMap?: ReadonlyMap<string, number>
  /**
   * Backend DOM node ids of fields the caller classed as secret with
   * `isSecretInput` over the element's attributes. The accessibility tree carries
   * neither `type` nor `autocomplete`, so this cannot be read from the tree itself.
   */
  readonly secretFields?: ReadonlySet<number>
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

/** `autocomplete` tokens of fields whose values are secrets: card number, expiry, security code, one-time code. */
const SECRET_AUTOCOMPLETE: ReadonlySet<string> = new Set(['cc-number', 'cc-csc', 'cc-exp', 'cc-exp-month', 'cc-exp-year', 'one-time-code'])

/**
 * Whether an input holds a password, a card number, expiry or security code, or
 * a one-time code, judged from its `type` and `autocomplete` attributes. The
 * caller reads them from the DOM and passes the matching node ids as
 * `secretFields`.
 */
export function isSecretInput(attributes: { readonly type?: string; readonly autocomplete?: string }): boolean {
  if ((attributes.type ?? '').trim().toLowerCase() === 'password') return true
  const tokens = (attributes.autocomplete ?? '').toLowerCase().split(/\s+/)
  return tokens.some((t) => SECRET_AUTOCOMPLETE.has(t) || t.startsWith('cc-exp'))
}

/** What stands where a field value was cut out of a name. */
const VALUE_MASK = '***'

/** Spaces and separators, ignored when a value is looked for: a card typed with spaces is echoed with dashes. */
const SEPARATOR = /^[\p{White_Space}\p{P}\p{S}\p{Cf}]$/u

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

/**
 * Builds the snapshot of a tree, or of the subtree under `rootRef`.
 */
export function buildSnapshot(nodes: readonly AxNode[], options: SnapshotOptions = { hidden: new Set() }): Snapshot {
  const byId = new Map(nodes.map((n) => [n.nodeId, n]))
  const roots = nodes.filter((n) => n.parentId === undefined || !byId.has(n.parentId))
  const values = fieldValues(nodes, byId, options.secretFields ?? new Set())
  const taskKey = options.taskKey
  const refs = new Map<number, string>()
  const refFor = (backend: number): string => {
    let ref = refs.get(backend)
    if (ref === undefined) {
      ref = taskKey === undefined ? `e${backend}` : refOf(backend, taskKey)
      refs.set(backend, ref)
    }
    return ref
  }

  const lines: SnapshotLine[] = []
  const refMap = new Map<string, number>()
  let hiddenRemoved = 0
  let fieldTextDropped = 0

  // Iterative depth-first walk: a page's tree can be deep enough to blow a
  // recursive stack, and depth is data the page controls.
  const stack: Array<{ node: AxNode; depth: number; inField: boolean }> = []
  if (options.rootRef === undefined) {
    for (let i = roots.length - 1; i >= 0; i--) {
      const node = roots[i]
      if (node !== undefined) stack.push({ node, depth: 0, inField: false })
    }
  } else {
    const root = resolveRoot(nodes, byId, options)
    if (root === 'hidden') return { lines, refMap, hiddenRemoved, fieldTextDropped }
    if (root !== null) stack.push({ node: root.node, depth: 0, inField: root.inField })
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
        // Cleaned before it is cut to length, so a value at the cut cannot leave half of itself behind.
        const name = withoutValues(str(node.name?.value).replace(/\s+/g, ' ').trim(), values)
        const keep = role !== 'StaticText' || name.length >= 2
        if (keep && node.backendDOMNodeId !== undefined) {
          const ref = refFor(node.backendDOMNodeId)
          refMap.set(ref, node.backendDOMNodeId)
          lines.push({
            ref,
            role: role === 'StaticText' ? 'text' : role,
            name: name.length > NAME_LIMIT ? `${name.slice(0, NAME_LIMIT)}…` : name,
            depth,
          })
          shownDepth = depth + 1
        }
      }
    }

    // A node the caller classed secret is a field even if its role does not say so.
    const childInField =
      inField || isField(node) || (node.backendDOMNodeId !== undefined && options.secretFields?.has(node.backendDOMNodeId) === true)
    const children = node.childIds ?? []
    for (let i = children.length - 1; i >= 0; i--) {
      const child = byId.get(children[i] ?? '')
      if (child !== undefined) stack.push({ node: child, depth: shownDepth, inField: childInField })
    }
  }

  return { lines, refMap, hiddenRemoved, fieldTextDropped }
}

/**
 * The node `rootRef` names, and whether it sits inside a field; `'hidden'` when it
 * or an ancestor was judged hidden; `null` when the ref names nothing this task
 * was given.
 *
 * With a task key the ref is looked up in the task's own `refMap` and then checked
 * against the key, so a ref of another task, a map of another task or a guessed
 * node number all find nothing. The ancestors are checked on every call: the page
 * may have changed since the ref was given out.
 */
function resolveRoot(
  nodes: readonly AxNode[],
  byId: ReadonlyMap<string, AxNode>,
  options: SnapshotOptions,
): { node: AxNode; inField: boolean } | 'hidden' | null {
  const rootRef = options.rootRef ?? ''
  let backend: number | undefined
  if (options.taskKey !== undefined) {
    backend = options.refMap?.get(rootRef)
    if (backend === undefined || !Number.isSafeInteger(backend) || backend < 0) return null
    if (refOf(backend, options.taskKey) !== rootRef) return null
  } else {
    const match = /^e(\d+)$/.exec(rootRef)
    backend = match === null ? undefined : Number(match[1])
  }
  const node = nodes.find((n) => n.backendDOMNodeId === backend)
  if (node === undefined) return null

  const parentOf = new Map<string, string>()
  for (const n of nodes) for (const c of n.childIds ?? []) if (!parentOf.has(c)) parentOf.set(c, n.nodeId)
  for (const n of nodes) if (n.parentId !== undefined && byId.has(n.parentId)) parentOf.set(n.nodeId, n.parentId)

  let inField = false
  const seen = new Set<string>()
  for (let cur: AxNode | undefined = node; cur !== undefined && !seen.has(cur.nodeId); ) {
    seen.add(cur.nodeId)
    if (cur.backendDOMNodeId !== undefined && options.hidden.has(cur.backendDOMNodeId)) return 'hidden'
    if (cur !== node && isField(cur)) inField = true
    const parent = parentOf.get(cur.nodeId)
    cur = parent === undefined ? undefined : byId.get(parent)
  }
  return { node, inField }
}

/**
 * Every value a person typed or chose, bare (see `bare`): the AX `value` of each
 * field, and the text inside it. Read from the whole tree, not the subtree, since
 * a field outside a subtree can be echoed by a name inside it.
 *
 * Secret fields are walked first, so text inside a secret field is held to the
 * secret floor even when an ordinary field also contains it.
 */
function fieldValues(
  nodes: readonly AxNode[],
  byId: ReadonlyMap<string, AxNode>,
  secretFields: ReadonlySet<number>,
): readonly string[] {
  const found = new Set<string>()
  const inside = new Set<string>()
  const isSecret = (n: AxNode): boolean => n.backendDOMNodeId !== undefined && secretFields.has(n.backendDOMNodeId)
  const fields = nodes.filter((n) => isField(n) || isSecret(n))
  fields.sort((a, b) => Number(isSecret(b)) - Number(isSecret(a)))
  for (const field of fields) {
    const floor = isSecret(field) ? MIN_CLEANED_SECRET : MIN_CLEANED_VALUE
    const add = (raw: unknown): void => {
      const value = bare(str(raw)).text
      if ([...value].length >= floor) found.add(value)
    }
    add(field.value?.value)
    const stack = [...(field.childIds ?? [])]
    while (stack.length > 0) {
      const id = stack.pop()
      if (id === undefined || inside.has(id)) continue
      inside.add(id)
      const child = byId.get(id)
      if (child === undefined) continue
      add(child.value?.value)
      if (str(child.role?.value) === 'StaticText') add(child.name?.value)
      stack.push(...(child.childIds ?? []))
    }
  }
  return [...found]
}

/**
 * A text without spaces and separators, lower-cased, with the index in the
 * original of the code point each of its code units came from.
 */
function bare(text: string): { text: string; from: number[] } {
  let out = ''
  const from: number[] = []
  let index = 0
  for (const ch of text) {
    if (!SEPARATOR.test(ch)) {
      const lower = ch.toLowerCase()
      for (let i = 0; i < lower.length; i++) from.push(index)
      out += lower
    }
    index += ch.length
  }
  return { text: out, from }
}

/** `name` with every occurrence of a field value replaced by a mask, separators inside it included. */
function withoutValues(name: string, values: readonly string[]): string {
  if (values.length === 0 || name === '') return name
  const { text, from } = bare(name)
  const cut = new Uint8Array(name.length)
  let any = false
  for (const value of values) {
    for (let at = text.indexOf(value); at !== -1; at = text.indexOf(value, at + 1)) {
      const start = from[at] ?? 0
      const last = from[at + value.length - 1] ?? start
      const end = last + ((name.codePointAt(last) ?? 0) > 0xffff ? 2 : 1)
      cut.fill(1, start, end)
      any = true
    }
  }
  if (!any) return name
  let out = ''
  for (let i = 0; i < name.length; i++) {
    if (cut[i] === 1) {
      if (i === 0 || cut[i - 1] !== 1) out += VALUE_MASK
    } else {
      out += name[i]
    }
  }
  return out
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
  if (taskKey.length < 16) throw new RangeError('taskKey must be at least 16 bytes')
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
  block.set(key.length > 64 ? sha256(key) : key)
  const inner = new Uint8Array(64 + message.length)
  const outer = new Uint8Array(64 + 32)
  for (let i = 0; i < 64; i++) {
    inner[i] = (block[i] ?? 0) ^ 0x36
    outer[i] = (block[i] ?? 0) ^ 0x5c
  }
  inner.set(message, 64)
  outer.set(sha256(inner), 64)
  return sha256(outer)
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

/** SHA-256 (FIPS 180-4). Checked against `node:crypto` in `secrets.test.ts`. */
function sha256(data: Uint8Array): Uint8Array {
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
