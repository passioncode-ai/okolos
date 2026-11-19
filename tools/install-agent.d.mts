/** Types for `install-agent.mjs` (see `feed/bounded.d.mts` for why these are hand-written). */
export const SERVICE_ID: string
export const LABEL: string
export const PORT: number
export const ORIGIN: string
export interface AgentPaths {
  share: string
  releases: string
  current: string
  command: string
  plist: string
  data: string
  logs: string
  hostToken: string
  serviceLog: string
  stdoutLog: string
}
export function layout(home?: string): AgentPaths
export function releaseName(version?: string, sha?: string): string
export function stageRelease(dir: string): Promise<string>
export function stableNode(execPath?: string, exists?: (file: string) => boolean): string
export function plistFor(paths: AgentPaths, node?: string): string
export function descriptorFor(paths: AgentPaths, now?: Date): Record<string, unknown>
export function commandScript(paths: AgentPaths, node?: string): string
type Run = (argv: string[]) => { status: number; stdout?: string; stderr?: string } | undefined
interface Kit {
  run?: Run
  platform?: string
  uid?: number
  sleep?: (ms: number) => Promise<void>
  fetchWellKnown?: (origin: string) => Promise<unknown>
  timeout?: number
}
export function install(options?: { paths?: AgentPaths; log?: (line: string) => void; dryRun?: boolean; servicesDir?: string } & Kit): Promise<unknown>
export function uninstall(options?: { paths?: AgentPaths; log?: (line: string) => void; purge?: boolean; servicesDir?: string } & Kit): Promise<{ purged: string[] }>
export function status(options?: { paths?: AgentPaths } & Kit): { installed: string | null; plist: boolean; loaded: boolean; command: boolean }
