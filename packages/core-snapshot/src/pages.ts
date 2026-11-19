import { clampMaxBytes, pageOf, renderLine, sha256 } from './snapshot.js'
import type { SnapshotLine } from './snapshot.js'

/** Where the next page starts, and which snapshot it belongs to. */
export interface SnapshotCursor {
  readonly from: number
  /** `snapshotDigest` of the snapshot the cursor was given for. */
  readonly digest: string
}

/**
 * One page of a snapshot as the daemon answers it (spec §3, REQ-56).
 *
 * The verdict is the whole snapshot's, on every page: a page is never judged on
 * its own, so a hidden instruction cut from page 9 still marks page 1.
 */
export interface PageOfSnapshot<V> {
  readonly text: string
  /** The refs of this page's lines, in order. */
  readonly refs: readonly string[]
  /** Present when more lines follow; passed back to read the next page. */
  readonly cursor?: string
  /** True when this page is not the last one. */
  readonly partial: boolean
  readonly verdict: V
}

/** The answer to a cursor that names no page of this snapshot. */
export interface StaleCursor {
  readonly refused: 'stale_cursor'
}

const CURSOR = /^p(\d{1,9})\.([0-9a-f]{24})$/
const MAX_CURSOR_CHARS = 64

/**
 * The digest a cursor carries: SHA-256 over the snapshot's text, cut to 96 bits.
 *
 * It names the snapshot, not a secret: the text is the agent's already. A page
 * changed since the cursor was given (a new snapshot of the same page) has
 * another digest, so its cursor is refused instead of paging into other lines.
 */
export function snapshotDigest(lines: readonly SnapshotLine[]): string {
  const hash = sha256(utf8Encode(lines.map(renderLine).join('\n')))
  let hex = ''
  for (const byte of hash.subarray(0, 12)) hex += byte.toString(16).padStart(2, '0')
  return hex
}

export function encodeCursor(cursor: SnapshotCursor): string {
  return `p${cursor.from}.${cursor.digest}`
}

/** A cursor as the agent sent it, or `null` when it is not one this daemon wrote. */
export function decodeCursor(text: string): SnapshotCursor | null {
  if (typeof text !== 'string' || text.length > MAX_CURSOR_CHARS) return null
  const match = CURSOR.exec(text)
  if (match === null) return null
  const from = Number(match[1])
  const digest = match[2]
  if (!Number.isSafeInteger(from) || digest === undefined) return null
  return { from, digest }
}

/**
 * One page of `lines`, at most `maxBytes` of UTF-8 (clamped by `clampMaxBytes`).
 *
 * Without a cursor the first page; with one, the page it names, if it was given
 * for this very snapshot and points inside it. Anything else is `stale_cursor`:
 * the agent takes a new snapshot rather than reading lines of another one.
 */
export function paginate<V>(
  lines: readonly SnapshotLine[],
  options: { readonly cursor?: string | undefined; readonly maxBytes?: number | undefined; readonly verdict: V },
): PageOfSnapshot<V> | StaleCursor {
  let from = 0
  let digest: string | undefined
  if (options.cursor !== undefined) {
    const cursor = decodeCursor(options.cursor)
    if (cursor === null || cursor.from >= lines.length) return { refused: 'stale_cursor' }
    digest = snapshotDigest(lines)
    if (cursor.digest !== digest) {
      return { refused: 'stale_cursor' }
    }
    from = cursor.from
  }
  const maxBytes = clampMaxBytes(options.maxBytes ?? Number.NaN)
  const page = pageOf(lines, from, maxBytes)
  const refs = lines.slice(page.from, page.to).map((line) => line.ref)
  if (page.next === null) return { text: page.text, refs, partial: false, verdict: options.verdict }
  return {
    text: page.text,
    refs,
    cursor: encodeCursor({ from: page.next, digest: digest ?? snapshotDigest(lines) }),
    partial: true,
    verdict: options.verdict,
  }
}

/** UTF-8 bytes of a string, in plain code: core-* touches no platform API. */
function utf8Encode(text: string): Uint8Array {
  const out: number[] = []
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0
    if (cp < 0x80) out.push(cp)
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63))
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63))
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63))
  }
  return Uint8Array.from(out)
}
