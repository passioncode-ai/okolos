/**
 * Types for `bounded.mjs`, hand-written for the reason `tree.d.mts` is: the gates
 * are TypeScript and the tools are plain modules, so a `.mjs` without a declaration
 * is `any` — and `any` is how a test starts agreeing with whatever it is handed.
 */

export interface BoundedResult {
  readonly code: number | null
  readonly signal: string | null
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
  readonly error?: string
}

export interface BoundedOptions {
  readonly cwd?: string
  readonly env?: Record<string, string | undefined>
  readonly timeoutMs: number
  readonly graceMs?: number
  readonly input?: string
  readonly onLine?: (stream: 'stdout' | 'stderr', line: string) => void
}

/** Runs a child in its own process group with a deadline; resolves, never throws. */
export function runBounded(command: string, args: readonly string[], options: BoundedOptions): Promise<BoundedResult>
/** How many groups are still running. */
export function liveGroups(): number
/** SIGTERM to every live group, SIGKILL after the grace. */
export function killAllGroups(graceMs?: number): Promise<void>
