/** Types for `feed-snapshot.mjs` (see `feed/bounded.d.mts` for why these are hand-written). */
/** Copies `from` over `to` when it is newer. */
export function snapshot(options?: { from?: string; to?: string }): { copied: boolean; version: number }
/** The committed snapshot's bytes for a published feed's text: the text, ending in one newline. */
export function snapshotText(text: string): string
