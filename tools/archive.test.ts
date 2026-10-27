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

/** bsdtar writes zips; GNU tar (most Linux) does not, so the Windows route is run where bsdtar is. */
const BSDTAR = /bsdtar/.test(spawnSync('tar', ['--version'], { encoding: 'utf8' }).stdout ?? '')

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
    execFileSync('tar', plan.args, { cwd: dir })
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
