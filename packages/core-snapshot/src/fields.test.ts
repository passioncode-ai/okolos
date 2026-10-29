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

/*
 * N-003, certification round 2. A value is looked for in all the text of the
 * page as it reads, pieces too short to be shown included; the work set by the
 * page's names is counted too; a select's options are page text, not its value;
 * a field hidden from people masks nothing.
 */

/** Whether a name keeps any 4-character run of `value`, once both are bare. */
function keepsRunOf(name: string, value: string, run = 4): boolean {
  const clean = (s: string): string => s.replace(/[\p{White_Space}\p{P}\p{S}\p{Cf}]/gu, '').toLowerCase()
  const v = clean(value)
  return name.split('***').some((part) => {
    const p = clean(part)
    for (let i = 0; i + run <= v.length; i++) if (p.includes(v.slice(i, i + run))) return true
    return false
  })
}

describe('a value echoed across pieces of text (round 2, unit break)', () => {
  const SECRET = 'Tr0ub4dor&3x'
  const split = tree({
    id: '1', role: 'RootWebArea', children: [
      { id: '2', role: 'textbox', name: 'Password', value: SECRET },
      { id: '3', role: 'heading', name: `Saved: ${SECRET}`, children: [
        { id: '4', role: 'StaticText', name: 'Saved: T' },
        { id: '5', role: 'generic', ignored: true, children: [{ id: '6', role: 'StaticText', name: 'r' }] },
        { id: '7', role: 'StaticText', name: '0ub4dor&3x' },
      ] },
    ],
  })

  it('masks every piece when one piece is a single character, plain or secret, in every answer', () => {
    for (const secretFields of [NONE, new Set([2])]) {
      for (const s of everyAnswer(split, { secretFields })) {
        for (const line of s.lines) expect(keepsRunOf(line.name, SECRET), `${line.role} "${line.name}"`).toBe(false)
      }
    }
    expect(text(snap(split))).toContain('Saved: ***')
  })

  it('masks a value written one character per node, shown and not shown in turn', () => {
    const chars = [...SECRET]
    const nodes = tree({
      id: '1', role: 'RootWebArea', children: [
        { id: '2', role: 'textbox', name: 'Password', value: SECRET },
        { id: '3', role: 'paragraph', children: chars.map((c, i): Spec =>
          i % 2 === 0 ? { id: String(10 + i), role: 'StaticText', name: c } : { id: String(10 + i), role: 'link', name: c }) },
      ],
    })
    for (const secretFields of [NONE, new Set([2])]) {
      const links = snap(nodes, { secretFields }).lines.filter((l) => l.role === 'link')
      expect(links.length).toBe(6)
      for (const l of links) expect(['***', '&']).toContain(l.name)
    }
  })

  it('masks the ends of a value whose middle is written as single-character text nodes', () => {
    const middle = [...SECRET].slice(1, -1)
    const nodes = tree({
      id: '1', role: 'RootWebArea', children: [
        { id: '2', role: 'textbox', name: 'Password', value: SECRET },
        { id: '3', role: 'paragraph', children: [
          { id: '4', role: 'StaticText', name: `Your password is ${SECRET.slice(0, 1)}` },
          ...middle.map((c, i): Spec => ({ id: String(10 + i), role: 'StaticText', name: c })),
          { id: '30', role: 'StaticText', name: `${SECRET.slice(-1)}, keep it safe` },
        ] },
      ],
    })
    for (const secretFields of [NONE, new Set([2])]) {
      const out = text(snap(nodes, { secretFields }))
      expect(out).toContain('"Your password is ***"')
      expect(out).toContain('"***, keep it safe"')
    }
  })

  it('masks a 3-character secret split into "7" and "37"', () => {
    const nodes = tree({
      id: '1', role: 'RootWebArea', children: [
        { id: '2', role: 'textbox', name: 'Security code', value: '737' },
        { id: '3', role: 'paragraph', children: [
          { id: '4', role: 'StaticText', name: 'Code:' },
          { id: '5', role: 'StaticText', name: '7' },
          { id: '6', role: 'StaticText', name: '37' },
        ] },
      ],
    })
    for (const s of everyAnswer(nodes, { secretFields: new Set([2]) })) {
      expect(s.lines.some((l) => l.name.includes('37'))).toBe(false)
    }
  })
})

