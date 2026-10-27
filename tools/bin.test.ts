import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { binInvocation, endTree, runToCompletion, shCandidates } from './bin.mjs'

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

describe('ending what a tool started (B-164)', () => {
  /** A child that records how it was asked to stop. */
  function child(pid?: number) {
    const signals: Array<string | undefined> = []
    return { pid, signals, kill: (signal?: NodeJS.Signals) => (signals.push(signal), true) }
  }

  it('signals the child itself on macOS and Linux, as child.kill() did', () => {
    const ran: string[][] = []
    for (const platform of ['darwin', 'linux']) {
      const c = child(4242)
      endTree(c, { platform, run: (command, args) => ran.push([command, ...args]) })
      expect(c.signals).toEqual(['SIGTERM'])
    }
    expect(ran).toEqual([])
  })

  it('ends the whole tree under cmd.exe on Windows with taskkill /T /F, not cmd.exe alone', () => {
    const ran: string[][] = []
    const c = child(4242)
    endTree(c, { platform: 'win32', run: (command, args) => ran.push([command, ...args]) })
    expect(ran).toEqual([['taskkill', '/PID', '4242', '/T', '/F']])
    expect(c.signals).toEqual([])
  })

  it('falls back to kill() for a child that never got a pid', () => {
    const ran: string[][] = []
    const c = child(undefined)
    endTree(c, { platform: 'win32', run: (command, args) => ran.push([command, ...args]) })
    expect(ran).toEqual([])
    expect(c.signals).toEqual(['SIGTERM'])
  })
})

describe('running a command to completion', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'okolos-bin-'))
  const script = (name: string, body: string) => {
    const file = path.join(dir, name)
    writeFileSync(file, body)
    return file
  }

  it('resolves when the command exits 0', async () => {
    await expect(runToCompletion('node', [script('ok.mjs', '')], { timeoutMs: 30_000 })).resolves.toBeUndefined()
  })

  it('rejects with the exit code when it fails', async () => {
    await expect(
      runToCompletion('node', [script('fail.mjs', 'process.exit(4)')], { timeoutMs: 30_000 }),
    ).rejects.toThrow(/exit 4/)
  })

  it('ends it at the deadline and says so, rather than waiting', async () => {
    const started = Date.now()
    await expect(
      runToCompletion('node', [script('hang.mjs', 'setTimeout(() => {}, 60_000)')], { timeoutMs: 500 }),
    ).rejects.toThrow(/did not finish within 500 ms/)
    expect(Date.now() - started).toBeLessThan(20_000)
  }, 30_000)
})
