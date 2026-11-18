import { existsSync } from 'node:fs'
import { rename, rm } from 'node:fs/promises'
import path from 'node:path'

import { directoriesIn } from './tree.mjs'

/**
 * A build writes into a directory of its own and takes the place of the old one at the end.
 *
 * `tools/build.mjs` used to delete `dist/<target>` first and write it again over seconds. The
 * unit suite reads `dist` from several files at once while `tools/gates/bundle-scan.test.ts`
 * rebuilds it in its `beforeAll`, so a reader could land in the empty directory: on the bridge
 * branch, where the build is longer, `bundle-sizes` and `model-stage` failed in turn on the
 * same tree (2026-11-19). Now the old directory stays whole until the new one is complete, and
 * the swap is two renames.
 */

/** Where a build of `finalDir` is written before it replaces it. */
export function buildingDir(finalDir, pid = process.pid) {
  return `${finalDir}.building-${pid}`
}

/** Puts the finished `builtDir` in the place of `finalDir`, then removes what it replaced. */
export async function swapInto(finalDir, builtDir, pid = process.pid) {
  const old = `${finalDir}.old-${pid}`
  if (existsSync(finalDir)) await rename(finalDir, old)
  await rename(builtDir, finalDir)
  await rm(old, { recursive: true, force: true })
}

/**
 * Removes what an earlier build left half done: a `*.building-*` or `*.old-*` beside a target,
 * from a run that was killed. A keyed store build in one of them would otherwise keep the
 * App-Key on disk outside the directories `tools/keyed-builds.mjs` guards.
 */
export async function sweepLeftovers(distDir) {
  if (!existsSync(distDir)) return []
  const gone = []
  for (const name of directoriesIn(distDir)) {
    if (/\.(building|old)-\d+$/.test(name)) {
      await rm(path.join(distDir, name), { recursive: true, force: true })
      gone.push(name)
    }
  }
  return gone
}
