/** Types for `install-feed-agent.mjs` (see `feed/bounded.d.mts` for why these are hand-written). */
import type { BoundedOptions, BoundedResult } from './feed/bounded.mjs'
import type { FeedPaths } from './feed/paths.mjs'
import type { StatusRecord } from './feed/status.mjs'

export const LABEL: string

type Launchctl = (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>
type Tool = (command: string, args: string[], options?: Partial<BoundedOptions>) => Promise<BoundedResult>

export function rendered(options: {
  template?: string
  checkout: string
  runner: string[] | null
  logDir: string
  stateDir?: string
  bootstrap: string
  node?: string
  sourceRepo?: string
  origin?: string
  offMain?: string
}): string
export function installBootstrap(options: { dir: string; from?: string; files?: readonly string[]; log?: (line: string) => void }): void
export function stableNode(options?: { execPath?: string; pathEnv?: string }): string
/** What the installer takes from the working tree (repository-relative): bootstrap sources and the plist template. */
export const INSTALLED_SOURCES: readonly string[]
export interface BranchCheck {
  ok: boolean
  branch: string | null
  head?: string
  target?: string
  /** Installed sources that differ from HEAD: edited, staged, deleted or untracked. */
  changed?: string[]
  reason?: string
}
export function checkBranch(options: { repo?: string; tool?: Tool; env?: Record<string, string | undefined> }): Promise<BranchCheck>
export function offMainNote(branch: BranchCheck, at?: string): string
export function bootstrapDrift(options: { bin: string; from: string; files?: readonly string[] }): {
  matches: boolean | null
  differs: string[]
}
export function originUrl(options: { repo?: string; tool?: Tool; env?: Record<string, string | undefined> }): Promise<string>
/** The environment of every installer child: no Cloudflare credential, git never prompts. */
export function installerEnv(from?: Record<string, string | undefined>): Record<string, string | undefined>
/** `tool` with installerEnv forced on every call. */
export function installerTool(tool?: Tool, from?: Record<string, string | undefined>): Tool
/** execFileSync with installerEnv. */
export function installerRun(command: string, args: readonly string[], options?: { encoding?: BufferEncoding; env?: Record<string, string | undefined> }): string
export function isDisabled(printDisabled: string, label?: string): boolean
export function ensureCheckout(options: {
  repo?: string
  checkout: string
  tool?: Tool
  env?: Record<string, string | undefined>
  log?: (line: string) => void
}): Promise<void>
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
  bin?: string
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
  plistStartsBootstrap: boolean
  bootstrap: boolean
  bootstrapMatchesCheckout: boolean | null
  bootstrapDiffers: string[]
  note?: string
  loaded: boolean
  launchd: { state: string | null; runs: number | null; lastExit: number | null } | null
  lastRun: StatusRecord | null
  log: string
}>
