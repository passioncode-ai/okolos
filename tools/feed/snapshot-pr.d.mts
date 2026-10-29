/** Types for `snapshot-pr.mjs` (see `bounded.d.mts` for why these are hand-written). */
import type { BoundedOptions, BoundedResult } from './bounded.mjs'
import type { SnapshotPrRecord } from './status.mjs'

export const SNAPSHOT_BRANCH: string
export const SNAPSHOT_PR_AFTER_DAYS: number
export const SNAPSHOT_BUDGET_MS: number
export const SNAPSHOT_DEADLINES: { git: number; gh: number }
export const SNAPSHOT_OUTCOMES: readonly SnapshotPrRecord['outcome'][]

/** Proposes the published feed as the committed snapshot; resolves to a record, never throws. */
export function proposeSnapshot(options: {
  root: string
  feedFile: string
  readServedFeed: () => Promise<{ state: string; version?: number; updatedAt?: string | null; count?: number; text?: string }>
  tool: (command: string, args: string[], options: BoundedOptions) => Promise<BoundedResult>
  env?: Record<string, string | undefined>
  now?: () => number
  deadline?: number
  tmp?: string
  /** A line of the push's output (the pre-push hook's skip notice); the job writes it to feed.log. */
  log?: (line: string) => void
  /** The signal stopping the run, or null: once set, no further child starts. */
  stopped?: () => string | null
}): Promise<SnapshotPrRecord>

/** `~/.okolos/state/snapshot-pr.json`: the last snapshot step, beside the run record. */
export function snapshotPrFile(paths: { state: string }): string
export function readSnapshotPr(file: string): SnapshotPrRecord | null
export function writeSnapshotPr(file: string, record: SnapshotPrRecord): SnapshotPrRecord
/** `next` with `at`, and `since` (first sight of the same pull request) when it names one. */
export function withSince(previous: SnapshotPrRecord | null | undefined, next: SnapshotPrRecord, at: string): SnapshotPrRecord
