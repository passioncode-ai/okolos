import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import {
  FEED_MAX_AGE_DAYS,
  FEED_PATH,
  FEED_REFRESH_HOURS,
  feedAgeDays,
  feedTooOld,
  freshestFeed,
} from './feed-age.mjs'

/**
 * There was no gate of any kind on how old the shipped blocklist is.
 *
 * Measured 2026-08-19: the feed in the repository and the one the extension
 * downloads matched, the signature verified against the build key, and every
 * test in the project was green — about a list that was five days and
 * twenty-two hours old against a source turning over every twelve hours. The
 * intersection of its 248 hosts with that day's OpenPhish was **one host**. The
 * extension asked four times a day and got the same file back.
 *
 * Every mechanism working perfectly on a list that protects almost nobody is the
 * failure this file exists to make loud.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** A feed whose timestamp is exactly `days` old, in a directory of its own. */
function feedAged(days: number): { file: string; now: number } {
  const now = Date.UTC(2026, 7, 20, 12, 0, 0)
  const dir = mkdtempSync(path.join(os.tmpdir(), 'okolos-feed-'))
  const file = path.join(dir, 'phishing.json')
  writeFileSync(
    file,
    JSON.stringify({
      kind: 'snapshot',
      body: {
        name: 'phishing',
        version: 5,
        updatedAt: new Date(now - days * 86_400_000).toISOString(),
        entries: ['bad.test'],
      },
    }),
  )
  return { file, now }
}

describe('how old the shipped feed is', () => {
  it('reads the age from the timestamp the feed carries, not from the file', () => {
    /**
     * A checkout, a rebase or a copy rewrites mtime, so the filesystem would
     * report a fresh feed for a file whose contents were built a month ago — and
     * on CI, where the tree was cloned this minute, every feed would look new.
     * `body.updatedAt` is what the signature covers.
     */
    const { file, now } = feedAged(3)
    expect(feedAgeDays(now, file)).toBeCloseTo(3, 5)
  })

  it('says nothing is wrong while the feed is within the ceiling', () => {
    const { file, now } = feedAged(FEED_MAX_AGE_DAYS - 0.5)
    expect(feedTooOld(now, file)).toBeNull()
  })

  it('refuses past it, and the sentence says what to do about it', () => {
    // A boolean would tell the person about to publish nothing they can act on.
    const { file, now } = feedAged(FEED_MAX_AGE_DAYS + 1)
    const complaint = feedTooOld(now, file) ?? ''
    expect(complaint).toContain('days old')
    expect(complaint, 'the command that fixes it').toContain('pnpm feed:refresh')
    expect(complaint, 'and the way to stop having to remember it').toContain('launchd')
  })

  it('refuses a feed with no timestamp rather than treating it as fresh', () => {
    /**
     * Absence of data must not read as a pass. A feed built by a tool that
     * stopped writing `updatedAt` would otherwise be permanently new, which is
     * the same failure as the one being fixed, arrived at from the other side.
     */
    const dir = mkdtempSync(path.join(os.tmpdir(), 'okolos-feed-'))
    const file = path.join(dir, 'phishing.json')
    writeFileSync(file, JSON.stringify({ kind: 'snapshot', body: { name: 'phishing' } }))
    expect(() => feedAgeDays(Date.now(), file)).toThrow(/no body.updatedAt/)
  })

  it('refuses a timestamp it cannot read, for the same reason', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'okolos-feed-'))
    const file = path.join(dir, 'phishing.json')
    writeFileSync(
      file,
      JSON.stringify({ kind: 'snapshot', body: { name: 'phishing', updatedAt: 'soon' } }),
    )
    expect(() => feedAgeDays(Date.now(), file)).toThrow(/unreadable/)
  })
})

