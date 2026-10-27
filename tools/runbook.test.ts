/**
 * A runbook whose commands do not run is a story about a repository.
 *
 * This project generates what would otherwise drift — icons, tokens, the
 * privacy page — for exactly one reason: a copy nobody regenerates diverges
 * from its source silently. A runbook is the same shape of artefact. It
 * restates `package.json` in prose, and prose does not fail when a script is
 * renamed.
 *
 * So it is checked in both directions. Every command it prints must resolve to
 * something that exists; and every script that exists must be named in it,
 * because a capability nobody knows about differs from a missing one only in
 * that it has already been paid for.
 */

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const runbook = path.join(root, 'docs/runbooks/development.md')
const text = readFileSync(runbook, 'utf8')

const scripts: Record<string, string> = JSON.parse(
  readFileSync(path.join(root, 'package.json'), 'utf8'),
).scripts

/**
 * Documented, but not by being typed.
 *
 * `prepare` is run by pnpm itself; printing it as a command would teach a
 * reader to invoke something they never should. It still has to be explained,
 * and the assertion below checks that it is.
 */
const EXPLAINED_IN_PROSE: Record<string, string> = {
  prepare: 'pnpm runs it during install; a person never types it',
}

/** pnpm's own verbs. `pnpm install` is not a missing script. */
const PNPM_BUILTINS = new Set(['install', 'exec', 'add', 'remove', 'dlx', 'why', 'run', 'store'])

/** Every line inside a fenced block, comments and prompts stripped. */
const commands = [...text.matchAll(/```bash\n([\s\S]*?)```/g)]
  .flatMap((m) => (m[1] as string).split(/\r?\n/))
  .map((line) => line.replace(/#.*$/, '').trim())
  .filter(Boolean)

const invoked = new Set(
  commands.flatMap((c) => {
    const script = /^pnpm\s+(\S+)/.exec(c)?.[1]
    return script && !PNPM_BUILTINS.has(script) ? [script] : []
  }),
)

/**
 * Every assertion below reports the whole offending set rather than stopping at
 * the first member, and none of them sits behind a branch — `tools/test-quality
 * .test.ts` refuses a test that can pass by not running, and it caught this
 * file on its first full run.
 */
describe('the development runbook', () => {
  it('prints commands at all', () => {
    expect(commands.length).toBeGreaterThan(10)
  })

  it('names only scripts that exist', () => {
    const missing = [...invoked].filter((script) => !(script in scripts))
    expect(missing, 'the runbook runs these, and they are not scripts').toEqual([])
  })

  it('names only files that exist', () => {
    const named = commands
      .flatMap((c) => [...c.matchAll(/(?:^|\s)((?:tools|docs|packages|apps)\/[\w./-]+)/g)])
      .map((m) => m[1] as string)
      // A path with a `*` or a `<placeholder>` describes a shape, not a file.
      .filter((file) => !file.includes('*') && !file.includes('<'))
    expect(named.length, 'no file paths in any command').toBeGreaterThan(0)
    const absent = named.filter((file) => !existsSync(path.join(root, file)))
    expect(absent, 'the runbook names these, and they are not there').toEqual([])
  })

  it('leaves no script undocumented', () => {
    /**
     * The half that keeps this file honest as the repository grows. Adding a
     * script and forgetting the runbook is the normal way a runbook decays,
     * and it decays without ever being wrong about anything it already says.
     */
    const all = Object.keys(scripts)
    const unexplained = all.filter((s) => s in EXPLAINED_IN_PROSE && !text.includes(s))
    expect(unexplained, 'exempt from being run, and not explained either').toEqual([])
    const unrun = all.filter((s) => !(s in EXPLAINED_IN_PROSE) && !invoked.has(s))
    expect(unrun, 'these scripts exist and the runbook never runs them').toEqual([])
  })

  it('sends the reader to the runbooks that own the rest', () => {
    // Deploy and signing are their own procedures. A developer runbook that
    // half-explains them is how a second, wrong copy of a deploy step is born.
    expect(text).toContain('worker-deploy.md')
    expect(text).toContain('feed-signing.md')
  })
})
