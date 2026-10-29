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
}): Promise<SnapshotPrRecord>
