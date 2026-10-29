/** Types for `status.mjs` (see `bounded.d.mts` for why these are hand-written). */

export interface RunRecord {
  readonly startedAt: string
  readonly at: string
  readonly outcome: 'published' | 'skipped' | 'failed' | 'refused'
  readonly stage: string
  readonly exit: number
  readonly reason?: string
  readonly version?: number
  readonly entries?: number
  readonly commit?: string | null
  readonly pinned?: boolean
  /** The bootstrap's id for this run, so it can tell the job's record from an older one. */
  readonly runId?: string
  /** True when the bootstrap had to recreate the checkout before this run (B-159, B-150). */
  readonly recoveredCheckout?: boolean
  /** What was wrong with the checkout: `missing` or `broken: <reason>`. */
  readonly recovery?: string
  /** Set when the agent was installed off origin/main with --allow-branch: branch and commits. */
  readonly installedOffMain?: string
  /** After a publish with --snapshot-pr: the snapshot pull request step (B-158). */
  readonly snapshotPr?: SnapshotPrRecord
}

/**
 * What the snapshot pull request step did (`feed/snapshot-pr.mjs`). The job keeps the last
 * one in every later record and in `snapshot-pr.json` until a newer step replaces it.
 * `opened` is never an outcome: it is `pr.action`.
 */
export interface SnapshotPrRecord {
  readonly outcome: 'skipped-fresh' | 'updated' | 'auto-merge-requested' | 'auto-merge-unavailable' | 'failed'
  readonly reason?: string
  readonly branch?: string
  readonly version?: number
  readonly committed?: { readonly version: number; readonly ageDays: number | null }
  readonly commit?: string
  readonly pr?: { readonly number: number; readonly url: string; readonly action: 'opened' | 'updated' }
  /** When this step ran. */
  readonly at?: string
  /** When the pull request in `pr` was first recorded. */
  readonly since?: string
}

export interface StatusRecord extends RunRecord {
  readonly consecutiveFailures: number
  readonly lastPublished: { version: number | null; entries: number | null; at: string } | null
}

export function readStatus(file: string): StatusRecord | null
export function writeStatus(file: string, record: RunRecord): StatusRecord
/** Marks the record as run `runId`'s (plus `facts`), changing nothing else; null when there is none. */
export function stampRunId(file: string, runId: string, facts?: { installedOffMain?: string }): StatusRecord | null
/** `{ installedOffMain }` from OKOLOS_INSTALLED_OFF_MAIN, or nothing. */
export function offMainFacts(env?: Record<string, string | undefined>): { installedOffMain?: string }
