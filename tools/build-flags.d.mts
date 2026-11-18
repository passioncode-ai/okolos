/** Types for the build's decisions, which are plain ESM so `build.mjs` runs without a step. */

/** Whether the content script writes marks a page can read; false only in the store build. */
export declare function pageMarks(input: {
  withTestHooks: boolean
  env: Readonly<Record<string, string | undefined>>
}): boolean
