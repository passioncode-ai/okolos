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
