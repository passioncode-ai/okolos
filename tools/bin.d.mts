/**
 * Types for `bin.mjs`, hand-written for the reason `tree.d.mts` is: the gates are
 * TypeScript and the tools are plain modules, so a `.mjs` without a declaration is `any`.
 */

/** How to spawn `name` (`pnpm`, `npx`): without a shell, or through cmd.exe on win32. */
export function binInvocation(
  name: string,
  args: readonly string[],
  platform?: string,
): { command: string; args: string[]; shell: boolean }
/** Where a POSIX sh can be, in the order to try: `sh`, then Git for Windows' own on win32. */
export function shCandidates(platform?: string, gitExecPath?: string): string[]
/** Ends `child` and its tree: `taskkill /PID <pid> /T /F` on win32, `child.kill(signal)` elsewhere. */
export function endTree(
  child: { pid?: number | undefined; kill: (signal?: NodeJS.Signals) => boolean },
  options?: {
    platform?: string
    signal?: NodeJS.Signals
    run?: (command: string, args: string[]) => unknown
  },
): void
/** Runs `name args…` with inherited stdio; resolves on exit 0, ends the tree at the deadline. */
export function runToCompletion(
  name: string,
  args: readonly string[],
  options: {
    cwd?: string
    timeoutMs: number
    platform?: string
    /** The child, as soon as it is spawned: `pnpm package` hands it to its keyed-build guard. */
    onSpawn?: (child: import('node:child_process').ChildProcess) => void
  },
): Promise<void>

/** A background tool in its own process group on POSIX, so `endTree` ends its children (B-177). */
export function spawnTree(
  name: string,
  args: readonly string[],
  options?: { stdio?: import('node:child_process').StdioOptions; platform?: string },
): import('node:child_process').ChildProcess
