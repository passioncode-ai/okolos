/** Types for `feed-job.mjs` (see `feed/bounded.d.mts` for why these are hand-written). */
import type { BoundedOptions, BoundedResult } from './feed/bounded.mjs'
import type { FeedPaths } from './feed/paths.mjs'
import type { RunRecord } from './feed/status.mjs'

export const INTERVAL_MS: number
export const STALE_AFTER_MS: number
export const WATCHDOG_MS: number
export const DEADLINES: { git: number; install: number; ingest: number; publish: number }
export const EXIT: { ok: number; failed: number; lockHeld: number; watchdog: number; signal: number }

type Runner = (command: string, args: string[], options: BoundedOptions) => Promise<BoundedResult>

export function sweepLeftovers(tmp?: string, now?: number): string[]

export function runJob(options?: {
  root?: string
  paths?: FeedPaths
  env?: Record<string, string | undefined>
  flags?: { ifStale?: boolean; follow?: boolean; unpinned?: boolean }
  run?: Runner
  tool?: Runner
  fetchImpl?: typeof fetch
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  watchdogMs?: number
  graceMs?: number
  retries?: { attempts: number; backoffMs: number[] }
  log?: (line: string) => void
  node?: string
  tmp?: string
  onStage?: (stage: string) => void
  [key: string]: unknown
}): Promise<RunRecord>
