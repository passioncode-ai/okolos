import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { filesUnder } from './tree.mjs'

/**
 * A test that runs git in another directory runs it without the hook's GIT_DIR.
 *
 * The pre-push hook runs the suite with GIT_DIR naming this repository, and a git child that
 * inherits it acts on this repository whatever `-C` says. On 2026-10-27 a test that built a
 * throw-away "dotfiles" repository committed its one file into this checkout's branch, deleting
 * every other file from the commit; the hook then refused the push only because the next test
 * read the broken index. `gitEnv()` (apps/agent/src/service/wellknown.ts) drops the variables,
 * and this gate holds every test that points git elsewhere to it.
 *
 * What it does NOT catch: git started through a helper in another module, or through `spawn`
 * with an argument array built at run time. It reads the call as written.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** A git call pointed at a directory other than the process's own: `'git', ['-C', …`. */
const GIT_ELSEWHERE = /['"]git['"]\s*,\s*\[\s*['"]-C['"]/

export function offenders(files: ReadonlyArray<{ name: string; text: string }>): string[] {
  return files
    .filter((f) => GIT_ELSEWHERE.test(f.text) && !/\bgitEnv\(\)/.test(f.text))
    .map((f) => f.name)
}

const testFiles = ['apps', 'packages', 'tools']
  .flatMap((dir) => filesUnder(path.join(root, dir), '.test.ts') as string[])
  .map((p) => ({ name: path.relative(root, p), text: readFileSync(p, 'utf8') }))

describe('a test that runs git elsewhere does not inherit the hook’s GIT_DIR', () => {
  it('reads the test files, so an empty list cannot pass', () => {
    expect(testFiles.length).toBeGreaterThan(50)
  })

  it('finds no git -C call in a test file that does not pass gitEnv()', () => {
    expect(offenders(testFiles)).toEqual([])
  })

  it('would notice the call that committed into this repository', () => {
    const planted = {
      name: 'planted.test.ts',
      text: "execFileSync('git', ['-C', home, 'commit', '-m', 'dotfiles'], { stdio: 'ignore' })",
    }
    expect(offenders([planted])).toEqual(['planted.test.ts'])
  })
})
