/** Types for `log.mjs` (see `bounded.d.mts` for why these are hand-written). */

export const LOG_MAX_BYTES: number
export const LOG_KEEP: number

/** One printable line: colour codes dropped, and only what a spinner left last. */
export function cleanLine(text: string): string

export interface FeedLog {
  readonly file: string
  write(text: string): void
}

export function openLog(file: string, options?: { maxBytes?: number; keep?: number; now?: () => number }): FeedLog
export function capFile(file: string, options?: { maxBytes?: number; keep?: number }): void