describe('the cost of a field name (round 2, unit break)', () => {
  function named(name: string, pieces: number): AxNode[] {
    // The probe's shape: every piece starts with the name's letter, so each search runs the whole name.
    const children: Spec[] = Array.from({ length: pieces }, (_, i) => ({ id: String(1000 + i), role: 'StaticText', name: 'ab' }))
    return tree({ id: '1', role: 'RootWebArea', children: [{ id: '2', role: 'textbox', name, children }, { id: '3', role: 'heading', name: 'After' }] })
  }

  it('refuses a 10 000-character name over 100 000 pieces of content quickly', () => {
    const nodes = named('a'.repeat(10_000), 100_000)
    const started = performance.now()
    const s = snap(nodes)
    expect(performance.now() - started).toBeLessThan(1500)
    expect(s.incomplete).toBe(true)
    expect(s.lines).toEqual([])
  })

  it('refuses a 1 000 000-character name over 1 000 pieces of content quickly', () => {
    const nodes = named('a'.repeat(1_000_000), 1_000)
    const started = performance.now()
    const s = snap(nodes)
    expect(performance.now() - started).toBeLessThan(1500)
    expect(s.incomplete).toBe(true)
    expect(s.lines).toEqual([])
  })

  it('still reads an ordinary field name next to its content', () => {
    const s = snap(named('Message', 2_000))
    expect(s.incomplete).toBe(false)
    expect(s.lines.map((l) => `${l.role} ${l.name}`)).toEqual(['textbox Message', 'heading After'])
  })
})

describe('an editable combobox is a text box, not a select (round 3)', () => {
  // Chrome marks a search or autocomplete box `editable` (plaintext); a select is not. The
  // typed query must not come back through a suggestion that repeats it.
  const search = tree({
    id: '1', role: 'RootWebArea', children: [
      { id: '2', role: 'combobox', name: 'Search', value: 'divorce lawyer', editable: true, children: [
        { id: '3', role: 'listbox', children: [
          { id: '4', role: 'option', name: 'divorce lawyer near me' },
          { id: '5', role: 'option', name: 'tax advice' },
        ] },
      ] },
      { id: '6', role: 'heading', name: 'Results for divorce lawyer' },
    ],
  })

  it('gives out no line that holds the typed text, on the whole page and under the box', () => {
    for (const s of everyAnswer(search)) {
      for (const l of s.lines) expect(l.name.toLowerCase()).not.toContain('divorce lawyer')
    }
  })

  it('shows the box by its role, with no value and no named suggestion', () => {
    const lines = snap(search).lines.map((l) => `${l.role} ${l.name}`)
    expect(lines).toContain('combobox Search')
    expect(lines.filter((l) => l.startsWith('option ') && l !== 'option ')).toEqual([])
  })
})

describe('a select wrapper holding the box people type into (ARIA 1.1 combobox, round 4)', () => {
  const box = { id: '3', role: 'textbox', name: '', editable: true, children: [{ id: '4', role: 'StaticText', name: 'divorce lawyer' }] }
  const list = { id: '5', role: 'listbox', children: [
    { id: '6', role: 'option', name: 'divorce lawyer near me' },
    { id: '7', role: 'option', name: 'tax advice' },
  ] }
  const page = (children: readonly Spec[]) => tree({
    id: '1', role: 'RootWebArea', children: [{ id: '2', role: 'combobox', name: 'Search', children }],
  })

  it('gives out no line holding the typed text, whichever node comes first', () => {
    for (const nodes of [page([box, list]), page([list, box]), [...page([box, list])].reverse()]) {
      for (const s of everyAnswer(nodes)) {
        for (const l of s.lines) expect(l.name.toLowerCase()).not.toContain('divorce lawyer')
      }
    }
  })
})

