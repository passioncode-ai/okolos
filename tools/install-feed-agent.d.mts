/** Types for `install-feed-agent.mjs` (see `feed/bounded.d.mts` for why these are hand-written). */
import type { BoundedOptions, BoundedResult } from './feed/bounded.mjs'
import type { FeedPaths } from './feed/paths.mjs'
import type { StatusRecord } from './feed/status.mjs'

export const LABEL: string

type Launchctl = (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>
type Tool = (command: string, args: string[], options?: Partial<BoundedOptions>) => Promise<BoundedResult>

export function rendered(options: { template?: string; checkout: string; runner: string[] | null; logDir: string }): string
export function isDisabled(printDisabled: string, label?: string): boolean
export function ensureCheckout(options: { repo?: string; checkout: string; tool?: Tool; log?: (line: string) => void }): Promise<void>
export function installAgent(options: {
  label?: string
  domain: string
  target: string
  plist: string
  launchctl?: Launchctl
  log?: (line: string) => void
}): Promise<{ state: 'loaded' | 'disabled' }>
export function uninstallAgent(options: {
  label?: string
  domain: string
  target: string
  launchctl?: Launchctl
  log?: (line: string) => void
  purge?: { repo: string; paths: FeedPaths; tool?: Tool }
}): Promise<{ ok: boolean; reason?: string }>
export function agentStatus(options: {
  label?: string
  domain: string
  target: string
  launchctl?: Launchctl
  paths?: FeedPaths
}): Promise<{
  plist: boolean
  loaded: boolean
  launchd: { state: string | null; runs: number | null; lastExit: number | null } | null
  lastRun: StatusRecord | null
  log: string
}>
