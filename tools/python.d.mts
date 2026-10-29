/**
 * Types for `python.mjs`, hand-written for the reason `tree.d.mts` is: the gates are
 * TypeScript and the tools are plain modules, so a `.mjs` without a declaration is `any`.
 */

/** Exits 0 only under Python 3. */
export const PYTHON3_CHECK: string
/** The names to try on `platform`, in order, as `[command, ...args]`. */
export function pythonCandidates(platform?: string): string[][]
/** The first candidate that proves it is Python 3, or null. */
export function findPython(options?: {
  platform?: string
  probe?: (command: string, args: string[]) => boolean
}): { command: string; args: string[] } | null
/** The environment a linter runs in: UTF-8 mode on win32, unchanged elsewhere. */
export function pythonEnv(
  env?: Record<string, string | undefined>,
  platform?: string,
): Record<string, string | undefined>
/** The refusal printed when no candidate answered. */
export function noPythonMessage(platform?: string): string
