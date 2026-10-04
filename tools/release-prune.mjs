import { existsSync, rmSync } from 'node:fs'
import path from 'node:path'

import { filesIn } from './tree.mjs'

/**
 * Release archives kept on the build machine: the current one and the one before
 * it, for rollback (LC-15). The binaries a release describes live in the stores
 * they were uploaded to, not here; `tools/package.mjs` prunes after every archive
 * it writes, so no person or agent has to remember to.
 */
export const RELEASES_KEPT = 2

const ARCHIVE = /^okolos-([a-z]+)-(\d+(?:\.\d+)*)\.zip$/

function compareVersions(a, b) {
  const left = a.split('.').map(Number)
  const right = b.split('.').map(Number)
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

/** Removes all but the newest `keep` archives per browser in `dir`. Returns the names removed. */
export function pruneReleases(dir, keep = RELEASES_KEPT) {
  if (!existsSync(dir)) return []
  const names = filesIn(dir, '.zip')
  const byTarget = new Map()
  for (const name of names) {
    const match = ARCHIVE.exec(name)
    if (!match) continue
    const [, target, version] = match
    if (!byTarget.has(target)) byTarget.set(target, [])
    byTarget.get(target).push({ name, version })
  }
  const removed = []
  for (const archives of byTarget.values()) {
    archives.sort((a, b) => compareVersions(b.version, a.version))
    for (const { name } of archives.slice(keep)) {
      rmSync(path.join(dir, name), { force: true })
      removed.push(name)
    }
  }
  return removed
}
