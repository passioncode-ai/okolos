import { performance } from 'node:perf_hooks'

import { describe, expect, it } from 'vitest'

import { buildSnapshot, isSecretInput, refOf, renderLine, type AxNode, type Snapshot, type SnapshotOptions } from '@okolos/core-snapshot'

/*
 * N-003, certification round 1. What sits inside a field is what a person wrote,
 * whatever role Chrome gives it; a secret field gives away nothing, not even by
 * which of its options is masked; and a value is found however the page writes
 * it back, in one name or across several.
 */

const KEY = new Uint8Array(32).fill(0x3c)
const NONE: ReadonlySet<number> = new Set()

interface Spec {
  readonly id: string
  readonly role: string
  readonly name?: string
  readonly value?: string
  readonly editable?: boolean
  readonly ignored?: boolean
  readonly children?: readonly Spec[]
}

/** Builds CDP-shaped nodes; the backend DOM id is the numeric part of the spec id. */
function tree(spec: Spec, parentId?: string): AxNode[] {
  const node: AxNode = {
    nodeId: spec.id,
    role: { value: spec.role },
    ...(spec.name === undefined ? {} : { name: { value: spec.name } }),
    ...(spec.value === undefined ? {} : { value: { value: spec.value } }),
    ...(spec.editable ? { properties: [{ name: 'editable', value: { value: 'richtext' } }] } : {}),
    ...(spec.ignored ? { ignored: true } : {}),
    backendDOMNodeId: Number(spec.id),
    childIds: (spec.children ?? []).map((c) => c.id),
    ...(parentId === undefined ? {} : { parentId }),
  }
  return [node, ...(spec.children ?? []).flatMap((c) => tree(c, spec.id))]
}

function text(snapshot: Snapshot): string {
  return snapshot.lines.map(renderLine).join('\n')
}

function snap(nodes: readonly AxNode[], extra: Partial<SnapshotOptions> = {}): Snapshot {
  return buildSnapshot(nodes, { hidden: NONE, taskKey: KEY, secretFields: NONE, ...extra })
}

/** Every answer a ref can open: the whole page, and a subtree by each node, from a fresh and a stale map. */
function everyAnswer(nodes: readonly AxNode[], extra: Partial<SnapshotOptions> = {}): Snapshot[] {
  const whole = snap(nodes, extra)
  const out = [whole]
  for (const n of nodes) {
    const backend = n.backendDOMNodeId ?? -1
    const ref = refOf(backend, KEY)
    out.push(snap(nodes, { ...extra, rootRef: ref, refMap: whole.refMap }))
    out.push(snap(nodes, { ...extra, rootRef: ref, refMap: new Map([[ref, backend]]) }))
  }
  return out
}

/** The text an agent reads from every line put together, with no spaces, case or separators. */
function joined(snapshot: Snapshot): string {
  return snapshot.lines
    .map((l) => l.name)
    .join('')
    .replace(/[\p{White_Space}\p{P}\p{S}\p{Cf}]/gu, '')
    .toLowerCase()
}

describe('everything inside a field (round 1, unit break)', () => {
  const editor = tree({
    id: '1', role: 'RootWebArea', children: [
      { id: '2', role: 'heading', name: 'Compose' },
      { id: '3', role: 'generic', editable: true, name: 'PIN hunter2pass wire to acct 99887766', children: [
        { id: '4', role: 'link', name: 'PIN', children: [{ id: '5', role: 'StaticText', name: 'PIN' }] },
        { id: '6', role: 'img', name: 'hunter2pass' },
        { id: '7', role: 'button', name: 'wire to acct 99887766' },
        { id: '8', role: 'StaticText', name: 'ok' },
      ] },
      { id: '9', role: 'button', name: 'Send' },
    ],
  })

  it('gives no name or text of a link, an image or a button inside a contenteditable, in any answer', () => {
    for (const s of everyAnswer(editor)) {
      const out = text(s)
      expect(out).not.toContain('PIN')
      expect(out).not.toContain('hunter2pass')
      expect(out).not.toContain('99887766')
      expect(out).not.toContain('"ok"')
    }
  })

  it('shows the field by its role, and the page around it as before', () => {
    const s = snap(editor)
    expect(s.lines.map((l) => `${l.role} ${l.name}`)).toEqual(['heading Compose', 'textbox ', 'link ', 'img ', 'button ', 'button Send'])
    expect(s.lines.find((l) => l.role === 'textbox')?.ref).toBe(refOf(3, KEY))
  })

  it('keeps a field name that is a label, not the field content', () => {
    const nodes = tree({
      id: '1', role: 'RootWebArea', children: [
        { id: '2', role: 'textbox', name: 'Message to the bank', children: [{ id: '3', role: 'StaticText', name: 'transfer everything' }] },
      ],
    })
    expect(snap(nodes).lines.map((l) => `${l.role} ${l.name}`)).toEqual(['textbox Message to the bank'])
  })

  it('treats a node the caller classed secret as a field on the rootRef path too', () => {
    const nodes = tree({
      id: '1', role: 'RootWebArea', children: [
        { id: '2', role: 'group', name: 'PIN pad', children: [{ id: '3', role: 'StaticText', name: '12' }] },
      ],
    })
    for (const s of everyAnswer(nodes, { secretFields: new Set([2]) })) expect(text(s)).not.toContain('12')
  })
})

