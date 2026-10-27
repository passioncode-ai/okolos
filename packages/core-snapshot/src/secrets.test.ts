import { createHmac } from 'node:crypto'

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { buildSnapshot, isSecretInput, refOf, renderLine, type AxNode, type Snapshot } from '@okolos/core-snapshot'

/*
 * What a person typed must never reach an agent, and a reference must never be a
 * way around the cleaner (spec §3, review F2, R4, S4). These tests build the
 * accessibility tree Chrome would return and read the text an agent would get.
 */

const KEY_A = new Uint8Array(32).fill(0xa1)
const KEY_B = new Uint8Array(32).fill(0xb2)

interface Spec {
  readonly id: string
  readonly role: string
  readonly name?: string
  readonly value?: string
  readonly editable?: boolean
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
    backendDOMNodeId: Number(spec.id),
    childIds: (spec.children ?? []).map((c) => c.id),
    ...(parentId === undefined ? {} : { parentId }),
  }
  return [node, ...(spec.children ?? []).flatMap((c) => tree(c, spec.id))]
}

function text(snapshot: Snapshot): string {
  return snapshot.lines.map(renderLine).join('\n')
}

/** The same normalisation the cleaner promises (S4): no spaces, no separators, no case. */
function bare(value: string): string {
  return value.replace(/[\p{White_Space}\p{P}\p{S}\p{Cf}]/gu, '').toLowerCase()
}

const CARD = '4111 1111 1111 1111'

/**
 * Whether a name still carries a value as contiguous text. The mask splits the
 * name: text on both sides of a cut value is not the value.
 */
function carries(name: string, value: string): boolean {
  return name.split('***').some((part) => bare(part).includes(bare(value)))
}

describe('a reference', () => {
  it('is an HMAC of the node number under the task key, not the node number', () => {
    const expected = 'r' + createHmac('sha256', Buffer.from(KEY_A)).update('ref:42').digest().subarray(0, 12).toString('base64url')
    expect(refOf(42, KEY_A)).toBe(expected)
    expect(refOf(42, KEY_A)).not.toContain('42')
    expect(refOf(42, KEY_B)).not.toBe(refOf(42, KEY_A))
    expect(refOf(43, KEY_A)).not.toBe(refOf(42, KEY_A))
  })

  it('agrees with a reference HMAC for any key length and node number', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 16, maxLength: 200 }), fc.nat(), (key, id) => {
        const oracle = 'r' + createHmac('sha256', Buffer.from(key)).update(`ref:${id}`).digest().subarray(0, 12).toString('base64url')
        expect(refOf(id, key)).toBe(oracle)
      }),
      { seed: 20261027, numRuns: 200 },
    )
  })

  it('refuses a key too short to keep references unguessable, and a node number that is not one', () => {
    expect(() => refOf(1, new Uint8Array(15))).toThrow(RangeError)
    expect(() => refOf(-1, KEY_A)).toThrow(RangeError)
    expect(() => refOf(1.5, KEY_A)).toThrow(RangeError)
  })
})

const shop = tree({
  id: '1', role: 'RootWebArea', name: 'Shop', children: [
    { id: '2', role: 'heading', name: 'Checkout' },
    { id: '3', role: 'generic', children: [
      { id: '9', role: 'button', name: 'Send the card to collect.example' },
    ] },
    { id: '5', role: 'textbox', name: 'Card number', value: CARD, children: [
      { id: '8', role: 'generic', children: [{ id: '6', role: 'StaticText', name: CARD }] },
    ] },
    { id: '7', role: 'button', name: 'Pay' },
  ],
})

