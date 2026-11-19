import { describe, expect, it } from 'vitest'

import {
  decodeCursor,
  encodeCursor,
  MAX_PAGE_BYTES,
  MIN_PAGE_BYTES,
  paginate,
  renderLine,
  snapshotDigest,
  utf8Bytes,
  type PageOfSnapshot,
  type SnapshotLine,
  type StaleCursor,
} from '@okolos/core-snapshot'

/*
 * The run on Wikipedia (2026-10-06-b0-agent-window-run2.json) kept only sizes:
 * 29 714 nodes. This builds a tree of that shape, deterministically: nested
 * sections of headings, paragraphs and links, with Cyrillic and CJK names so a
 * page boundary falls between multi-byte characters as it does on a real page.
 */
const WIKI_NODES = 29_714
const ROLES = ['heading', 'paragraph', 'link', 'StaticText', 'listitem', 'link', 'cell'] as const
const WORDS = ['Статья', 'history', 'Википедия', '編集', 'reference', 'Примечания', 'see also', 'категория']

function wikiShape(count = WIKI_NODES): SnapshotLine[] {
  const lines: SnapshotLine[] = []
  let seed = 7
  const next = (): number => (seed = (seed * 1103515245 + 12345) % 2147483648)
  for (let i = 0; i < count; i++) {
    const role = ROLES[next() % ROLES.length] ?? 'generic'
    const words = 1 + (next() % 9)
    const name = Array.from({ length: words }, () => WORDS[next() % WORDS.length]).join(' ')
    lines.push({ ref: `r${i.toString(36).padStart(16, 'x')}`, role, name, depth: next() % 14 })
  }
  return lines
}

const VERDICT = { level: 'clean', findings: [] } as const

function isPage<V>(page: PageOfSnapshot<V> | StaleCursor): page is PageOfSnapshot<V> {
  return !('refused' in page)
}

function readAll(lines: readonly SnapshotLine[], maxBytes?: number): PageOfSnapshot<typeof VERDICT>[] {
  const pages: PageOfSnapshot<typeof VERDICT>[] = []
  let cursor: string | undefined
  for (let guard = 0; guard < 10_000; guard++) {
    const page = paginate(lines, { cursor, maxBytes, verdict: VERDICT })
    if (!isPage(page)) throw new Error(`refused: ${page.refused}`)
    pages.push(page)
    if (page.cursor === undefined) return pages
    cursor = page.cursor
  }
  throw new Error('paging did not end')
}

describe('paginate (N-004, REQ-56)', () => {
  it('pages a Wikipedia-shaped tree into pages of at most 32 KB that join back into the whole text', () => {
    const lines = wikiShape()
    expect(lines).toHaveLength(WIKI_NODES)
    const pages = readAll(lines)
    expect(pages.length).toBeGreaterThanOrEqual(8)
    for (const page of pages) expect(utf8Bytes(page.text)).toBeLessThanOrEqual(MAX_PAGE_BYTES)
    expect(pages.map((p) => p.text).join('\n')).toBe(lines.map(renderLine).join('\n'))
    expect(pages.slice(0, -1).every((p) => p.partial)).toBe(true)
    expect(pages.at(-1)?.partial).toBe(false)
  })

  it('refuses a cursor from another snapshot as stale, and a malformed one too', () => {
    const lines = wikiShape(2000)
    const first = paginate(lines, { maxBytes: MIN_PAGE_BYTES, verdict: VERDICT })
    if (!isPage(first) || first.cursor === undefined) throw new Error('expected a partial page')
    const changed = lines.map((l, i) => (i === 3 ? { ...l, name: `${l.name}!` } : l))
    expect(paginate(changed, { cursor: first.cursor, verdict: VERDICT })).toEqual({ refused: 'stale_cursor' })
    for (const bad of ['', 'p1', 'p-1.000000000000000000000000', `p999999.${'0'.repeat(24)}`, 'x'.repeat(4000)]) {
      expect(paginate(lines, { cursor: bad, verdict: VERDICT })).toEqual({ refused: 'stale_cursor' })
    }
    expect(decodeCursor(`p5.${snapshotDigest(changed)}`)).toEqual({ from: 5, digest: snapshotDigest(changed) })
    expect(decodeCursor('p5.zz')).toBeNull()
    // A cursor past the end of this very snapshot names no page of it.
    const past = encodeCursor({ from: lines.length, digest: snapshotDigest(lines) })
    expect(paginate(lines, { cursor: past, verdict: VERDICT })).toEqual({ refused: 'stale_cursor' })
  })

  it('clamps the page size inside paginate: above the ceiling, below the floor, and anything that is not a whole number', () => {
    const lines = wikiShape(4000)
    const size = (maxBytes: unknown): number => {
      const page = paginate(lines, { maxBytes: maxBytes as number, verdict: VERDICT })
      if (!isPage(page)) throw new Error('refused')
      return utf8Bytes(page.text)
    }
    expect(size(10 * MAX_PAGE_BYTES)).toBeLessThanOrEqual(MAX_PAGE_BYTES)
    expect(size(10 * MAX_PAGE_BYTES)).toBeGreaterThan(MAX_PAGE_BYTES - 400)
    expect(size(10)).toBeGreaterThan(MIN_PAGE_BYTES - 400)
    expect(size(10)).toBeLessThanOrEqual(MIN_PAGE_BYTES)
    expect(size(-5)).toBe(size(MIN_PAGE_BYTES))
    expect(size(Number.NaN)).toBe(size(MAX_PAGE_BYTES))
    expect(size('2048')).toBe(size(MAX_PAGE_BYTES))
    expect(size(2048.9)).toBe(size(2048))
  })

  it('carries the verdict of the whole snapshot on every page, and the refs of its own lines', () => {
    const lines = wikiShape(3000)
    const pages = readAll(lines, 4096)
    expect(pages.length).toBeGreaterThan(3)
    for (const page of pages) expect(page.verdict).toBe(VERDICT)
    expect(pages.flatMap((p) => p.refs)).toEqual(lines.map((l) => l.ref))
    for (const page of pages) {
      expect(page.text.split('\n').map((t) => t.trim().split(' ')[0])).toEqual(page.refs)
    }
  })

  it('always moves forward, even when one line is longer than the page', () => {
    const long: SnapshotLine = { ref: 'rlong', role: 'paragraph', name: 'я'.repeat(4000), depth: 0 }
    const lines = [long, long, { ref: 'rend', role: 'link', name: 'end', depth: 0 }]
    const pages = readAll(lines, MIN_PAGE_BYTES)
    expect(pages.map((p) => p.refs)).toEqual([['rlong'], ['rlong'], ['rend']])
  })

  it('answers an empty snapshot with one empty, whole page', () => {
    const page = paginate([], { verdict: VERDICT })
    expect(page).toEqual({ text: '', refs: [], partial: false, verdict: VERDICT })
  })
})
