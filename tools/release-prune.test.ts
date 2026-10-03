import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { RELEASES_KEPT, pruneReleases } from './release-prune.mjs'
import { filesIn } from './tree.mjs'

/**
 * Builds clean up after themselves (LC-15): the release directory keeps the current
 * archive and the one before it, per browser, and the prune runs inside the release
 * command rather than as a chore someone remembers.
 */

const root = path.resolve(import.meta.dirname, '..')

function release(dir: string, target: string, version: string, ageMinutes: number) {
  const file = path.join(dir, `okolos-${target}-${version}.zip`)
  writeFileSync(file, 'zip')
  const at = (Date.now() - ageMinutes * 60_000) / 1000
  utimesSync(file, at, at)
}

describe('pruning old release archives', () => {
  it('keeps the current release and the one before it', () => {
    expect(RELEASES_KEPT).toBe(2)
  })

  it('leaves at most two archives per browser after a third build', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'okolos-release-'))
    for (const target of ['chrome', 'firefox']) {
      release(dir, target, '0.0.1', 30)
      release(dir, target, '0.0.2', 20)
      release(dir, target, '0.0.10', 10)
    }
    const removed = pruneReleases(dir)
    expect(removed.sort()).toEqual(['okolos-chrome-0.0.1.zip', 'okolos-firefox-0.0.1.zip'])
    expect(filesIn(dir, '.zip')).toEqual([
      'okolos-chrome-0.0.10.zip',
      'okolos-chrome-0.0.2.zip',
      'okolos-firefox-0.0.10.zip',
      'okolos-firefox-0.0.2.zip',
    ])
  })

  it('orders by version, not by when a file was touched', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'okolos-release-'))
    release(dir, 'chrome', '0.0.9', 1)
    release(dir, 'chrome', '0.0.10', 30)
    release(dir, 'chrome', '0.0.11', 20)
    pruneReleases(dir)
    expect(filesIn(dir, '.zip')).toEqual(['okolos-chrome-0.0.10.zip', 'okolos-chrome-0.0.11.zip'])
  })

  it('touches nothing that is not a release archive', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'okolos-release-'))
    mkdirSync(path.join(dir, 'notes'))
    writeFileSync(path.join(dir, 'README.txt'), '')
    for (const version of ['1.0.0', '1.0.1', '1.0.2']) release(dir, 'chrome', version, 1)
    pruneReleases(dir)
    expect(existsSync(path.join(dir, 'README.txt'))).toBe(true)
    expect(existsSync(path.join(dir, 'notes'))).toBe(true)
  })

  it('answers nothing removed for a directory that does not exist yet', () => {
    expect(pruneReleases(path.join(os.tmpdir(), 'okolos-no-release-dir'))).toEqual([])
  })

  it('is called by the release command after it writes an archive', () => {
    const release = readFileSync(path.join(root, 'tools/package.mjs'), 'utf8')
    const written = release.indexOf("execFileSync('zip'")
    const pruned = release.indexOf('pruneReleases(out)')
    expect(pruned, 'the release command never prunes').toBeGreaterThan(0)
    expect(pruned).toBeGreaterThan(written)
  })
})
