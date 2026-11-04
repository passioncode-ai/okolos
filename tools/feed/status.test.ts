import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { readStatus, stampRunId, writeStatus } from './status.mjs'

/**
 * A structured status record per run (LC-03), for the host to surface.
 *
 * A failure used to be visible only in `launchctl print … last exit code`, and the
 * agent ran for weeks on a revoked token before anyone looked (B-133).
 */

const file = () => path.join(mkdtempSync(path.join(os.tmpdir(), 'okolos-status-')), 'state', 'feed-status.json')

/**
 * Windows has no POSIX mode bits (`stat().mode & 0o777` reads 0o666 there whatever
 * was asked), so the owner-only assertion runs on macOS and Linux, where the feed
 * agent runs, and is skipped on win32 rather than loosened everywhere (B-162).
 */
const NO_POSIX_MODES = process.platform === 'win32'

const published = {
  startedAt: '2026-10-03T12:00:00.000Z',
  at: '2026-10-03T12:01:00.000Z',
  outcome: 'published',
  stage: 'done',
  exit: 0,
  version: 52,
  entries: 280,
} as const

describe('the feed status record', () => {
  it('holds the fields a host reads', () => {
    const f = file()
    writeStatus(f, published)
    const record = readStatus(f)
    expect(record).toMatchObject({ outcome: 'published', stage: 'done', exit: 0, version: 52, entries: 280 })
    expect(record?.consecutiveFailures).toBe(0)
  })

  it.skipIf(NO_POSIX_MODES)('is written owner-only', () => {
    const f = file()
    writeStatus(f, published)
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

  it('stamps a run id into a record without changing anything else, the count included', () => {
    const f = file()
    const failed = { startedAt: '', at: 'x', outcome: 'failed', stage: 'publish', exit: 1 } as const
    writeStatus(f, failed)
    writeStatus(f, failed)
    const stamped = stampRunId(f, 'launch-1-2')
    expect(stamped).toMatchObject({ runId: 'launch-1-2', consecutiveFailures: 2, stage: 'publish', at: 'x' })
    expect(readStatus(f)).toEqual(stamped)
  })

  it('stamps the id where writeStatus puts it, before the count and the last publish', () => {
    // The plist's launch line copies the last publish from its key to the record's
    // end; an id stamped after it would ride into the next launch record (B-159).
    const f = file()
    writeStatus(f, published)
    writeStatus(f, { startedAt: '', at: 'x', outcome: 'failed', stage: 'publish', exit: 1 })
    stampRunId(f, 'launch-1-2')
    expect(Object.keys(readStatus(f) ?? {}).slice(-3)).toEqual(['runId', 'consecutiveFailures', 'lastPublished'])
  })

  it('stamps nothing when there is no record', () => {
    expect(stampRunId(path.join(os.tmpdir(), 'okolos-no-such-status.json'), 'r')).toBeNull()
  })

  it('is written whole or not at all', () => {
    const f = file()
    writeStatus(f, { startedAt: '', at: '', outcome: 'published', stage: 'done', exit: 0 })
    expect(() => JSON.parse(readFileSync(f, 'utf8'))).not.toThrow()
  })
})