describe('secretFields (round 1, seam break)', () => {
  const labelled = tree({
    id: '1', role: 'RootWebArea', children: [
      { id: '2', role: 'LabelText', children: [
        { id: '3', role: 'StaticText', name: 'Security code 737' },
        { id: '4', role: 'textbox', name: 'Security code 737', value: '737' },
      ] },
    ],
  })

  it('is required: a snapshot without it throws, and an empty set is an explicit none', () => {
    const call = buildSnapshot as (nodes: readonly AxNode[], options: { hidden: ReadonlySet<number>; taskKey: Uint8Array; secretFields?: unknown }) => unknown
    expect(() => call(labelled, { hidden: NONE, taskKey: KEY })).toThrow(RangeError)
    expect(() => call(labelled, { hidden: NONE, taskKey: KEY, secretFields: undefined })).toThrow(RangeError)
    expect(snap(labelled, { secretFields: new Set() }).lines.length).toBeGreaterThan(0)
  })

  it('masks a 3-digit cc-csc value inside its label when the field is in secretFields', () => {
    expect(isSecretInput({ type: 'text', autocomplete: 'cc-csc' })).toBe(true)
    for (const s of everyAnswer(labelled, { secretFields: new Set([4]) })) expect(text(s)).not.toContain('737')
    expect(text(snap(labelled, { secretFields: new Set([4]) }))).toContain('Security code ***')
  })
})

describe('a secret field with options (round 1, product risk)', () => {
  const expiry = tree({
    id: '1', role: 'RootWebArea', children: [
      { id: '2', role: 'heading', name: 'Since 2026' },
      { id: '4', role: 'combobox', name: 'Expiry year', value: '2027', children: [
        { id: '5', role: 'listbox', children: [
          { id: '6', role: 'option', name: '2026' },
          { id: '7', role: 'option', name: '2027' },
          { id: '8', role: 'option', name: '2028' },
        ] },
      ] },
    ],
  })

  it('gives no option at all, so no option stands out as the chosen one', () => {
    for (const s of everyAnswer(expiry, { secretFields: new Set([4]) })) {
      expect(s.lines.some((l) => l.role === 'option')).toBe(false)
      expect(text(s)).not.toContain('2027')
      expect(text(s)).not.toContain('2028')
    }
  })

  it('still shows the field and leaves the year on the page alone', () => {
    const s = snap(expiry, { secretFields: new Set([4]) })
    expect(s.lines.map((l) => `${l.role} ${l.name}`)).toEqual(['heading Since 2026', 'combobox Expiry year'])
  })

  it('keeps the options of an ordinary select, so the agent can choose one', () => {
    const s = snap(expiry)
    expect(s.lines.filter((l) => l.role === 'option').length).toBe(3)
  })
})

const CARD = '4111111111111111'

