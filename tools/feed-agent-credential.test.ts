import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error — a plain .mjs tool, typed by its use here
import { SLOT, discover, quote, runnerPrefix, xml } from './feed-agent-credential.mjs'

const root = path.resolve(import.meta.dirname, '..')
const plist = () => readFileSync(path.join(root, 'tools/launchd/app.okolos.feed.plist'), 'utf8')

describe('the feed agent takes its token from the vault when there is one', () => {
  it('names the slot the d1-edit preset issues into', () => {
    expect(SLOT).toEqual({ project: 'okolos', env: 'prod', name: 'CLOUDFLARE_API_TOKEN' })
  })

  it('puts --env before the positionals, which is the only order run accepts', () => {
    // `use_secret.py run` takes names as a remainder: a trailing --env is part
    // of the command and the run is refused (measured 2026-09-29).
    const prefix = runnerPrefix({ python: '/opt/py/bin/python3', root: '/opt/obs/engine' })
    expect(prefix).toBe(
      "'/opt/py/bin/python3' '/opt/obs/engine/tools/use_secret.py' run --env prod okolos CLOUDFLARE_API_TOKEN --",
    )
  })

  it('is empty without a door, so the agent still runs on the old path', () => {
    expect(runnerPrefix(null)).toBe('')
  })

  it('keeps a path with a quote or a space one shell word', () => {
    expect(quote("/a b/it's")).toBe(`'/a b/it'\\''s'`)
  })

  it('escapes what a plist string cannot hold', () => {
    expect(xml('a && b <c>')).toBe('a &amp;&amp; b &lt;c&gt;')
  })

  it('says why it falls back, instead of falling back in silence', () => {
    const said: string[] = []
    const missing = () => {
      throw new Error('not found')
    }
    expect(discover({ run: missing, log: (m: string) => said.push(m) })).toBeNull()
    expect(said.join('\n')).toMatch(/not installed/)
  })

  it('refuses a vault that lacks the slot, and names the command that fills it', () => {
    const said: string[] = []
    const run = (cmd: string, args: string[]) =>
      cmd === 'which'
        ? '/opt/bin/project-observatory\n'
        : args[0] === 'full-path'
          ? '/opt/obs/engine\n'
          : 'okolos: nothing in the vault\n'
    const read = () => '#!/opt/py/bin/python3\nimport sys\n'
    expect(discover({ run, read, log: (m: string) => said.push(m) })).toBeNull()
    expect(said.join('\n')).toMatch(/--preset d1-edit --vault okolos\/prod\/CLOUDFLARE_API_TOKEN/)
  })

  it('finds the interpreter from the launcher and the slot from the names listing', () => {
    const run = (cmd: string, args: string[]) =>
      cmd === 'which'
        ? '/opt/bin/project-observatory\n'
        : args[0] === 'full-path'
          ? '/opt/obs/engine\n'
          : '  CLOUDFLARE_API_TOKEN  vault        vault:okolos/prod\n'
    const read = () => '#!/opt/py/bin/python3\n'
    expect(discover({ run, read, log: () => {} })).toEqual({
      python: '/opt/py/bin/python3',
      root: '/opt/obs/engine',
    })
  })

  it('has a place in the committed plist, before the refresh', () => {
    expect(plist()).toContain('cd REPO_PATH &amp;&amp; CREDENTIAL_RUNNER pnpm feed:refresh')
  })
})
