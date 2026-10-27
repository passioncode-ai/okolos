/**
 * Types for `find-firefox.mjs`, hand-written for the reason `tree.d.mts` is: the gates
 * are TypeScript and the tools are plain modules, so a `.mjs` without a declaration is `any`.
 */

export interface FindOptions {
  platform?: string
  env?: Record<string, string | undefined>
  home?: string
}

/** Where Playwright's browser cache can be on the platform, most specific first. */
export function playwrightCaches(options?: FindOptions): string[]
/** The binary inside one `firefox-<build>` directory, per layout. */
export function firefoxSuffixes(platform?: string): string[]
/** The newest Playwright Firefox, or FIREFOX_BINARY; throws when there is none. */
export function findFirefox(
  options?: FindOptions & { exists?: (file: string) => boolean; list?: (dir: string) => string[] },
): string
