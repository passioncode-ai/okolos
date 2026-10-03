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
}

export interface StatusRecord extends RunRecord {
  readonly consecutiveFailures: number
  readonly lastPublished: { version: number | null; entries: number | null; at: string } | null
}

export function readStatus(file: string): StatusRecord | null
export function writeStatus(file: string, record: RunRecord): StatusRecord
