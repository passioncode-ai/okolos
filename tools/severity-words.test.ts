import { readFileSync, globSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { toPosix } from './tree.mjs'

/**
 * One table maps a severity to its word.
 *
 * There were two, under two names — `SEVERITY_KEY` in the banner and `SEVERITY_WORD_KEY` on
 * the dashboard — and the queue was one edit from being a third. The dashboard's own comment
 * records why the table exists at all: a first draft of that band invented
 * `high`/`medium`/`low` and three keys to go with them, "a second vocabulary for severity,
 * introduced by the very pass whose job was to stop one action having two names". Two copies
 * of the *right* table are the same failure one step later — they agree until one is edited,
 * and the screens then disagree about how serious the same finding is.
 *
 * The queue also showed the other half of this class: a surface that carries severity and
 * words it **nowhere**. That is not a duplicate table and no grep for one would find it —
 * it is checked where it can be seen, in `packages/ui/src/queue/queue.test.ts` and on the
 * rendered page.
 */

const root = path.resolve(import.meta.dirname, '..')
const HOME = 'packages/ui/src/severity.ts'

function sources(): string[] {
  // fs.globSync answers in the platform's spelling; HOME is the repository's (B-164).
  return globSync('packages/*/src/**/*.ts', {
    cwd: root,
    exclude: (p) => p.includes('.test.') || toPosix(p).includes('/dist/'),
  }).map((p) => toPosix(p))
}

describe('the severity vocabulary', () => {
  it('lives in one module', () => {
    const offenders: string[] = []
    for (const source of sources()) {
      if (source === HOME) continue
      const text = readFileSync(path.join(root, source), 'utf8')
      // A table is what maps the levels to keys. Naming two of the four levels beside a
      // `bannerSeverity…` key is enough to be one, whatever it is called.
      const declares =
        /critical:\s*'banner[A-Za-z]*'/.test(text) && /minor:\s*'banner[A-Za-z]*'/.test(text)
      if (declares) offenders.push(source)
    }
    expect(
      offenders,
      `import SEVERITY_WORD_KEY from ${HOME} — two copies agree until one is edited, and then two screens disagree about how serious the same finding is`,
    ).toEqual([])
  })

  it('is looking at real sources, so an empty walk cannot pass', () => {
    expect(sources().length).toBeGreaterThan(50)
    expect(readFileSync(path.join(root, HOME), 'utf8')).toContain('export const SEVERITY_WORD_KEY')
  })
})
