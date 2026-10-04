/** Types for `publish-feed.mjs` (see `feed/bounded.d.mts` for why these are hand-written). */
import type { BoundedOptions, BoundedResult } from './feed/bounded.mjs'

export const SIGN_TIMEOUT_MS: number
export const WRANGLER_TIMEOUT_MS: number
export const SMOKE_TIMEOUT_MS: number
export const WRANGLER_ARGS: readonly string[]

export function loadEnv(env: Record<string, string | undefined>, file?: string): Record<string, string | undefined>

export function publish(options: {
  input?: string
  dryRun?: boolean
  root?: string
  base?: string
  fetchImpl?: typeof fetch
  run?: (command: string, args: string[], options: BoundedOptions) => Promise<BoundedResult>
  env?: Record<string, string | undefined>
  log?: (line: string) => void
  tmpRoot?: string
  node?: string
}): Promise<{ name: string; version: number; uploaded: boolean }>
