/**
 * One definition of "the directories in here", shared by every gate that walks
 * the tree.
 *
 * `readdirSync(dir)` returns the *entries* of a directory, and the entries are
 * not the directories: macOS writes `.DS_Store` into any folder its Finder has
 * displayed, without being asked and without telling anyone. Three gates read a
 * directory and used each entry as a path segment, so all three were one Finder
 * visit away from a verdict about the file manager wearing the authority of a
 * verdict about the repository:
 *
 *   - `docs.test.ts` counted 20 packages and 3 apps against a document that
 *     correctly said 19 and 2 — red on the developer's machine, green on CI,
 *     where no Finder had ever run. It is the gate `.githooks/pre-push` leans
 *     on, so the only load-bearing gate this project has was refusing every
 *     push while printing the override flag in its own refusal text.
 *   - `locales.test.ts` failed five of its ten checks the moment `_locales`
 *     held one, in the gate that guards the message catalogue.
 *   - `licensing.test.ts` failed to load at all — the throw happens while the
 *     module initialises, so none of its checks run.
 *
 * The second and third were latent rather than absent, which is the worse
 * shape: they were passing because of where a person had happened to click.
 *
 * Two more gates read entries and are safe, for reasons worth naming so nobody
 * "fixes" them: `adr.test.ts` keeps only names matching `^\d{4}-`, and
 * `licensing.test.ts`'s manifest sweep drops paths that do not exist — the
 * second by accident, since that filter was put there for packages without a
 * `package.json`.
 */

import { readdirSync } from 'node:fs'
import path from 'node:path'

/** The directories directly inside `dir`, by name, sorted. */
export function directoriesIn(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
}

/**
 * The files directly inside `dir` whose name ends with `suffix`, sorted.
 *
 * The suffix is required rather than optional: a caller that wants "the files"
 * without saying which is a caller that will accept `.DS_Store` as one.
 */
export function filesIn(dir, suffix) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
    .map((entry) => entry.name)
    .sort()
}

/**
 * Every file under `dir` whose name ends with `suffix`, recursively, sorted.
 *
 * **Added because the rule needed it, not the other way round.** Six gates walked the
 * tree themselves — `coverage-shape`, `docs`, `licensing`, `reachable`, `secrets`,
 * `test-quality` — and forbidding `readdirSync` in `tools/**` without giving them this
 * would have sent them to write an `eslint-disable` instead, which is a boundary that
 * teaches people to step over it (B-58).
 *
 * `skip` names directories, not paths: every one of those six skipped `node_modules`
 * and `dist` and none of them skipped anything else, so that is the default and it is
 * the whole reason the parameter exists rather than a hardcoded pair.
 */
export function filesUnder(dir, suffix, { skip = ['node_modules', 'dist'] } = {}) {
  const skipped = new Set(skip)
  const out = []
  const walk = (here) => {
    for (const entry of readdirSync(here, { withFileTypes: true })) {
      const full = path.join(here, entry.name)
      if (entry.isDirectory()) {
        if (!skipped.has(entry.name)) walk(full)
      } else if (entry.isFile() && entry.name.endsWith(suffix)) {
        out.push(full)
      }
    }
  }
  walk(dir)
  return out.sort(byPosixPath)
}

/**
 * `file` with the platform's separator turned into `/`.
 *
 * Every gate names files the way the repository does, `packages/ui/src/x.ts`, and on
 * macOS and Linux `path.relative` already answers in that form, so a comparison with a
 * literal held there. On Windows it answers `packages\ui\src\x.ts`, and the same
 * comparison failed, or worse, passed: `startsWith('node_modules/')` is never true of a
 * backslashed path, so the check that `node_modules` was skipped held vacuously (B-164).
 * On macOS and Linux this returns its argument unchanged.
 *
 * @param {string} file
 * @param {string} [sep] the separator to replace; the platform's by default
 */
export function toPosix(file, sep = path.sep) {
  return sep === '/' ? file : file.split(sep).join('/')
}

/** `path.relative(from, to)` in the repository's spelling, `/` on every platform. */
export function posixRelative(from, to) {
  return toPosix(path.relative(from, to))
}

/**
 * Sorts as the POSIX spelling would, so two machines list the same tree in one order:
 * a backslash sorts after the capitals and digits, where `/` sorts before them.
 */
function byPosixPath(a, b) {
  const left = toPosix(a)
  const right = toPosix(b)
  return left < right ? -1 : left > right ? 1 : 0
}