describe('where the ceiling comes from, and where the gate lives', () => {
  it('is stated in the module and in ADR-0010, with the same number of hours', () => {
    // The source's cycle is the ADR's fact; the ceiling is this module's
    // decision. Both live in one place each, and this is where they meet.
    const adr = readFileSync(
      path.join(root, 'docs/adr/0010-the-blocklist-is-about-hosts-so-the-sources-must-be.md'),
      'utf8',
    )
    expect(adr).toContain(`раз в ${FEED_REFRESH_HOURS} часов`)
    expect(adr, 'the ADR must name the ceiling this gate enforces').toContain(
      `${FEED_MAX_AGE_DAYS} дней`,
    )
  })

  it('is enforced by the release gate rather than by every commit', () => {
    /**
     * The placement is the decision, not an accident. Publishing is local by
     * ADR-0002 — the signing key never leaves the machine — so a freshness check
     * on every commit would be red for a reason nobody can fix from where they
     * are standing, and that is how a project learns to pass
     * `OKOLOS_SKIP_GATES=1`. B-26 was that lesson costing a day.
     */
    const release = readFileSync(path.join(root, 'tools/package.mjs'), 'utf8')
    expect(release).toContain('feedTooOld(Date.now(), shipped)')
    expect(release).toContain('freshestFeed()')
    expect(release, 'the refusal must stop the release, not warn beside it').toMatch(
      /die\(stale\)/,
    )
  })

  it('names the feed the extension actually downloads', () => {
    // A gate on a file nobody ships is a gate about nothing. The agent writes its
    // state outside the tree (F1); the committed snapshot is refreshed from it by
    // `pnpm feed:snapshot`, and the gate reads whichever of the two is newer.
    const scripts = (JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }).scripts
    expect(scripts['feed:refresh']).toContain('tools/feed-job.mjs')
    expect(scripts['feed:snapshot']).toContain('tools/feed-snapshot.mjs')
    expect(FEED_PATH).toBe('feeds/phishing.json')
  })

  it('reads the newer of the committed snapshot and the agent’s state', () => {
    // The agent no longer rewrites the tracked file, so on the publishing machine
    // the state file is the fresh one; on CI only the snapshot exists.
    const old = feedAged(FEED_MAX_AGE_DAYS + 5)
    const fresh = feedAged(1)
    expect(freshestFeed([old.file, fresh.file])).toBe(fresh.file)
    expect(freshestFeed([old.file, path.join(os.tmpdir(), 'okolos-no-such-feed.json')])).toBe(old.file)
    expect(feedTooOld(fresh.now, freshestFeed([old.file, fresh.file]))).toBeNull()
  })
})

describe('the agent that stops this being a thing anyone remembers', () => {
  const plist = () =>
    readFileSync(path.join(root, 'tools/launchd/app.okolos.feed.plist'), 'utf8')

  it('refreshes on the source’s own cycle', () => {
    // 43200 seconds is twelve hours, which is what ADR-0010 records.
    expect(plist()).toContain(`<integer>${FEED_REFRESH_HOURS * 3600}</integer>`)
  })

  it('runs once when it is loaded, rather than promising to in twelve hours', () => {
    expect(plist()).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/)
  })

  it('keeps the checkout path a placeholder, because an absolute path is right once', () => {
    /**
     * A committed absolute path is correct on exactly one machine and silently
     * wrong everywhere else — launchd would fail every twelve hours with nothing
     * on any screen. The installer fills it in and writes the copy launchd reads.
     */
    expect(plist()).toContain('{{CHECKOUT}}')
    expect(plist()).not.toMatch(/\/Users\/[a-z]/)
  })

  it('is installed by one command, and the file says which', () => {
    // The human step this reduces: one command, which also creates the agent's
    // checkout and refuses to re-enable an agent the operator disabled.
    expect(plist()).toContain('pnpm feed:agent')
  })

  it('does not keep itself alive, because it is a task that finishes', () => {
    // `KeepAlive` on a script that exits is a restart loop. The *key* is what
    // must be absent — the file explains in a comment why it is not there, and a
    // test that forbids the word forbids the explanation with it.
    expect(plist()).not.toMatch(/<key>KeepAlive<\/key>/)
  })

  it('writes somewhere a person can read afterwards', () => {
    expect(plist()).toContain('StandardErrorPath')
  })
})
