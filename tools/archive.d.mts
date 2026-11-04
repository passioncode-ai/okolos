/**
 * Types for `archive.mjs`, hand-written for the reason `tree.d.mts` is: the gates are
 * TypeScript and the tools are plain modules, so a `.mjs` without a declaration is `any`.
 */

/** The command that writes the zip: `zip` on POSIX, System32 `tar.exe -a` on win32. */
export function archivePlan(
  archive: string,
  files: readonly string[],
  options?: { platform?: string; env?: Record<string, string | undefined> },
): { command: string; args: string[] }
/** Entry names from a zip's central directory; directories end in `/`. */
export function zipEntries(bytes: Uint8Array): string[]
/** Files meant to ship that the zip lacks, and files it holds that were not meant to. */
export function compareEntries(
  entries: readonly string[],
  expected: readonly string[],
): { missing: string[]; extra: string[] }
