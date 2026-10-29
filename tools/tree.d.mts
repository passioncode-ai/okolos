/**
 * Types for the tree walker, which is plain ESM so every gate can share one
 * definition of what counts as a directory here. A test that treats these as
 * `any` is a test that cannot catch a rename — the same reason
 * `imports.d.mts` exists.
 */

export declare function directoriesIn(dir: string): string[]
export declare function filesIn(dir: string, suffix: string): string[]

/**
 * Every file under `dir` whose name ends with `suffix`, recursively, sorted, absolute.
 *
 * `skip` names directories rather than paths, and defaults to `node_modules` and
 * `dist` — the pair every caller was skipping by hand. A missing `dir` **throws**: a
 * gate handed a wrong path and answered "no files" is absence reading as a pass, so a
 * caller for whom missing is a real state says so itself.
 */
export declare function filesUnder(
  dir: string,
  suffix: string,
  options?: { skip?: readonly string[] },
): string[]


/** `file` with the platform's separator (or `sep`) turned into `/`; unchanged on POSIX. */
export declare function toPosix(file: string, sep?: string): string

/** `path.relative(from, to)` spelled with `/` on every platform, as the repository names files. */
export declare function posixRelative(from: string, to: string): string