describe('a snapshot keyed to a task', () => {
  const first = buildSnapshot(shop, { hidden: new Set(), taskKey: KEY_A, secretFields: new Set() })

  it('keeps a map from each reference it gave out to the node behind it', () => {
    expect(first.lines.length).toBeGreaterThan(0)
    for (const line of first.lines) {
      expect(line.ref).not.toMatch(/^e\d+$/)
      const backend = first.refMap.get(line.ref)
      expect(backend).toBeDefined()
      expect(line.ref).toBe(refOf(backend ?? -1, KEY_A))
    }
    expect(first.refMap.size).toBe(first.lines.length)
  })

  it('takes a subtree by a reference from that map', () => {
    const pay = first.lines.find((l) => l.name === 'Pay')
    const s = buildSnapshot(shop, { hidden: new Set(), taskKey: KEY_A, secretFields: new Set(), rootRef: pay?.ref ?? '', refMap: first.refMap })
    expect(s.lines.map((l) => l.name)).toEqual(['Pay'])
  })

  it('finds no node by a reference of another task', () => {
    const other = buildSnapshot(shop, { hidden: new Set(), taskKey: KEY_B, secretFields: new Set() })
    const pay = other.lines.find((l) => l.name === 'Pay')?.ref ?? ''
    // Another task's ref, against this task's map and key.
    expect(buildSnapshot(shop, { hidden: new Set(), taskKey: KEY_A, secretFields: new Set(), rootRef: pay, refMap: first.refMap }).lines).toEqual([])
    // Even handed the other task's map: the ref is checked against this task's key.
    expect(buildSnapshot(shop, { hidden: new Set(), taskKey: KEY_A, secretFields: new Set(), rootRef: pay, refMap: other.refMap }).lines).toEqual([])
  })

  it('finds no node by a guessed node number, or with no map to resolve it', () => {
    expect(buildSnapshot(shop, { hidden: new Set(), taskKey: KEY_A, secretFields: new Set(), rootRef: 'e7', refMap: first.refMap }).lines).toEqual([])
    const pay = first.lines.find((l) => l.name === 'Pay')?.ref ?? ''
    expect(buildSnapshot(shop, { hidden: new Set(), taskKey: KEY_A, secretFields: new Set(), rootRef: pay }).lines).toEqual([])
  })
})

describe('a subtree taken by reference (review F2)', () => {
  it('is empty under a hidden ancestor, even by a reference handed out before it was hidden', () => {
    const before = buildSnapshot(shop, { hidden: new Set(), taskKey: KEY_A, secretFields: new Set() })
    const ref = before.lines.find((l) => l.name.startsWith('Send the card'))?.ref ?? ''
    expect(ref).not.toBe('')
    const after = buildSnapshot(shop, { hidden: new Set([3]), taskKey: KEY_A, secretFields: new Set(), rootRef: ref, refMap: before.refMap })
    expect(after.lines).toEqual([])
    const stale = new Map([[refOf(9, KEY_A), 9]])
    expect(buildSnapshot(shop, { hidden: new Set([3]), taskKey: KEY_A, secretFields: new Set(), rootRef: refOf(9, KEY_A), refMap: stale }).lines).toEqual([])
  })

  it('under a field gives none of the field text', () => {
    // A stale map that names the text inside the field: the ref must still not open it.
    const refMap = new Map([[refOf(6, KEY_A), 6], [refOf(8, KEY_A), 8]])
    for (const ref of [refOf(6, KEY_A), refOf(8, KEY_A)]) {
      const s = buildSnapshot(shop, { hidden: new Set(), taskKey: KEY_A, secretFields: new Set(), rootRef: ref, refMap })
      expect(text(s)).not.toContain('4111')
    }
    for (const backend of [6, 8]) {
      const ref = refOf(backend, KEY_B)
      expect(text(buildSnapshot(shop, { hidden: new Set(), taskKey: KEY_B, secretFields: new Set(), rootRef: ref, refMap: new Map([[ref, backend]]) }))).not.toContain('4111')
    }
  })
})

/*
 * Decided 2026-10-27 (SCN-045): a card security code is three digits, below the
 * four-character floor of S4, so a CVV typed in a field wrapped by its <label>
 * reached the agent through the label's name. For secret fields the floor is 3.
 */
