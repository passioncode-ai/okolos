/** Types for `feed-snapshot.mjs` (see `feed/bounded.d.mts` for why these are hand-written). */
/** Copies `from` over `to` when it is newer. */
export function snapshot(options?: { from?: string; to?: string }): { copied: boolean; version: number }
