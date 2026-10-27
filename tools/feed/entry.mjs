import { realpathSync } from 'node:fs'

/**
 * Whether `filename` (a module's `import.meta.filename`) is the file node was
 * started with (`process.argv[1]`).
 *
 * Compared as real paths: node resolves the main module through symlinks, while
 * argv keeps the spelling it was given. A plain string comparison made
 * tools/feed-job.mjs, started through a symlinked checkout path, import cleanly,
 * run nothing and exit 0 without a record (B-159, fix round 2).
 */
// On Windows `.native` also expands 8.3 short names; elsewhere the realpath node itself uses.
const realpath = process.platform === 'win32' ? realpathSync.native : realpathSync

export function isEntry(argv1, filename) {
  if (!argv1) return false
  try {
    return realpath(argv1) === realpath(filename)
  } catch {
    return false
  }
}