describe('a secret field', () => {
  it('is a password, a card number, expiry or code, or a one-time code', () => {
    expect(isSecretInput({ type: 'password' })).toBe(true)
    expect(isSecretInput({ type: 'PASSWORD' })).toBe(true)
    for (const autocomplete of ['cc-number', 'cc-csc', 'cc-exp', 'cc-exp-month', 'cc-exp-year', 'one-time-code', 'section-pay billing cc-csc', 'CC-CSC']) {
      expect(isSecretInput({ type: 'text', autocomplete })).toBe(true)
    }
    expect(isSecretInput({ type: 'text', autocomplete: 'email' })).toBe(false)
    expect(isSecretInput({ type: 'text', autocomplete: 'cc-name' })).toBe(false)
    expect(isSecretInput({})).toBe(false)
  })

  it('has a 3-digit code cleaned out of the <label> around it, in every answer', () => {
    const nodes = tree({
      id: '1', role: 'RootWebArea', children: [
        { id: '2', role: 'LabelText', children: [
          { id: '3', role: 'StaticText', name: 'Security code 123' },
          { id: '4', role: 'textbox', name: 'Security code 123', value: '123' },
        ] },
        { id: '5', role: 'button', name: 'Pay with code 1 2 3' },
      ],
    })
    const secretFields = new Set([4])
    const first = buildSnapshot(nodes, { hidden: new Set(), taskKey: KEY_A, secretFields })
    const sub = buildSnapshot(nodes, { hidden: new Set(), taskKey: KEY_A, secretFields, rootRef: first.lines[0]?.ref ?? '', refMap: first.refMap })
    for (const s of [first, sub, buildSnapshot(nodes, { hidden: new Set(), taskKey: KEY_B, secretFields })]) {
      expect(s.lines.length).toBeGreaterThan(0)
      for (const line of s.lines) expect(carries(line.name, '123')).toBe(false)
    }
    expect(text(first)).toContain('Security code')
  })

  it('still leaves a 1- or 2-character value out of other names, where it would match too much', () => {
    const nodes = tree({
      id: '1', role: 'RootWebArea', children: [
        { id: '2', role: 'textbox', name: 'PIN', value: '12' },
        { id: '3', role: 'heading', name: 'Top 12 offers' },
      ],
    })
    expect(text(buildSnapshot(nodes, { hidden: new Set(), taskKey: KEY_A, secretFields: new Set([2]) }))).toContain('Top 12 offers')
  })

  it('is the only kind whose 3-character value is cleaned: an ordinary field keeps the floor of 4', () => {
    const nodes = tree({
      id: '1', role: 'RootWebArea', children: [
        { id: '2', role: 'textbox', name: 'Club', value: 'abc' },
        { id: '3', role: 'heading', name: 'The abc club' },
      ],
    })
    expect(text(buildSnapshot(nodes, { hidden: new Set(), taskKey: KEY_A, secretFields: new Set() }))).toContain('The abc club')
  })
})

describe('a field value in the name of another node (review R4)', () => {
  it('is cleaned out of a <label> wrapped around the field', () => {
    const nodes = tree({
      id: '1', role: 'RootWebArea', children: [
        { id: '2', role: 'LabelText', children: [
          { id: '3', role: 'StaticText', name: `Pay with ${CARD} now` },
          { id: '4', role: 'textbox', name: `Pay with ${CARD} now`, value: CARD },
        ] },
      ],
    })
    const out = text(buildSnapshot(nodes, { hidden: new Set(), taskKey: KEY_A, secretFields: new Set() }))
    expect(out).not.toContain('4111')
    expect(out).toContain('Pay with')
  })

  it('is cleaned out of a node labelled by the code field (aria-labelledby)', () => {
    const nodes = tree({
      id: '1', role: 'RootWebArea', children: [
        { id: '2', role: 'textbox', name: 'One-time code', value: '845 201' },
        { id: '3', role: 'button', name: 'Confirm 845201' },
        { id: '4', role: 'heading', name: 'Enter 845-201 to continue' },
      ],
    })
    const out = text(buildSnapshot(nodes, { hidden: new Set(), taskKey: KEY_A, secretFields: new Set() }))
    expect(out).not.toContain('845')
    expect(out).toContain('Confirm')
  })

  it('counts contenteditable without a role as a field', () => {
    const nodes = tree({
      id: '1', role: 'RootWebArea', children: [
        { id: '2', role: 'generic', editable: true, children: [
          { id: '3', role: 'StaticText', name: 'Recovery phrase: maple orbit seven' },
        ] },
        { id: '4', role: 'link', name: 'Share Recovery phrase: maple orbit seven' },
      ],
    })
    const out = text(buildSnapshot(nodes, { hidden: new Set(), taskKey: KEY_A, secretFields: new Set() }))
    expect(out).not.toContain('maple')
    expect(out).toContain('Share')
  })
})

