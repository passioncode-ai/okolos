import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { snapshot } from './feed-snapshot.mjs'

/**
 * Copying the published feed into the committed snapshot — a deliberate act now.
 *
 * The agent used to rewrite the tracked `feeds/phishing.json` on every run, so the
 * worktree was always dirty and a routine git command could take the version
 * counter backwards (F1). The agent writes to its own state; this is how a person
 * or an agent brings the snapshot up to date for a commit.
 */

function feed(dir: string, name: string, version: number | null): string {
  const file = path.join(dir, name)
  mkdirSync(path.dirname(file), { recursive: true })
  if (version !== null) {
    writeFileSync(file, JSON.stringify({ kind: 'snapshot', body: { name: 'phishing', version, updatedAt: '2026-10-03T00:00:00.000Z', entries: ['a.test'] } }))
  }
  return file
}

describe('refreshing the committed snapshot', () => {
  it('copies a newer published feed over the snapshot', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'okolos-snap-'))
    const from = feed(dir, 'state/phishing.json', 52)
    const to = feed(dir, 'repo/feeds/phishing.json', 42)
    expect(snapshot({ from, to })).toMatchObject({ copied: true, version: 52 })
    expect(JSON.parse(readFileSync(to, 'utf8')).body.version).toBe(52)
    expect(readFileSync(to, 'utf8').endsWith('\n')).toBe(true)
  })

  it('refuses to take the snapshot backwards', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'okolos-snap-'))
    const from = feed(dir, 'state/phishing.json', 40)
    const to = feed(dir, 'repo/feeds/phishing.json', 42)
    expect(snapshot({ from, to })).toMatchObject({ copied: false })
    expect(JSON.parse(readFileSync(to, 'utf8')).body.version).toBe(42)
  })

  it('says so when there is nothing published on this machine', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'okolos-snap-'))
    const from = feed(dir, 'state/phishing.json', null)
    const to = feed(dir, 'repo/feeds/phishing.json', 42)
    expect(() => snapshot({ from, to })).toThrow(/no published feed/)
  })
})
