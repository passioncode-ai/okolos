import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { archivePlan, compareEntries, zipEntries } from './archive.mjs'

/**
 * The release zip, made without the system `zip` on Windows (B-163), and checked by
 * what it contains rather than by its bytes, because two tools make two byte streams.
 */

const FILES = ['manifest.json', 'content.js', '_locales/en/messages.json', 'icons/16.png']

/** A build directory with the four files above. */
function build(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'okolos-archive-'))
  for (const file of FILES) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
    writeFileSync(path.join(dir, file), `contents of ${file}\n`)
  }
  return dir
}

type Probe = (command: string) => string | undefined

/**
 * The bsdtar that runs the Windows arguments here, or undefined where there is none.
 * On Windows it is the program the plan names (System32), because Git for Windows
 * puts GNU tar first on PATH and probing `tar` there would skip the test on the very
 * platform it is for (B-179). Elsewhere it is `tar` from PATH when that is bsdtar
 * (macOS); GNU tar (most Linux) cannot write a zip.
 */
function bsdtarFor(platform: string, env: Record<string, string | undefined>, probe: Probe): string | undefined {
  const command = platform === 'win32' ? archivePlan('a.zip', [], { platform, env }).command : 'tar'
  return /bsdtar/.test(probe(command) ?? '') ? command : undefined
}

const versionOf: Probe = (command) => spawnSync(command, ['--version'], { encoding: 'utf8' }).stdout ?? undefined
const BSDTAR = bsdtarFor(process.platform, process.env, versionOf)

describe('which tool makes the zip', () => {
  it('is zip on macOS and Linux, with the arguments it always had', () => {
    expect(archivePlan('/out/a.zip', FILES, { platform: 'darwin' })).toEqual({
      command: 'zip',
      args: ['-q', '-r', '-X', '/out/a.zip', '.'],
    })
  })

  it('is the System32 tar on Windows, by full path, so GNU tar from Git Bash is never picked', () => {
    const plan = archivePlan('C:\\out\\a.zip', FILES, { platform: 'win32', env: { SystemRoot: 'D:\\Win' } })
    expect(plan.command).toBe('D:\\Win\\System32\\tar.exe')
    expect(plan.args).toEqual(['-a', '-c', '-f', 'C:\\out\\a.zip', ...FILES])
  })

  it('runs the Windows arguments with the System32 tar on Windows, even when GNU tar comes first on PATH', () => {
    const asked: string[] = []
    const probe: Probe = (command) => {
      asked.push(command)
      return command === 'tar' ? 'tar (GNU tar) 1.35' : 'bsdtar 3.7.2 - libarchive 3.7.2'
    }
    expect(bsdtarFor('win32', { SystemRoot: 'D:\\Win' }, probe)).toBe('D:\\Win\\System32\\tar.exe')
    expect(asked).toEqual(['D:\\Win\\System32\\tar.exe'])
  })

  it('runs them with tar from PATH elsewhere, and only when it is bsdtar', () => {
    expect(bsdtarFor('darwin', {}, () => 'bsdtar 3.5.3 - libarchive 3.7.4')).toBe('tar')
    expect(bsdtarFor('linux', {}, () => 'tar (GNU tar) 1.35')).toBeUndefined()
    expect(bsdtarFor('win32', {}, () => undefined)).toBeUndefined()
  })

  it('falls back to C:\\Windows when SystemRoot is unset', () => {
    expect(archivePlan('a.zip', FILES, { platform: 'win32', env: {} }).command).toBe('C:\\Windows\\System32\\tar.exe')
  })
})

describe('what the zip holds', () => {
  it("holds exactly the build's files when made by this platform's tool", () => {
    const dir = build()
    const archive = path.join(mkdtempSync(path.join(os.tmpdir(), 'okolos-zip-')), 'out.zip')
    const plan = archivePlan(archive, FILES)
    execFileSync(plan.command, plan.args, { cwd: dir })
    expect(compareEntries(zipEntries(readFileSync(archive)), FILES)).toEqual({ missing: [], extra: [] })
  })

  // The Windows arguments, run by this machine's bsdtar, which is the same program
  // Windows ships; skipped where `tar` is GNU tar, which cannot write a zip.
  it.skipIf(!BSDTAR)('holds the same files when made by the Windows arguments, with no ./ prefix', () => {
    const dir = build()
    const archive = path.join(mkdtempSync(path.join(os.tmpdir(), 'okolos-zip-')), 'out.zip')
    const plan = archivePlan(archive, FILES, { platform: 'win32' })
    execFileSync(BSDTAR as string, plan.args, { cwd: dir })
    const entries = zipEntries(readFileSync(archive))
    expect(entries.filter((name) => name.startsWith('./'))).toEqual([])
    expect(compareEntries(entries, FILES)).toEqual({ missing: [], extra: [] })
  })

  it('names what is missing and what is extra', () => {
    expect(compareEntries(['a.js', 'dir/', './b.js', '.DS_Store'], ['a.js', 'b.js', 'c.js'])).toEqual({
      missing: ['c.js'],
      extra: ['.DS_Store'],
    })
  })

  it('refuses bytes that are not a zip', () => {
    expect(() => zipEntries(Buffer.from('not a zip at all, but long enough to search'))).toThrow(/not a zip/)
  })
})
