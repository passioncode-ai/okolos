/**
 * The import walker two gates share.
 *
 * It was one copy inside `reachable.test.ts` until a second gate needed the
 * same graph. The rules below are the ones that matter — get any of them wrong
 * and both gates go quiet rather than fail, because an edge the walker cannot
 * follow simply is not there.
 */

import path from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  agentEntriesFromBuild,
  binEntriesFromPackages,
  entryPoints,
  pageEntriesFromBuild,
  reachableFrom,
  resolve,
  root,
  specifiers,
  tsEntriesFromBuild,
  workerEntryFromWrangler,
} from './imports.mjs'

const content = path.join(root, 'apps/extension/src/content/index.ts')

describe('resolving one specifier', () => {
  it('maps a workspace package to the source its exports name', () => {
    expect(resolve('@okolos/i18n', content)).toBe(path.join(root, 'packages/i18n/src/index.ts'))
  })

  it('follows a .js specifier to the .ts file that is actually on disk', () => {
    // NodeNext makes TypeScript write `./pace.js` for a file called `pace.ts`.
    // A walker that took the extension literally would follow nothing.
    expect(resolve('./pace.js', content)).toBe(path.join(root, 'apps/extension/src/content/pace.ts'))
  })

  it('stops at anything outside this repository', () => {
    expect(resolve('node:fs', content)).toBeNull()
    expect(resolve('@okolos/not-a-package', content)).toBeNull()
  })
})

  it('follows a package subpath through its exports map', () => {
    // `@okolos/ui/words` exists so the worker can take a lookup table without pulling
    // the whole UI graph in. The resolver assumed `src/index.ts` for every workspace
    // specifier, so this resolved to nothing — the module read as unreachable, and
    // everything it imports fell out of the graph with it.
    const from = path.join(root, 'apps/extension/src/background/extensions.ts')
    expect(resolve('@okolos/ui/words', from)).toBe(path.join(root, 'packages/ui/src/words.ts'))
  })

  it('throws on a workspace specifier nothing exports, rather than returning null', () => {
    // `null` means "an npm dependency, outside this graph". A broken `@okolos/…` is a
    // mistake in this repository, and answering it with the same value hides it inside
    // every gate that walks imports.
    const from = path.join(root, 'apps/extension/src/background/extensions.ts')
    expect(() => resolve('@okolos/ui/nothing-like-this', from)).toThrow(/does not export/)
  })

describe('reading one file', () => {
  it('sees static, dynamic and side-effect imports alike', () => {
    const seen = specifiers(content)
    expect(seen).toContain('@okolos/i18n')
    expect(seen.length).toBeGreaterThan(5)
  })
})

describe('walking from an entry', () => {
  it('reaches through a package index into the module behind it', () => {
    const graph = reachableFrom([content])
    expect(graph).toContain(path.join(root, 'packages/ui/src/banner/banner.ts'))
  })

  it('includes the entry itself, so a one-file entry is never empty', () => {
    expect(reachableFrom([content])).toContain(content)
  })
})

describe('the entry list', () => {
  it('comes from the build and wrangler, not from a list of its own', () => {
    // The obvious way to defeat a reachability gate is to declare the orphan an
    // entry point. These five sources are the ones that actually ship code —
    // the build's scripts and pages, the worker wrangler loads, the `bin`
    // an app declares, and Okolos Agent's build (the daemon and its probe). The equality below is the anti-cheat property: the list
    // must be exactly their union, never a hand-written addition.
    expect(tsEntriesFromBuild().length).toBeGreaterThanOrEqual(2)
    expect(pageEntriesFromBuild().length).toBeGreaterThanOrEqual(3)
    expect(workerEntryFromWrangler().length).toBe(1)
    expect(binEntriesFromPackages().length).toBeGreaterThanOrEqual(1)
    expect(agentEntriesFromBuild().map((f) => path.relative(path.resolve(import.meta.dirname, '..'), f).split(path.sep).join('/'))).toEqual([
      'apps/agent/src/main.ts',
      'apps/extension/src/agent-probe-page.ts',
    ])
    expect(entryPoints().length).toBe(
      tsEntriesFromBuild().length +
        agentEntriesFromBuild().length +
        pageEntriesFromBuild().length +
        workerEntryFromWrangler().length +
        binEntriesFromPackages().length,
    )
  })
})
