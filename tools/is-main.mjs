/**
 * Was this module started as the program, or imported by one.
 *
 * The tools used to decide with `import.meta.filename === process.argv[1]`. Node
 * resolves the module it runs through symlinks and junctions, so `import.meta.filename`
 * is the real path, while `argv[1]` is the path as typed, made absolute and nothing
 * more. Started through a link (a symlinked checkout, a junction on Windows, a linked
 * `node_modules/.bin` entry) the two differ, the module skipped its main, and the
 * process exited 0 having done nothing. For `tools/python.mjs` that was the UX linter
 * passing without running. `tools/agent-window-spike.mjs` compared
 * `import.meta.url` with `file://` + argv[1], which never holds on Windows at all.
 *
 * Both sides are compared as real paths. When either cannot be resolved (no argv[1],
 * a file that is gone), the answer is no: a module that runs its main on a guess is
 * worse than one that does nothing.
 *
 * This is the one implementation; the feed tools, the installer and the bootstrap all
 * call `isMain(import.meta.filename)`. The bootstrap runs from a flat copy outside the
 * checkout and may import only its siblings, so it imports `./is-main.mjs` from
 * tools/feed (a re-export here in the repo), and the installer copies this file under
 * that name (BOOTSTRAP_SOURCES in tools/feed/bootstrap.mjs).
 */
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * @param {string} filename `import.meta.filename` or `import.meta.url` of the module asking.
 *   The URL is what the bootstrap passes: `import.meta.filename` arrived in node 20.11, and
 *   on an older node in launchd's shell it was undefined, so the bootstrap skipped its main
 *   and exited 0 with no record (round 9 of the B-159 certification).
 * @param {string | undefined} [argv1] what the process was started with
 * @param {(file: string) => string} [realpath]
 * @returns {boolean}
 */
export function isMain(filename, argv1 = process.argv[1], realpath = realpathSync) {
  if (!argv1 || typeof filename !== 'string') return false
  try {
    const own = filename.startsWith('file:') ? fileURLToPath(filename) : filename
    return realpath(argv1) === realpath(own)
  } catch {
    return false
  }
}
