/**
 * What changed since the last time you looked.
 *
 * The default view of a security product's history is the thing that ruins it:
 * an ever-growing red list where last month's handled item sits next to this
 * morning's. So the journal answers a narrower question — what is new since
 * your last check — and full history is something you ask for.
 *
 * Pure, and clock-free: the caller supplies the moment of the last check. That
 * is what makes the same journal produce the same diff wherever it runs.
 */

export type JournalKind = 'verdict' | 'action' | 'error'

export interface JournalEntry {
  readonly id: string
  readonly createdAt: string
  readonly kind: JournalKind
  readonly summary: string
  /**
   * The underlying failure, verbatim, for whoever is writing a bug report.
   *
   * It used to be **inside** `summary`: two writers interpolated `String(cause)` into a
   * sentence from the catalogue, so a reader got an English exception in the middle of a
   * Russian line — "Проверка страницы не завершилась: Error: the background service refused
   * …". The developer-facing text is worth keeping and worth keeping *out* of the sentence;
   * this is where it goes, and the screen shows it as a secondary line the way SCR-20 shows
   * the storage detail: last, because it is what a bug report needs and not what a reader
   * should meet first (B-115).
   */
  readonly diagnostic?: string
  /** Whether the product did it, or the user did. */
  readonly automatic: boolean
  /** An agent did it through Okolos Agent (B-218 wave (c)): neither the product nor the person. */
  readonly byAgent?: boolean
  /** What the agent did lowered a protection: the person can undo it, or already did (WC-2). */
  readonly undo?: 'available' | 'done'
}

export interface DiffGroup {
  readonly kind: JournalKind
  readonly entries: readonly JournalEntry[]
}

export interface Diff {
  /** The moment the diff is measured from; null on a first-ever check. */
  readonly since: string | null
  readonly groups: readonly DiffGroup[]
  readonly total: number
  /** True when the caller could not read part of the journal. */
  readonly incomplete: boolean
  readonly unreadable: number
}

/** Fixed order, so the view does not reshuffle between two openings. */
const KIND_ORDER: readonly JournalKind[] = ['verdict', 'action', 'error']

export function diffSince(
  entries: readonly JournalEntry[],
  since: string | null,
  options: { readonly unreadable?: number } = {},
): Diff {
  const fresh = entries.filter((entry) => since === null || entry.createdAt > since)

  const groups: DiffGroup[] = []
  for (const kind of KIND_ORDER) {
    const inKind = fresh
      .filter((entry) => entry.kind === kind)
      // Newest first: the thing that just happened is the thing being looked for.
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
    if (inKind.length > 0) groups.push({ kind, entries: inKind })
  }

  const unreadable = options.unreadable ?? 0
  return { since, groups, total: fresh.length, incomplete: unreadable > 0, unreadable }
}
