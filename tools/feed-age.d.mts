/**
 * Types for `feed-age.mjs`, hand-written for the reason `tree.d.mts` is: the
 * gates are TypeScript and the tools are plain modules, so a `.mjs` without a
 * declaration is `any` — and `any` is how a gate starts agreeing with whatever
 * it is handed.
 */

/** Days a shipped blocklist may be, past which a release is refused. */
export const FEED_MAX_AGE_DAYS: number
/** The source's own cycle, in hours, as ADR-0010 records it. */
export const FEED_REFRESH_HOURS: number
/** The feed the extension downloads, relative to the repository root. */
export const FEED_PATH: string

/** The newest readable feed among the candidates (default: the snapshot and the agent's state). */
export function freshestFeed(candidates?: readonly string[]): string

/** Age in days, read from `body.updatedAt` rather than from the filesystem. */
export function feedAgeDays(now?: number, file?: string): number

/** A sentence when the feed is too old to ship, `null` when it is not. */
export function feedTooOld(now?: number, file?: string): string | null
