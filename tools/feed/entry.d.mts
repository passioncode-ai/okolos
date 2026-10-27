/** Types for `entry.mjs` (see `bounded.d.mts` for why these are hand-written). */

/** Whether `filename` is the file node was started with, compared as real paths. */
export function isEntry(argv1: string | undefined, filename: string): boolean