describe('matching a value however the page writes it (round 1, unit risk)', () => {
  function echoed(value: string, echo: string): string {
    return text(
      snap(
        tree({
          id: '1', role: 'RootWebArea', children: [
            { id: '2', role: 'textbox', name: 'Entry', value },
            { id: '3', role: 'StaticText', name: `Saved: ${echo} today` },
          ],
        }),
      ),
    )
  }

  it('finds a card echoed in full-width digits', () => {
    expect(echoed(CARD, '４１１１ １１１１ １１１１ １１１１')).not.toMatch(/[４１]{4}/)
  })

  it('finds a card echoed in Arabic-Indic digits', () => {
    expect(echoed(CARD, '٤١١١ ١١١١ ١١١١ ١١١١')).not.toMatch(/[٤١]{4}/)
  })

  it('finds a card typed in full-width digits and echoed in ASCII', () => {
    expect(echoed('４１１１１１１１１１１１１１１１', '4111 1111 1111 1111')).not.toContain('1111')
  })

  it('finds a value with a combining mark inserted into the echo', () => {
    expect(echoed(CARD, '41́111111̈ 1111 1111')).not.toContain('1111')
  })

  it('folds ß and SS, and a dotted capital I', () => {
    expect(echoed('straße', 'STRASSE')).not.toContain('STRASSE')
    expect(echoed('istanbul', 'İSTANBUL')).not.toContain('STANBUL')
    expect(echoed('İSTANBUL', 'istanbul')).not.toContain('stanbul')
  })

  it('keeps the words around the masked value', () => {
    const out = echoed(CARD, '４１１１ １１１１ １１１１ １１１１')
    expect(out).toContain('Saved:')
    expect(out).toContain('today')
  })

  it('finds a card split across separate spans, in the whole page and under a ref', () => {
    const nodes = tree({
      id: '1', role: 'RootWebArea', children: [
        { id: '2', role: 'textbox', name: 'Card', value: CARD },
        { id: '3', role: 'paragraph', children: [
          { id: '4', role: 'StaticText', name: 'Card 4111' },
          { id: '5', role: 'generic', ignored: true, children: [{ id: '6', role: 'StaticText', name: '1111 1111' }] },
          { id: '7', role: 'StaticText', name: '1111 shown' },
        ] },
      ],
    })
    for (const s of everyAnswer(nodes)) expect(joined(s)).not.toContain(CARD)
    expect(text(snap(nodes))).toContain('shown')
  })
})

/*
 * The cleaner's cost is set by the page: every field value is looked for in every
 * name. A page that makes that too large gets a refusal, not a long stall.
 */
describe('the cost of cleaning (round 1, unit risk)', () => {
  it('refuses 5 000 fields over 30 000 text nodes, or cleans them, within 3 seconds', () => {
    const fields: Spec[] = Array.from({ length: 5000 }, (_, i) => ({ id: String(100000 + i), role: 'textbox', name: 'f', value: `value-${i}-xyzw` }))
    const texts: Spec[] = Array.from({ length: 30000 }, (_, i) => ({ id: String(200000 + i), role: 'StaticText', name: `Row ${i} of the long table, value-${i % 5000}-xyzw` }))
    const nodes = tree({ id: '1', role: 'RootWebArea', children: [...fields, ...texts] })
    const started = performance.now()
    const s = snap(nodes)
    const elapsed = performance.now() - started
    expect(elapsed).toBeLessThan(3000)
    expect(s.incomplete || !/value\d+xyzw/.test(joined(s))).toBe(true)
    expect(s.incomplete ? s.lines : []).toEqual([])
  })

  it('does not stall on a repetitive value inside a repetitive name', () => {
    const nodes = tree({
      id: '1', role: 'RootWebArea', children: [
        { id: '2', role: 'textbox', name: 'Notes', value: 'a'.repeat(100000) },
        { id: '3', role: 'StaticText', name: 'a'.repeat(200000) },
      ],
    })
    const started = performance.now()
    const s = snap(nodes)
    expect(performance.now() - started).toBeLessThan(3000)
    expect(text(s)).not.toContain('aaaa')
  })

  it('cleans a value longer than the piece length wherever it is echoed whole', () => {
    const long = Array.from({ length: 700 }, (_, i) => String.fromCharCode(97 + ((i * 7) % 26))).join('')
    const nodes = tree({
      id: '1', role: 'RootWebArea', children: [
        { id: '2', role: 'textbox', name: 'Notes', value: long },
        { id: '3', role: 'StaticText', name: `Draft: ${long}` },
      ],
    })
    const s = snap(nodes)
    expect(s.incomplete).toBe(false)
    expect(text(s)).toContain('Draft: ***')
    expect(text(s)).not.toContain(long.slice(0, 8))
  })
})
