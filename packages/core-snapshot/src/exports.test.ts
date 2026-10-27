import { createHash } from 'node:crypto'

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import {
  buildSnapshot,
  clampMaxBytes,
  hiddenInputIds,
  MAX_PAGE_BYTES,
  MIN_PAGE_BYTES,
  refOf,
  resolveRef,
  secretFieldIds,
  sha256,
  snapshotVerdict,
  type AxNode,
  type CdpDomNode,
} from '@okolos/core-snapshot'

/*
 * What N-004 and N-011 take from this package instead of writing their own:
 * one resolver for a ref, one hash, one clamp for a page size, one way to name
 * the secret fields (certification round 1, seam).
 */

const KEY = new Uint8Array(32).fill(0x11)
const OTHER = new Uint8Array(32).fill(0x22)
const NONE: ReadonlySet<number> = new Set()

const page: AxNode[] = [
  { nodeId: 'r', role: { value: 'RootWebArea' }, backendDOMNodeId: 1, childIds: ['box', 'f'] },
  { nodeId: 'box', parentId: 'r', role: { value: 'generic' }, backendDOMNodeId: 2, childIds: ['a'] },
  { nodeId: 'a', parentId: 'box', role: { value: 'link' }, name: { value: 'Pay now' }, backendDOMNodeId: 3 },
  { nodeId: 'f', parentId: 'r', role: { value: 'textbox' }, name: { value: 'Card' }, backendDOMNodeId: 4, childIds: ['t'] },
  { nodeId: 't', parentId: 'f', role: { value: 'StaticText' }, name: { value: '4111 1111 1111 1111' }, backendDOMNodeId: 5 },
]

describe('resolveRef', () => {
  const snapshot = buildSnapshot(page, { hidden: NONE, taskKey: KEY, secretFields: NONE })
  const scope = { hidden: NONE, secretFields: NONE }

  it('finds the node behind a ref this task was given, from the snapshot or its map', () => {
    const ref = refOf(3, KEY)
    expect(resolveRef(snapshot, ref, KEY, page, scope)).toEqual({ found: true, backendDOMNodeId: 3, inField: false })
    expect(resolveRef(snapshot.refMap, ref, KEY, page, scope)).toEqual({ found: true, backendDOMNodeId: 3, inField: false })
  })

  it('tells an unknown ref from a hidden one, and says nothing else', () => {
    expect(resolveRef(snapshot, 'e3', KEY, page, scope)).toEqual({ found: false, reason: 'unknown' })
    expect(resolveRef(snapshot, refOf(3, OTHER), KEY, page, scope)).toEqual({ found: false, reason: 'unknown' })
    expect(resolveRef(snapshot, refOf(3, KEY), OTHER, page, scope)).toEqual({ found: false, reason: 'unknown' })
    expect(resolveRef(snapshot, refOf(3, KEY), KEY, page.slice(0, 2), scope)).toEqual({ found: false, reason: 'unknown' })
    // The page hid the link's container after the ref was given out.
    expect(resolveRef(snapshot, refOf(3, KEY), KEY, page, { hidden: new Set([2]), secretFields: NONE })).toEqual({ found: false, reason: 'hidden' })
    expect(resolveRef(snapshot, refOf(3, KEY), KEY, page, { hidden: new Set([3]), secretFields: NONE })).toEqual({ found: false, reason: 'hidden' })
  })

  it('says when a node sits inside a field, a secret one included', () => {
    const stale = new Map([[refOf(5, KEY), 5], [refOf(3, KEY), 3]])
    expect(resolveRef(stale, refOf(5, KEY), KEY, page, scope)).toEqual({ found: true, backendDOMNodeId: 5, inField: true })
    expect(resolveRef(stale, refOf(3, KEY), KEY, page, { hidden: NONE, secretFields: new Set([2]) })).toEqual({ found: true, backendDOMNodeId: 3, inField: true })
  })
})

describe('the key of a ref', () => {
  it('is bytes only: a string key throws, however long', () => {
    expect(() => refOf(1, 'abcdefghijklmnopqrstuvwxyz' as never)).toThrow(RangeError)
    expect(() => refOf(1, Array.from({ length: 32 }, () => 1) as never)).toThrow(RangeError)
  })
})

describe('sha256', () => {
  it('agrees with node:crypto, so N-004 can digest a snapshot with the same hash', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 300 }), (bytes) => {
        expect(Buffer.from(sha256(bytes)).toString('hex')).toBe(createHash('sha256').update(bytes).digest('hex'))
      }),
      { seed: 20261027, numRuns: 200 },
    )
  })

  it('refuses what is not bytes', () => {
    expect(() => sha256('abc' as never)).toThrow(RangeError)
  })
})

describe('clampMaxBytes', () => {
  it('keeps a page size between 1 KB and 32 KB', () => {
    expect([MIN_PAGE_BYTES, MAX_PAGE_BYTES]).toEqual([1024, 32768])
    expect(clampMaxBytes(4096)).toBe(4096)
    expect(clampMaxBytes(1)).toBe(1024)
    expect(clampMaxBytes(-5)).toBe(1024)
    expect(clampMaxBytes(10_000_000)).toBe(32768)
    expect(clampMaxBytes(Number.POSITIVE_INFINITY)).toBe(32768)
    expect(clampMaxBytes(Number.NEGATIVE_INFINITY)).toBe(1024)
    expect(clampMaxBytes(2048.9)).toBe(2048)
  })

  it('reads anything that is not a number as the ceiling, the default page', () => {
    for (const n of [Number.NaN, '4096', undefined, null, {}]) expect(clampMaxBytes(n as never)).toBe(32768)
  })
})

