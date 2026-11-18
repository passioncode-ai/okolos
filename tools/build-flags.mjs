/**
 * Decisions the build makes from how it was asked, kept apart from `build.mjs` so they can be
 * tested without building.
 */

/**
 * Whether the content script writes its marks into the page's performance timeline (B-190).
 *
 * The page's own scripts read that timeline as well as the e2e suite does, and an
 * `okolos:collect` entry tells any page that Okolos is installed. The store build, the one
 * `pnpm package` makes with `OKOLOS_USAGE_ENV=production`, writes none; every other build does,
 * the test-hook build always.
 */
export function pageMarks({ withTestHooks, env }) {
  if (withTestHooks) return true
  return env.OKOLOS_USAGE_ENV !== 'production'
}