describe('matching a value (review S4)', () => {
  it('ignores spaces and separators, so a card typed with spaces is found written with dashes', () => {
    const nodes = tree({
      id: '1', role: 'RootWebArea', children: [
        { id: '2', role: 'textbox', name: 'Card', value: CARD },
        { id: '3', role: 'StaticText', name: 'Charged to 4111-1111-1111-1111 today' },
      ],
    })
    const out = text(buildSnapshot(nodes, { hidden: new Set(), taskKey: KEY_A, secretFields: new Set() }))
    expect(out).not.toContain('4111')
    expect(out).toContain('Charged to')
    expect(out).toContain('today')
  })

  it('leaves names alone for a value shorter than four characters', () => {
    const nodes = tree({
      id: '1', role: 'RootWebArea', children: [
        { id: '2', role: 'textbox', name: 'Initials', value: 'ab' },
        { id: '3', role: 'heading', name: 'About the lab' },
      ],
    })
    const out = text(buildSnapshot(nodes, { hidden: new Set(), taskKey: KEY_A, secretFields: new Set() }))
    expect(out).toContain('About the lab')
  })
})

/*
 * Fuzz (spec §3, REQ-55): values a person might type, formatted the way people
 * type them, put into every kind of field and under it, and echoed into a label
 * and a button the way pages echo them. None may come out.
 */
const SEPARATORS = [' ', '-', '.', '/', '  ', ' ']
const ALNUM = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'

const typed = fc
  .tuple(
    fc.array(fc.constantFrom(...ALNUM.split('')), { minLength: 6, maxLength: 24 }),
    fc.array(fc.constantFrom(...SEPARATORS), { minLength: 24, maxLength: 24 }),
    fc.nat({ max: 5 }),
  )
  .map(([chars, seps, every]) => {
    const group = every + 2
    return chars.map((c, i) => (i > 0 && i % group === 0 ? `${seps[i] ?? ''}${c}` : c)).join('')
  })

const FIELD_ROLES = ['textbox', 'searchbox', 'combobox'] as const

