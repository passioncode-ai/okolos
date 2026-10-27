/** Types for `bootstrap.mjs` (see `bounded.d.mts` for why these are hand-written). */
import type { BoundedOptions, BoundedResult } from './bounded.mjs'
import type { FeedPaths } from './paths.mjs'
import type { StatusRecord } from './status.mjs'

type Tool = (command: string, args: string[], options: BoundedOptions) => Promise<BoundedResult>

export const BOOTSTRAP_FILES: readonly string[]
export const EXIT: { ok: number; failed: number; lockHeld: number; watchdog: number; signal: number }
export const RECOVERY_DEADLINES: { git: number; worktree: number; clone: number; install: number }
export const JOB_DEADLINE_MS: number
export const JOB_TAIL_LINES: number

/** The first line that reads as an error, else the last non-empty one. */
export function reasonFrom(lines: readonly string[]): string

export type CheckoutHealth =
  | { readonly state: 'ok' }
  | { readonly state: 'missing' | 'broken'; readonly reason: string }

export function checkoutHealth(options: {
  checkout: string
  tool?: Tool
  env?: Record<string, string | undefined>
}): Promise<CheckoutHealth>

export function recoverCheckout(options: {
  checkout: string
  sourceRepo?: string
  origin?: string
  tool?: Tool
  env?: Record<string, string | undefined>
}): Promise<{ how: string; commit: string }>

export function runAgent(options?: {
  paths?: FeedPaths
  env?: Record<string, string | undefined>
  tool?: Tool
  run?: Tool
  node?: string
  now?: () => number
  log?: (line: string) => void
  runId?: string
  jobDeadlineMs?: number
  onStage?: (stage: string) => void
  relay?: (line: string) => void
  [key: string]: unknown
}): Promise<{ exit: number; record: StatusRecord | null }>
