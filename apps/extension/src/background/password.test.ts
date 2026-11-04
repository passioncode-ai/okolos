import 'fake-indexeddb/auto'
import { describe, expect, it, vi } from 'vitest'
import type { AuditEntry } from '@okolos/contracts'

import { checkSubmittedPassword, COMMON_SHA1 } from './password.js'
import { openDb, STORES } from '@okolos/storage'

const RARE = 'A1B2C3D4E5F60718293A4B5C6D7E8F9012345678'

function deps(overrides: Partial<Parameters<typeof checkSubmittedPassword>[1]> = {}) {
  const audit: AuditEntry[] = []
  return {
    audit,
    deps: {
      writeAudit: async (entry: AuditEntry) => {
        audit.push(entry)
      },
      now: () => '2026-08-05T12:00:00.000Z',
      newId: () => 'a-1',
      transport: async () => new Response(''),
      ...overrides,
    },
  }
}

describe('the worst passwords cost nothing', () => {
  it('are answered from the built-in list with no request', async () => {
    const transport = vi.fn()
    const { deps: d, audit } = deps({ transport })
    const verdict = await checkSubmittedPassword(COMMON_SHA1[2] as string, d)

    expect(verdict).toMatchObject({ compromised: true, offline: true })
    expect(transport).not.toHaveBeenCalled()
    // And nothing is written to the audit log either, because nothing was sent.
    expect(audit).toEqual([])
  })
})

describe('everything else', () => {
  it('sends five characters and says so in the audit log', async () => {
    const { deps: d, audit } = deps({
      transport: async () => new Response(`${RARE.slice(5)}:9\n`),
    })
    const verdict = await checkSubmittedPassword(RARE, d)

    expect(verdict).toMatchObject({ compromised: true, count: 9 })
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ purpose: 'password-range', outcome: 'sent' })
    expect(audit[0]?.payloadShape).toBe(`hash-prefix:${RARE.slice(0, 5)}`)
  })

  it('asks for a padded response, so the size gives nothing away', async () => {
    const seen: Array<Record<string, string> | undefined> = []
    const { deps: d } = deps({
      transport: async (spec: { headers?: Record<string, string> }) => {
        seen.push(spec.headers)
        return new Response('')
      },
    })
    await checkSubmittedPassword(RARE, d)
    expect(seen[0]).toMatchObject({ 'Add-Padding': 'true' })
  })

  it('never puts the password or its full digest in the request', async () => {
    const urls: string[] = []
    const { deps: d } = deps({
      transport: async (spec: { url: string }) => {
        urls.push(spec.url)
        return new Response('')
      },
    })
    await checkSubmittedPassword(RARE, d)

    expect(urls[0]).toContain(RARE.slice(0, 5))
    expect(urls[0]).not.toContain(RARE.slice(5))
  })

  it('reports a failure as a failure, not as a clean password', async () => {
    const { deps: d } = deps({
      transport: async () => {
        throw new Error('offline')
      },
    })
    const verdict = await checkSubmittedPassword(RARE, d)
    expect(verdict.source).toBe('nothing')
    expect(verdict.compromised).toBe(false)
    expect(verdict.explain.code).toBe('unreachable')
  })
})

describe('the built-in list itself', () => {
  it('is what it claims to be: SHA-1 digests, uppercase hex', () => {
    for (const digest of COMMON_SHA1) {
      expect(digest).toMatch(/^[0-9A-F]{40}$/)
    }
  })

  it('contains the digest of "password", computed rather than remembered', async () => {
    // Guarding against exactly the mistake made while writing this file: a
    // hand-typed digest that looks plausible and matches nothing.
    const bytes = await crypto.subtle.digest('SHA-1', new TextEncoder().encode('password'))
    const hex = [...new Uint8Array(bytes)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase()
    expect(COMMON_SHA1).toContain(hex)
  })

  it('has no duplicates', () => {
    expect(new Set(COMMON_SHA1).size).toBe(COMMON_SHA1.length)
  })
})

describe('the reuse index, and what it puts on disk', () => {
  /**
   * The index answers a question the product refused to answer for two
   * releases, so what it stores is the part worth pinning: a tag that is an
   * HMAC over the digest — never a password, never the digest itself — a host,
   * and the date it was first seen there.
   */
  it('stores a tag, a host and a date, and nothing that resembles a password', async () => {
    const db = await openDb()
    await db.put('reuse', { tag: 'a3f1', host: 'bank.test', seenAt: '2026-08-09' })
    const rows = await db.getAllFromIndex('reuse', 'by-tag', 'a3f1')

    expect(rows).toHaveLength(1)
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual(['host', 'seenAt', 'tag'])
    // A date, not a timestamp: the hour a person logs in is not this index's
    // business, and storing it would make the file a record of their evenings.
    expect(rows[0]?.seenAt).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    await db.clear('reuse')
  })

  it('keeps one row per password per host however often it is submitted', async () => {
    const db = await openDb()
    await db.put('reuse', { tag: 'a3f1', host: 'bank.test', seenAt: '2026-03-01' })
    await db.put('reuse', { tag: 'a3f1', host: 'bank.test', seenAt: '2026-08-09' })
    expect(await db.getAllFromIndex('reuse', 'by-tag', 'a3f1')).toHaveLength(1)
    await db.clear('reuse')
  })

  it('is wiped with everything else, key included', async () => {
    // The device key lives in `settings`, which the data screen clears. An
    // index whose key survived a wipe would be a file the user believed gone.
    const db = await openDb()
    await db.put('reuse', { tag: 'a3f1', host: 'bank.test', seenAt: '2026-08-09' })
    await db.put('settings', { key: 'reuse:key', value: 'a-device-key' })

    for (const store of STORES) await db.clear(store)

    expect(await db.getAll('reuse')).toEqual([])
    expect(await db.get('settings', 'reuse:key')).toBeUndefined()
  })
})

describe('a range service that answers with an error status', () => {
  // Before 2026-10-29 the status was never read: a 503 or 429 body went to the range parser,
  // and a body without the suffix read as "not in a breach" (found while certifying N-109).
  for (const status of [503, 429, 500]) {
    it(`reads ${status} as unanswered, never as a clean password`, async () => {
      const transport = vi.fn(async () => new Response(`0018A45C4D1DEF81644B54AB7F969B88D65:1\n`, { status }))
      const { deps: d } = deps({ transport })
      const verdict = await checkSubmittedPassword(RARE, d)
      expect(verdict.compromised).toBe(false)
      expect(verdict.source).toBe('nothing')
      expect(verdict.explain.code).toBe('unreachable')
    })
  }
})
