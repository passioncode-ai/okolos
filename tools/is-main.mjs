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
 * `tools/feed/bootstrap.mjs` keeps its own copy of this check on purpose: it is copied
 * out of the checkout with only the modules it imports (BOOTSTRAP_FILES).
 */
import { realpathSync } from 'node:fs'

/**
 * @param {string} filename `import.meta.filename` of the module asking
 * @param {string | undefined} [argv1] what the process was started with
 * @param {(file: string) => string} [realpath]
 * @returns {boolean}
 */
export function isMain(filename, argv1 = process.argv[1], realpath = realpathSync) {
  if (!argv1) return false
  try {
    return realpath(argv1) === realpath(filename)
  } catch {
    return false
  }
}