describe('a password Chrome shows as dots (round 5, measured on Chromium)', () => {
  const page = tree({
    id: '1', role: 'RootWebArea', children: [
      { id: '2', role: 'textbox', name: 'Password', value: '\u2022'.repeat(9) },
      { id: '3', role: 'heading', name: 'Your password hunter22x is weak' },
    ],
  })
  const secret = { secretFields: new Set([2]) }

  it('masks the repeated password when the caller gives its value from the page', () => {
    const given = { ...secret, domValues: new Map([[2, 'hunter22x']]) }
    for (const s of everyAnswer(page, given)) expect(text(s)).not.toContain('hunter22x')
    expect(text(snap(page, given))).toContain('Your password *** is weak')
  })

  it('searches no dots, refuses a domValues that is not a map, and refuses a dotted password it cannot search', () => {
    const card = tree({
      id: '1', role: 'RootWebArea', children: [
        { id: '2', role: 'textbox', name: 'Password', value: '\u2022'.repeat(4) },
        { id: '3', role: 'heading', name: 'Saved card \u2022\u2022\u2022\u2022 4242' },
      ],
    })
    expect(text(snap(card, { ...secret, domValues: new Map([[2, 'hunter22x']]) }))).toContain('Saved card \u2022\u2022\u2022\u2022 4242')
    expect(() => snap(page, { ...secret, domValues: [[2, 'x']] as unknown as ReadonlyMap<number, string> })).toThrow(RangeError)
    // Without the page value the repeated password cannot be found: refused, not leaked.
    const refused = snap(page, secret)
    expect(refused.incomplete).toBe(true)
    expect(refused.lines).toEqual([])
    // A dotted field that is hidden from people needs nothing.
    expect(snap(page, { ...secret, hidden: new Set([2]) }).incomplete).toBe(false)
  })
})

describe('dots as Chrome draws them, and a password under a hidden section (round 7)', () => {
  it('does not search the dots in the field\'s own text node, and does not refuse a dotted field under a hidden parent', () => {
    const page = tree({
      id: '1', role: 'RootWebArea', children: [
        { id: '2', role: 'textbox', name: 'Password', value: '\u2022'.repeat(4), children: [{ id: '3', role: 'StaticText', name: '\u2022'.repeat(4) }] },
        { id: '4', role: 'heading', name: 'Saved card \u2022\u2022\u2022\u2022 4242' },
        { id: '5', role: 'group', name: 'Old form', children: [{ id: '6', role: 'textbox', name: 'Old password', value: '\u2022'.repeat(6) }] },
      ],
    })
    const s = snap(page, { secretFields: new Set([2, 6]), hidden: new Set([5]), domValues: new Map([[2, 'abcd']]) })
    expect(s.incomplete).toBe(false)
    expect(text(s)).toContain('Saved card \u2022\u2022\u2022\u2022 4242')
  })
})

describe('the names under a select are open text, not its value (round 5)', () => {
  const page = tree({
    id: '1', role: 'RootWebArea', children: [
      { id: '2', role: 'combobox', name: 'Destination', value: 'Lisbon', children: [
        { id: '3', role: 'listbox', name: 'Suggestions', children: [
          { id: '4', role: 'option', name: 'Lisbon' },
          { id: '5', role: 'option', name: 'Porto' },
        ] },
      ] },
      { id: '6', role: 'heading', name: 'Suggestions for you' },
      { id: '7', role: 'heading', name: 'Flights to Lisbon' },
    ],
  })

  it('leaves a heading that repeats the listbox label alone, and still masks the chosen value', () => {
    const t = text(snap(page))
    expect(t).toContain('Suggestions for you')
    expect(t).toContain('Flights to ***')
  })
})

describe('the parts of a date or time input are not searched (round 6, Chrome roles measured)', () => {
  const page = tree({
    id: '1', role: 'RootWebArea', children: [
      { id: '2', role: 'Date', name: 'Booked for', children: [
        { id: '3', role: 'spinbutton', name: 'Month', value: '10' },
        { id: '4', role: 'spinbutton', name: 'Day', value: '29' },
        { id: '5', role: 'spinbutton', name: 'Year', value: '2026' },
      ] },
      { id: '6', role: 'heading', name: 'Since 2026 we ship' },
      { id: '7', role: 'spinbutton', name: 'Guests', value: '1234' },
      { id: '8', role: 'heading', name: 'Room for 1234 guests' },
    ],
  })

  it('leaves a year the page shows alone, and still masks an ordinary number field', () => {
    const t = text(snap(page))
    expect(t).toContain('Since 2026 we ship')
    expect(t).toContain('Room for *** guests')
  })
})

