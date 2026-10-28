import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

import { isMain } from './is-main.mjs'

/**
 * A tool started through a link still runs its main.
 *
 * The check it replaces compared `import.meta.filename` with `argv[1]` as strings, and
 * through a symlink or a junction those differ, so the tool exited 0 without running.
 */

describe('deciding whether a module is the program', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'okolos-is-main-'))
  const real = path.join(dir, 'tool.mjs')
  writeFileSync(real, '')

  it('says yes for the path it was started with', () => {
    expect(isMain(real, real)).toBe(true)
  })

  it('says yes through a linked directory, which the string comparison said no to', () => {
    // A junction on Windows needs no privilege; elsewhere the type is ignored and this
    // is an ordinary directory symlink.
    const linked = path.join(mkdtempSync(path.join(os.tmpdir(), 'okolos-is-main-link-')), 'tools')
    symlinkSync(dir, linked, 'junction')
    expect(path.join(linked, 'tool.mjs')).not.toBe(real)
    expect(isMain(real, path.join(linked, 'tool.mjs'))).toBe(true)
  })

  it('runs a module started through a linked checkout, as tools/feed-job.mjs is from the bootstrap', () => {
    const base = mkdtempSync(path.join(os.tmpdir(), 'okolos-is-main-run-'))
    mkdirSync(path.join(base, 'real', 'tools'), { recursive: true })
    writeFileSync(
      path.join(base, 'real', 'tools', 'job.mjs'),
      `import { isMain } from ${JSON.stringify(pathToFileURL(path.join(import.meta.dirname, 'is-main.mjs')).href)}\n` +
        `console.log(isMain(import.meta.filename) ? 'main' : 'imported')\n`,
    )
    symlinkSync(path.join(base, 'real'), path.join(base, 'linked'), 'junction')
    const result = spawnSync(process.execPath, [path.join(base, 'linked', 'tools', 'job.mjs')], { encoding: 'utf8' })
    expect(result.stdout.trim(), result.stderr).toBe('main')
  })

  it('says no for another file', () => {
    const other = path.join(dir, 'other.mjs')
    writeFileSync(other, '')
    expect(isMain(real, other)).toBe(false)
  })

  it('says no when there is no argv[1] or it cannot be resolved, rather than guessing', () => {
    expect(isMain(real, undefined)).toBe(false)
    expect(isMain(real, '')).toBe(false)
    expect(isMain(real, path.join(dir, 'gone.mjs'))).toBe(false)
  })

  it('compares what the resolver answers, so the comparison is of real paths', () => {
    const seen: string[] = []
    const resolve = (file: string) => {
      seen.push(file)
      return 'same'
    }
    expect(isMain('/a/tool.mjs', '/b/tool.mjs', resolve)).toBe(true)
    expect(seen).toEqual(['/b/tool.mjs', '/a/tool.mjs'])
  })
})

describe('a module URL as well as a path (B-159, round 9)', () => {
  it('reads import.meta.url, which every node has, the same as import.meta.filename', () => {
    const same = (file: string) => file
    expect(isMain('file:///opt/okolos/bootstrap.mjs', '/opt/okolos/bootstrap.mjs', same)).toBe(true)
    expect(isMain('file:///opt/okolos/bootstrap.mjs', '/opt/okolos/other.mjs', same)).toBe(false)
  })

  it('says no to a missing filename instead of throwing, and the bootstrap passes its URL', () => {
    expect(isMain(undefined as unknown as string, '/x', (f) => f)).toBe(false)
  })
})
