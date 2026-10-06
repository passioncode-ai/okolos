/**
 * Every source file must be reachable from something that ships.
 *
 * Three times in this codebase a requirement was closed on a module nothing
 * called. `analysePackage` had tests and no caller. `renderStatus` had tests, a
 * screen record, and no page that loaded it. `updateFeed` had tests, two
 * requirements, and no install that ever fetched a feed — so the extension
 * blocked nothing. In all three the unit tests were green, because a module's
 * tests answer "does it work", never "does anything run it".
 *
 * This gate answers the second question. It walks the import graph from the
 * entry points the build actually names, and requires every non-test source
 * file to be inside it.
 *
 * The obvious way to defeat a reachability gate is to declare the orphan an
 * entry point. So the entry list is not taken on trust: each entry must be
 * named by `tools/build.mjs`, by an HTML page that build loads, or by
 * `wrangler.toml`. An entry nobody ships is not an entry.
 *
 * What this gate does NOT catch: a symbol exported from a reachable file that
 * no reachable code uses. File-level reachability is the coarse half of the
 * question; it is the half that produced all three defects above.
 */

import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { filesUnder } from './tree.mjs'
import {
  entryPoints,
  pageEntriesFromBuild,
  reachableFrom,
  tsEntriesFromBuild,
  workerEntryFromWrangler,
} from './imports.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const rel = (p: string) => path.relative(root, p)

/**
 * Files with no importer, each with the reason nothing imports them. A reason
 * is not a formality: it is the sentence someone writes instead of noticing
 * their feature never shipped.
 */
const EXEMPT: ReadonlyArray<{ readonly file: string; readonly why: string }> = [
  { file: 'apps/extension/src/agent-probe.ts', why: 'Okolos Bridge Б1: the daemon apps/agent (module K3, B-142) is the caller and is not written yet. Branch bridge/b1 does not merge to main until K3 removes this row' },
  { file: 'packages/core-snapshot/src/index.ts', why: 'Okolos Bridge Б1: the daemon apps/agent (module K3, B-142) is the caller and is not written yet. Branch bridge/b1 does not merge to main until K3 removes this row' },
  { file: 'packages/core-snapshot/src/snapshot.ts', why: 'Okolos Bridge Б1: the daemon apps/agent (module K3, B-142) is the caller and is not written yet. Branch bridge/b1 does not merge to main until K3 removes this row' },
]

// ---------------------------------------------------------------------------
// Entry points, and the evidence that each one ships.
// ---------------------------------------------------------------------------

function sourceFiles(): string[] {
  // The walk is `filesUnder`'s; "not a test, not a declaration" is this gate's rule.
  return ['packages', 'apps']
    .flatMap((dir) => filesUnder(path.join(root, dir), '.ts'))
    /**
     * A file a runner loads is not a file something imports.
     *
     * `.test.ts` was here from the start; `.bench.ts` joined it on 2026-08-20, when the
     * first benchmarks were written and this gate reported both as orphans (B-49). Same
     * class, same reason: vitest finds them by name, so an import of them cannot exist
     * and their absence from the graph is the design rather than a hole in it.
     */
    .filter(
      (file) =>
        !file.endsWith('.test.ts') && !file.endsWith('.bench.ts') && !file.endsWith('.d.ts'),
    )
}

// ---------------------------------------------------------------------------

describe('every source file is reachable from something that ships', () => {
  it('finds entry points in the build, not in a list of its own', () => {
    // If this drops to nothing the gate below passes vacuously — every file
    // would be unreachable, the assertion would be one huge failure, and the
    // temptation would be to weaken it rather than read it.
    expect(tsEntriesFromBuild().length).toBeGreaterThanOrEqual(2)
    expect(pageEntriesFromBuild().length).toBeGreaterThanOrEqual(3)
    expect(workerEntryFromWrangler().length).toBe(1)
  })

  it('names only entry points the build or wrangler actually loads', () => {
    for (const entry of entryPoints()) {
      expect(existsSync(entry), `entry point does not exist: ${rel(entry)}`).toBe(true)
    }
  })

  it('leaves no source file that nothing imports', () => {
    const reachable = reachableFrom(entryPoints())
    const exempt = new Set(EXEMPT.map((e) => path.join(root, e.file)))
    const orphans = sourceFiles()
      .filter((f) => !reachable.has(f) && !exempt.has(f))
      .map(rel)
      .sort()

    expect(
      orphans,
      orphans.length === 0
        ? ''
        : `unreachable from every entry point — nothing that ships imports these:\n  ${orphans.join('\n  ')}\n` +
          `A module no entry point reaches cannot close a requirement, however green its own tests are. ` +
          `Wire it to a caller, delete it, or add it to EXEMPT with the reason nothing imports it.`,
    ).toEqual([])
  })

  it('requires an exemption to name a real file and give a real reason', () => {
    for (const { file, why } of EXEMPT) {
      expect(existsSync(path.join(root, file)), `exempt file does not exist: ${file}`).toBe(true)
      expect(why.length, `exemption for ${file} needs a reason, not a word`).toBeGreaterThan(40)
    }
  })
})
