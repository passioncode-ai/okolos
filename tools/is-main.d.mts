/**
 * Types for `is-main.mjs`, hand-written for the reason `tree.d.mts` is.
 */

/** Whether the module at `filename` is the program, comparing real paths with `argv1`. */
export declare function isMain(
  filename: string,
  argv1?: string,
  realpath?: (file: string) => string,
): boolean
