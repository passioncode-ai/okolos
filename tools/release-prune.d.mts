/** Types for `release-prune.mjs` (see `feed/bounded.d.mts` for why these are hand-written). */
export const RELEASES_KEPT: number
/** Removes all but the newest `keep` archives per browser in `dir`; returns the names removed. */
export function pruneReleases(dir: string, keep?: number): string[]
