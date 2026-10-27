import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

import { binInvocation, shCandidates } from './bin.mjs'

/**
 * `pnpm` and `npx` are `.cmd` files on Windows, which Node will not spawn without a
 * shell (B-163). The platform is a parameter, so the Windows branch is checked here.
 */

describe('starting pnpm or npx', () => {
  it('spawns without a shell on macOS and Linux, as before', () => {
    expect(binInvocation('pnpm', ['build'], 'darwin')).toEqual({ command: 'pnpm', args: ['build'], shell: false })
    expect(binInvocation('npx', ['wrangler', 'deploy'], 'linux')).toEqual({
      command: 'npx',
      args: ['wrangler', 'deploy'],
      shell: false,
    })
  })

  it('goes through cmd.exe on Windows, where pnpm and npx are .cmd files', () => {
    expect(binInvocation('npx', ['geckodriver', '--port', '4444'], 'win32')).toEqual({
      command: 'npx',
      args: ['geckodriver', '--port', '4444'],
      shell: true,
    })
    expect(binInvocation('npx', ['wrangler', 'd1', 'execute', '--file=schema.sql'], 'win32').shell).toBe(true)
  })

  it('refuses on Windows an argument the shell would reinterpret, rather than quoting it', () => {
    expect(() => binInvocation('npx', ['wrangler', 'a & calc'], 'win32')).toThrow(/cmd\.exe/)
    expect(() => binInvocation('npx', ['wrangler', '%PATH%'], 'win32')).toThrow(/cmd\.exe/)
    expect(() => binInvocation('npx', ['wrangler', ''], 'win32')).toThrow(/cmd\.exe/)
  })

  it('passes the same argument untouched where no shell reads it', () => {
    expect(binInvocation('npx', ['a & calc'], 'linux').args).toEqual(['a & calc'])
  })

  it('starts the real pnpm on this machine', () => {
    const run = binInvocation('pnpm', ['--version'])
    const version = execFileSync(run.command, run.args, { shell: run.shell, encoding: 'utf8' })
    expect(version.trim()).toMatch(/^\d+\.\d+\.\d+/)
  })
})

describe('finding a POSIX sh', () => {
  it('is sh on macOS and Linux', () => {
    expect(shCandidates('darwin')).toEqual(['sh'])
  })

  it("falls back to Git for Windows' own sh, found beside git, on Windows", () => {
    expect(shCandidates('win32', 'C:/Program Files/Git/mingw64/libexec/git-core')).toEqual([
      'sh',
      'C:\\Program Files\\Git\\usr\\bin\\sh.exe',
      'C:\\Program Files\\Git\\bin\\sh.exe',
    ])
  })
})