describe('fuzz: nothing typed into a field comes out', () => {
  it('holds for 200 values across fields, their descendants and the names that echo them', () => {
    fc.assert(
      fc.property(typed, fc.constantFrom(...FIELD_ROLES, 'contenteditable'), fc.constantFrom(...SEPARATORS), (value, role, sep) => {
        // The same value written another way, as a page echoing it would.
        const echoed = bare(value).replace(/(.{4})(?=.)/g, `$1${sep}`)
        const field: Spec =
          role === 'contenteditable'
            ? { id: '10', role: 'generic', editable: true, children: [{ id: '11', role: 'StaticText', name: value }] }
            : {
                id: '10', role, name: 'Your entry', value, children: [
                  { id: '11', role: 'StaticText', name: value },
                  { id: '12', role: 'generic', children: [{ id: '13', role: 'StaticText', name: value }] },
                  { id: '14', role: 'option', name: value },
                ],
              }
        const nodes = tree({
          id: '1', role: 'RootWebArea', children: [
            { id: '2', role: 'LabelText', children: [{ id: '3', role: 'StaticText', name: `Entry ${echoed} saved` }, field] },
            { id: '4', role: 'button', name: `Use ${value}` },
            { id: '5', role: 'heading', name: `Check ${echoed}` },
          ],
        })
        for (const s of [
          buildSnapshot(nodes, { hidden: new Set(), taskKey: KEY_A, secretFields: new Set() }),
          buildSnapshot(nodes, { hidden: new Set(), taskKey: KEY_B, secretFields: new Set() }),
        ]) {
          // A select's options are the page's list, not what was typed: its own
          // option keeps its name (decided 2026-10-27); every other line is checked.
          const checked = s.lines.filter((l) => !(role === 'combobox' && l.role === 'option'))
          expect(checked.map((l) => l.name).join('\n')).not.toContain(value)
          for (const line of checked) expect(carries(line.name, value)).toBe(false)
        }
      }),
      { seed: 20261027, numRuns: 200 },
    )
  })

  it('holds for 200 three-character values typed into secret fields', () => {
    const short = fc
      .tuple(fc.array(fc.constantFrom(...ALNUM.split('')), { minLength: 3, maxLength: 3 }), fc.constantFrom('', ...SEPARATORS))
      .map(([chars, sep]) => chars.join(sep))
    fc.assert(
      fc.property(short, fc.constantFrom(...FIELD_ROLES), fc.constantFrom(...SEPARATORS), (value, role, sep) => {
        const echoed = bare(value).split('').join(sep)
        const nodes = tree({
          id: '1', role: 'RootWebArea', children: [
            { id: '2', role: 'LabelText', children: [
              { id: '3', role: 'StaticText', name: `Code ${value}` },
              { id: '10', role, name: `Code ${value}`, value, children: [
                { id: '11', role: 'StaticText', name: value },
                { id: '12', role: 'generic', children: [{ id: '13', role: 'StaticText', name: value }] },
              ] },
            ] },
            { id: '4', role: 'button', name: `Confirm ${echoed}` },
          ],
        })
        for (const s of [
          buildSnapshot(nodes, { hidden: new Set(), taskKey: KEY_A, secretFields: new Set([10]) }),
          buildSnapshot(nodes, { hidden: new Set(), taskKey: KEY_B, secretFields: new Set([10]) }),
        ]) {
          for (const line of s.lines) expect(carries(line.name, value)).toBe(false)
        }
      }),
      { seed: 20261027, numRuns: 200 },
    )
  })
})

/*
 * Certification round 2 (risks). The floor counts every character of the
 * value but spaces, punctuation and symbols included, so a value made of them
 * is still looked for; and a password shown as text is still a password.
 */
describe('the floor counts punctuation and symbols (round 2)', () => {
  function echo(value: string, name: string, secret: boolean): string {
    const nodes = tree({
      id: '1', role: 'RootWebArea', children: [
        { id: '2', role: 'textbox', name: 'Password', value },
        { id: '3', role: 'heading', name },
      ],
    })
    return text(buildSnapshot(nodes, { hidden: new Set(), taskKey: KEY_A, secretFields: secret ? new Set([2]) : new Set() }))
  }

  it('looks for a secret made only of symbols', () => {
    const out = echo('!@#$%^&*', 'You typed !@#$%^&* just now', true)
    expect(out).not.toContain('!@#$%^&*')
    expect(out).toContain('You typed *** just now')
  })

  it('looks for an ordinary value made only of symbols, spaces in the echo ignored', () => {
    expect(echo('!@#$%^&*', 'You typed ! @ # $ % ^ & * now', false)).not.toContain('$ % ^')
  })

  it('looks for "pa$$" in a secret field, and leaves the bare "pa" elsewhere alone', () => {
    const out = echo('pa$$', 'Saved pa$$ for the page', true)
    expect(out).not.toContain('pa$$')
    expect(out).toContain('Saved *** for the page')
    expect(out).toContain('page')
  })

  it('still does not count spaces: "a b c" is under the ordinary floor', () => {
    expect(echo('a b c', 'The abc club', false)).toContain('The abc club')
  })
})

describe('a password shown as text (round 2)', () => {
  it('is secret by its autocomplete: current-password and new-password', () => {
    expect(isSecretInput({ type: 'text', autocomplete: 'current-password' })).toBe(true)
    expect(isSecretInput({ type: 'text', autocomplete: 'new-password' })).toBe(true)
    expect(isSecretInput({ type: 'text', autocomplete: 'username' })).toBe(false)
  })
})