describe('secretFieldIds', () => {
  it('names the inputs and selects a CDP DOM tree marks as secret, in shadow roots and frames too', () => {
    const dom: CdpDomNode = {
      backendNodeId: 1, nodeName: '#document', children: [
        { backendNodeId: 2, nodeName: 'INPUT', attributes: ['type', 'password', 'name', 'pw'] },
        { backendNodeId: 3, nodeName: 'INPUT', attributes: ['autocomplete', 'cc-csc'] },
        { backendNodeId: 4, nodeName: 'SELECT', attributes: ['autocomplete', 'cc-exp-year'] },
        { backendNodeId: 5, nodeName: 'INPUT', attributes: ['type', 'email', 'autocomplete', 'email'] },
        { backendNodeId: 6, nodeName: 'DIV', attributes: ['type', 'password'], shadowRoots: [
          { backendNodeId: 7, nodeName: '#document-fragment', children: [{ backendNodeId: 8, nodeName: 'INPUT', attributes: ['autocomplete', 'one-time-code'] }] },
        ] },
        { backendNodeId: 9, nodeName: 'IFRAME', contentDocument: {
          backendNodeId: 10, nodeName: '#document', children: [{ backendNodeId: 11, nodeName: 'TEXTAREA', attributes: ['autocomplete', 'cc-number'] }],
        } },
      ],
    }
    expect([...secretFieldIds([dom])].sort((a, b) => a - b)).toEqual([2, 3, 4, 8, 11])
    expect(secretFieldIds([])).toEqual(new Set())
  })
})

describe('secretFieldIds and hiddenInputIds (round 2)', () => {
  it('names a text input whose autocomplete says it holds a password', () => {
    const dom: CdpDomNode = {
      backendNodeId: 1, nodeName: '#document', children: [
        { backendNodeId: 2, nodeName: 'INPUT', attributes: ['type', 'text', 'autocomplete', 'current-password'] },
        { backendNodeId: 3, nodeName: 'INPUT', attributes: ['type', 'text', 'autocomplete', 'new-password'] },
        { backendNodeId: 4, nodeName: 'INPUT', attributes: ['type', 'text', 'autocomplete', 'username'] },
      ],
    }
    expect([...secretFieldIds([dom])].sort((a, b) => a - b)).toEqual([2, 3])
  })

  it('names the inputs of type hidden, in shadow roots and frames too, for the caller to add to hidden', () => {
    const dom: CdpDomNode = {
      backendNodeId: 1, nodeName: '#document', children: [
        { backendNodeId: 2, nodeName: 'INPUT', attributes: ['type', 'hidden', 'value', 'never'] },
        { backendNodeId: 3, nodeName: 'input', attributes: ['TYPE', ' Hidden '] },
        { backendNodeId: 4, nodeName: 'INPUT', attributes: ['type', 'text'] },
        { backendNodeId: 5, nodeName: 'DIV', attributes: ['type', 'hidden'], shadowRoots: [
          { backendNodeId: 6, nodeName: '#document-fragment', children: [{ backendNodeId: 7, nodeName: 'INPUT', attributes: ['type', 'hidden'] }] },
        ] },
        { backendNodeId: 8, nodeName: 'IFRAME', contentDocument: {
          backendNodeId: 9, nodeName: '#document', children: [{ backendNodeId: 10, nodeName: 'INPUT', attributes: ['type', 'hidden'] }],
        } },
      ],
    }
    expect([...hiddenInputIds([dom])].sort((a, b) => a - b)).toEqual([2, 3, 7, 10])
    expect(hiddenInputIds([])).toEqual(new Set())
  })

  it('a hidden input passed in hidden masks nothing and is not shown', () => {
    const nodes: AxNode[] = [
      { nodeId: 'r', role: { value: 'RootWebArea' }, backendDOMNodeId: 1, childIds: ['i', 'h'] },
      { nodeId: 'i', parentId: 'r', role: { value: 'textbox' }, value: { value: 'never' }, backendDOMNodeId: 2 },
      { nodeId: 'h', parentId: 'r', role: { value: 'heading' }, name: { value: 'Never wire money' }, backendDOMNodeId: 3 },
    ]
    const hidden = hiddenInputIds([{ backendNodeId: 1, nodeName: '#document', children: [{ backendNodeId: 2, nodeName: 'INPUT', attributes: ['type', 'hidden'] }] }])
    const s = buildSnapshot(nodes, { hidden, taskKey: KEY, secretFields: NONE })
    expect(s.lines.map((l) => `${l.role} ${l.name}`)).toEqual(['heading Never wire money'])
  })
})

describe('a snapshot reports what it could not do', () => {
  it('counts hidden ids that match no node of the tree', () => {
    const s = buildSnapshot(page, { hidden: new Set([2, 999, 1000]), taskKey: KEY, secretFields: NONE })
    expect(s.hiddenUnmatched).toBe(2)
    expect(s.incomplete).toBe(false)
  })

  it('is refused by the verdict when its cleaning did not finish', () => {
    const probe = { verdicts: [], truncated: false, unresolved: 0 }
    expect(snapshotVerdict(probe, { incomplete: false })).toEqual({ level: 'clean', findings: [] })
    expect(snapshotVerdict(probe, { incomplete: true })).toEqual({ refused: 'cleaning_incomplete' })
    const call = snapshotVerdict as (p: typeof probe, s?: unknown) => unknown
    expect(call(probe)).toEqual({ refused: 'cleaning_incomplete' })
  })
})
