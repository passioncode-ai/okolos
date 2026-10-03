import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { readStatus, writeStatus } from './status.mjs'

/**
 * A structured status record per run (LC-03), for the host to surface.
 *
 * A failure used to be visible only in `launchctl print … last exit code`, and the
 * agent ran for weeks on a revoked token before anyone looked (B-133).
 */

const file = () => path.join(mkdtempSync(path.join(os.tmpdir(), 'okolos-status-')), 'state', 'feed-status.json')

describe('the feed status record', () => {
  it('holds the fields a host reads, owner-only', () => {
    const f = file()
    writeStatus(f, {
      startedAt: '2026-10-03T12:00:00.000Z',
      at: '2026-10-03T12:01:00.000Z',
      outcome: 'published',
      stage: 'done',
      exit: 0,
      version: 52,
      entries: 280,
    })
    const record = readStatus(f)
    expect(record).toMatchObject({ outcome: 'published', stage: 'done', exit: 0, version: 52, entries: 280 })
    expect(record?.consecutiveFailures).toBe(0)
    expect(statSync(f).mode & 0o777).toBe(0o600)
  })

  it('counts consecutive failures, so two in a row can raise an alert', () => {
    const f = file()
    const failed = { startedAt: '', at: '', outcome: 'failed', stage: 'publish', exit: 1 } as const
    writeStatus(f, failed)
    writeStatus(f, failed)
    expect(readStatus(f)?.consecutiveFailures).toBe(2)
    writeStatus(f, { ...failed, outcome: 'skipped', stage: 'fresh', exit: 0 })
    expect(readStatus(f)?.consecutiveFailures).toBe(0)
  })

  it('keeps the last published version across a skipped run', () => {
    const f = file()
    writeStatus(f, { startedAt: '', at: 'a', outcome: 'published', stage: 'done', exit: 0, version: 52, entries: 9 })
    writeStatus(f, { startedAt: '', at: 'b', outcome: 'skipped', stage: 'fresh', exit: 0 })
    expect(readStatus(f)).toMatchObject({ lastPublished: { version: 52, at: 'a' } })
  })

  it('answers null for a record that is missing or unreadable, not an exception', () => {
    expect(readStatus(path.join(os.tmpdir(), 'okolos-no-such-status.json'))).toBeNull()
  })

  it('is written whole or not at all', () => {
    const f = file()
    writeStatus(f, { startedAt: '', at: '', outcome: 'published', stage: 'done', exit: 0 })
    expect(() => JSON.parse(readFileSync(f, 'utf8'))).not.toThrow()
  })
})