describe('an ordinary select (round 2, product decision 2026-10-27)', () => {
  const country = tree({
    id: '1', role: 'RootWebArea', children: [
      { id: '2', role: 'combobox', name: 'Country', value: 'Germany', children: [
        { id: '3', role: 'listbox', children: [
          { id: '4', role: 'option', name: 'France' },
          { id: '5', role: 'option', name: 'Germany' },
          { id: '6', role: 'option', name: 'Italy' },
        ] },
      ] },
      { id: '7', role: 'combobox', name: 'Billing country', value: 'France', children: [
        { id: '8', role: 'listbox', children: [
          { id: '9', role: 'option', name: 'France' },
          { id: '10', role: 'option', name: 'Germany' },
        ] },
      ] },
      { id: '11', role: 'heading', name: 'Shipping to Germany' },
    ],
  })

  it('shows every option by its own name and marks none as the chosen one, in every answer', () => {
    for (const s of everyAnswer(country)) {
      for (const l of s.lines.filter((x) => x.role === 'option')) expect(l.name).not.toContain('***')
    }
    const options = snap(country).lines.filter((l) => l.role === 'option').map((l) => l.name)
    expect(options).toEqual(['France', 'Germany', 'Italy', 'France', 'Germany'])
  })

  it('still masks the chosen value where the page repeats it outside the options', () => {
    expect(text(snap(country))).toContain('Shipping to ***')
  })

  it('a secret select still shows no option, and its value masks no option of another select', () => {
    const secret = new Set([2])
    for (const s of everyAnswer(country, { secretFields: secret })) {
      for (const id of [4, 5, 6]) expect(s.refMap.has(refOf(id, KEY))).toBe(false)
      for (const l of s.lines.filter((x) => x.role === 'option')) expect(l.name).not.toContain('***')
    }
    expect(snap(country, { secretFields: secret }).lines.filter((l) => l.role === 'option').map((l) => l.name)).toEqual(['France', 'Germany'])
  })
})

describe('a field hidden from people (round 2, product decision 2026-10-27)', () => {
  it('masks nothing elsewhere when the field itself is hidden', () => {
    const nodes = tree({
      id: '1', role: 'RootWebArea', children: [
        { id: '2', role: 'textbox', name: 'x', value: 'never' },
        { id: '3', role: 'heading', name: 'Never wire money to this account' },
        { id: '4', role: 'textbox', name: 'y', value: 'not' },
        { id: '5', role: 'StaticText', name: 'Do not send your code to anyone' },
      ],
    })
    const out = text(snap(nodes, { hidden: new Set([2, 4]), secretFields: new Set([4]) }))
    expect(out).toContain('Never wire money to this account')
    expect(out).toContain('Do not send your code to anyone')
  })

  it('masks nothing elsewhere when an ancestor is hidden, the field inside a visible field included', () => {
    const nodes = tree({
      id: '1', role: 'RootWebArea', children: [
        { id: '2', role: 'group', children: [{ id: '3', role: 'textbox', name: 'x', value: 'never' }] },
        { id: '4', role: 'generic', editable: true, children: [
          { id: '5', role: 'generic', children: [{ id: '6', role: 'textbox', name: 'wire', value: 'wire' }] },
        ] },
        { id: '7', role: 'heading', name: 'Never wire money to this account' },
      ],
    })
    expect(text(snap(nodes, { hidden: new Set([2, 5]) }))).toContain('Never wire money to this account')
  })

  it('still masks the value of a visible field', () => {
    const nodes = tree({
      id: '1', role: 'RootWebArea', children: [
        { id: '2', role: 'textbox', name: 'x', value: 'never' },
        { id: '3', role: 'heading', name: 'Never wire money to this account' },
      ],
    })
    expect(text(snap(nodes))).toContain('*** wire money')
  })
})
