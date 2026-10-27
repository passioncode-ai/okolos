import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

import { isEntry } from './entry.mjs'

/**
 * "Was this file started directly, or imported?" (B-159, fix round 2).
 *
 * tools/feed-job.mjs compared `import.meta.filename` with `process.argv[1]` as
 * strings. Node resolves the main module through symlinks and argv keeps the
 * spelling it was given, so a job started through a symlinked checkout path
 * imported cleanly, ran nothing, exited 0 and wrote no record.
 */

// Symbolic links need a privilege on Windows; the feed agent is a launchd agent, macOS only (ADR-0017).
const posix = process.platform !== 'win32'

function layout() {
  const base = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'okolos-entry-')))
  const real = path.join(base, 'real')
  mkdirSync(path.join(real, 'tools'), { recursive: true })
  const file = path.join(real, 'tools', 'job.mjs')
  writeFileSync(
    file,
    `import { isEntry } from ${JSON.stringify(pathToFileURL(path.join(import.meta.dirname, 'entry.mjs')).href)}\n` +
      `console.log(isEntry(process.argv[1], import.meta.filename) ? 'main' : 'imported')\n`,
  )
  return { base, real, file }
}

describe('the main-module check', () => {
  it('is true for the file itself, false for another or for none', () => {
    const { file, base } = layout()
    expect(isEntry(file, file)).toBe(true)
    expect(isEntry(path.join(base, 'other.mjs'), file)).toBe(false)
    expect(isEntry(undefined, file)).toBe(false)
  })

  it.skipIf(!posix)('sees through a symlinked folder, as node does for the main module', () => {
    const { base, real, file } = layout()
    const linked = path.join(base, 'linked')
    symlinkSync(real, linked)
    expect(isEntry(path.join(linked, 'tools', 'job.mjs'), file)).toBe(true)
  })

  it.skipIf(!posix)('runs a module started through a symlinked checkout path', () => {
    const { base, real } = layout()
    const linked = path.join(base, 'linked')
    symlinkSync(real, linked)
    const result = spawnSync(process.execPath, [path.join(linked, 'tools', 'job.mjs')], { encoding: 'utf8' })
    expect(result.stdout.trim(), result.stderr).toBe('main')
  })
})
