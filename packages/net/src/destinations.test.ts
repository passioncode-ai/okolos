import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { allowedDestination, DESTINATIONS } from './destinations.js'
import { DestinationError, request, type RequestDeps } from './request.js'
import type { AuditEntry, Purpose } from '@okolos/contracts'

/**
 * Where each purpose may send, and the fact that anybody checks.
 *
 * The egress point was otherwise exemplary — one `fetch` in the tree, the audit
 * entry written before the request and a failed write cancelling it, a closed set
 * of purposes, a redactor with two rounds of percent-decoding. And the
 * destination was computed **for the journal only**: any URL with a valid purpose
 * and a clean payload went to any host.
 *
 * Hosts were gated by a document test that swept `https://` literals out of
 * `apps/extension/src`. Three ways past it, none exotic: a literal in `packages/`
 * — where the model manager's and the leak lookup's own URLs live — a URL
 * assembled from parts, and anything not spelled `https://`.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

function deps(overrides: Partial<RequestDeps> = {}): RequestDeps & { written: AuditEntry[] } {
  const written: AuditEntry[] = []
  return {
    written,
    writeAudit: async (entry) => {
      written.push(entry)
    },
    transport: async () => new Response('ok'),
    now: () => '2026-08-20T06:00:00.000Z',
    newId: () => 'a1',
    ...overrides,
  }
}

const spec = (purpose: Purpose, url: string) => ({
  url,
  method: 'GET' as const,
  purpose,
  payloadShape: 'nothing',
  triggeredBy: 'test',
})

describe('the list itself', () => {
  it('names every purpose the request module accepts', () => {
    /**
     * A purpose missing from this table would fall to `undefined` in
     * `allowedDestination` and be refused — safe, but silently, and the person
     * adding it would learn only from a runtime failure. `Record<Purpose, …>`
     * fails the build instead, and this says the same thing where a test run can
     * see it.
     */
    expect(Object.keys(DESTINATIONS).sort()).toEqual([
      'domain-status',
      'feed-update',
      'file-hash',
      'leak-lookup',
      'model-update',
      'password-range',
      'usage-data',
    ])
  })

  it('gives every host with a destination a bare hostname, not a URL', () => {
    // A `https://` prefix or a trailing path here would never match a hostname
    // and the purpose would be silently unable to send anywhere.
    for (const [purpose, hosts] of Object.entries(DESTINATIONS)) {
      for (const host of hosts) {
        expect(host, `${purpose} lists ${host}`).toMatch(/^[a-z0-9.-]+$/)
        expect(host, `${purpose} lists ${host}`).not.toContain('/')
      }
    }
  })

  it('matches the host exactly, so a subdomain of a destination is not one', () => {
    /**
     * Suffix matching is right for blocking — `||host^` covers subdomains — and
     * wrong here: `api.pwnedpasswords.com.evil.test` ends with an allowed name,
     * and registering that is cheap.
     */
    expect(allowedDestination('password-range', 'api.pwnedpasswords.com')).toBe(true)
    expect(allowedDestination('password-range', 'api.pwnedpasswords.com.evil.test')).toBe(false)
    expect(allowedDestination('password-range', 'evil.api.pwnedpasswords.com')).toBe(false)
  })

  it('is case- and whitespace-insensitive, because a hostname is', () => {
    expect(allowedDestination('feed-update', 'OKOLOS-PROXY.SERGEYSHELEG4.WORKERS.DEV')).toBe(true)
    expect(allowedDestination('feed-update', ' okolos-proxy.sergeysheleg4.workers.dev ')).toBe(true)
  })

  it('refuses a purpose it has never heard of, rather than throwing', () => {
    /**
     * Unreachable through `request`, which checks its closed set of purposes
     * first — and reachable by anyone importing this function, where the type is
     * a suggestion. Without the guard `hosts` is `undefined` and `.includes`
     * throws a `TypeError` out of a security check, which a caller is far more
     * likely to catch and ignore than a `false`.
     *
     * A plant proved the guard load-bearing on exactly this input and nothing
     * else, which is the second time this session a line has turned out to carry
     * one untested case. So it is tested.
     */
    expect(allowedDestination('nonsense' as never, 'example.test')).toBe(false)
    expect(() => allowedDestination('nonsense' as never, 'example.test')).not.toThrow()
  })

  it('keeps the purposes apart, which is why this is not one flat set', () => {
    // "The leak lookup may reach Have I Been Pwned" and "the feed may reach Have
    // I Been Pwned" are different claims and only the first is true.
    expect(allowedDestination('leak-lookup', 'haveibeenpwned.com')).toBe(true)
    expect(allowedDestination('feed-update', 'haveibeenpwned.com')).toBe(false)
    expect(allowedDestination('password-range', 'haveibeenpwned.com')).toBe(false)
  })
})

describe('the three purposes with no destination', () => {
  /**
   * `model-update` has no producer because the third stage is not shipped
   * (ADR-0006); `file-hash` has none because a download's digest is computed and
   * compared locally and never leaves; `domain-status` is reached by navigating
   * the user's own tab, which is a link a person follows rather than a request the
   * product makes.
   *
   * An empty list is the enforcement, not the documentation: a call that appears
   * later cannot send at all until somebody adds a host on purpose.
   */
  for (const purpose of ['model-update', 'file-hash', 'domain-status'] as const) {
    it(`${purpose} can reach nothing at all`, () => {
      expect(DESTINATIONS[purpose]).toEqual([])
      expect(allowedDestination(purpose, 'okolos-proxy.sergeysheleg4.workers.dev')).toBe(false)
      expect(allowedDestination(purpose, 'example.test')).toBe(false)
    })
  }

  it('says why, in the file, rather than leaving three empty arrays', () => {
    // An empty array with no reason beside it reads as unfinished, and the next
    // person fills it in. Each of the three carries its own paragraph.
    const source = readFileSync(path.join(root, 'packages/net/src/destinations.ts'), 'utf8')
    expect(source).toContain('ADR-0006')
    expect(source).toContain('never leaves')
    expect(source).toContain('does not use the choke point')
  })
})

describe('what the request does about it', () => {
  it('refuses a host the purpose may not reach', async () => {
    const d = deps()
    await expect(request(spec('password-range', 'https://evil.test/range/ABCDE'), d)).rejects.toBeInstanceOf(
      DestinationError,
    )
  })

  it('records the attempt before refusing it', async () => {
    /**
     * "The product tried to send somewhere it may not" is the single most
     * interesting line this journal could carry, and the module's whole design is
     * that the entry precedes the act. A refusal with no entry would be the one
     * kind of egress nobody could see afterwards.
     */
    const d = deps()
    await request(spec('feed-update', 'https://evil.test/feeds/phishing'), d).catch(() => undefined)
    expect(d.written).toHaveLength(1)
    expect(d.written[0]).toMatchObject({
      destination: 'evil.test',
      purpose: 'feed-update',
      outcome: 'blocked-by-redactor',
    })
  })

  it('never reaches the transport', async () => {
    let sent = 0
    const d = deps({
      transport: async () => {
        sent += 1
        return new Response('ok')
      },
    })
    await request(spec('feed-update', 'https://evil.test/feeds/phishing'), d).catch(() => undefined)
    expect(sent).toBe(0)
  })

  it('says what the purpose may reach, so the message is actionable', async () => {
    const error = await request(spec('leak-lookup', 'https://evil.test/x'), deps()).then(
      () => new Error('the request was not refused'),
      (cause: unknown) => cause as DestinationError,
    )
    expect(error.message).toContain('evil.test')
    expect(error.message).toContain('haveibeenpwned.com')
  })

  it('says "no destinations at all" for a purpose that has none', async () => {
    const error = await request(
      spec('model-update', 'https://models.example.test/m'),
      deps(),
    ).then(
      () => new Error('the request was not refused'),
      (cause: unknown) => cause as DestinationError,
    )
    expect(error.message).toContain('no destinations at all')
  })

  it('lets the real destinations through', async () => {
    // The other direction: a check that refuses everything would pass every test
    // above and break the product.
    for (const [purpose, hosts] of Object.entries(DESTINATIONS)) {
      for (const host of hosts) {
        const d = deps()
        await expect(
          request(spec(purpose as Purpose, `https://${host}/whatever`), d),
        ).resolves.toBeInstanceOf(Response)
        expect(d.written[0]?.outcome).toBe('sent')
      }
    }
  })

  it('reports a leak before a destination, when both are wrong', async () => {
    /**
     * The order between the two refusals is a choice and it is written down: when
     * both are true the leak is the more urgent fact, because it names the user's
     * own data and the destination does not.
     */
    const d = deps()
    const error = await request(
      { ...spec('password-range', 'https://evil.test/x?email=someone@example.test'), method: 'GET' },
      d,
    ).then(
      () => new Error('the request was not refused'),
      (cause: unknown) => cause as Error,
    )
    expect(error.name).toBe('RedactionError')
  })
})

describe('every purpose has a producer, or a recorded reason it has none', () => {
  it('finds a `purpose:` call site for each one that can send', () => {
    /**
     * Three of the six were real when this was written and the other three were
     * not, and nothing said which. Now: a purpose with destinations must have a
     * caller, and a purpose without destinations must not.
     */
    const sources = [
      'apps/extension/src/background/leaks.ts',
      'apps/extension/src/background/password.ts',
      'apps/extension/src/background/feed-sync.ts',
      'apps/extension/src/background/usage/send.ts',
      'packages/model/src/manager.ts',
    ]
      .map((file) => readFileSync(path.join(root, file), 'utf8'))
      .join('\n')

    // Collected, then asserted once. An `expect` behind an `if` does not run when
    // the branch is not taken, and the test passes anyway — which the meta-gate
    // in `tools/test-quality.test.ts` refuses, and it is right to.
    const orphans = Object.entries(DESTINATIONS)
      .filter(([, hosts]) => hosts.length > 0)
      .filter(([purpose]) => !sources.includes(`purpose: '${purpose}'`))
      .map(([purpose]) => purpose)
    expect(orphans, 'these have destinations and no caller').toEqual([])
  })

  it('is reading real sources, so the loop above cannot pass on an empty string', () => {
    const feedSync = readFileSync(
      path.join(root, 'apps/extension/src/background/feed-sync.ts'),
      'utf8',
    )
    expect(feedSync).toContain("purpose: 'feed-update'")
  })
})

describe('usage and error data (B-198, B-199)', () => {
  /**
   * The one purpose the operator's decision of 2026-11-04 adds: usage and error events to
   * the organisation's Aptabase. One host, its own: `analytics.sshlg.me` was the first
   * choice and is not on the list, because PassionCode products send to the
   * organisation's server (sshlg-growth, 2026-11-04).
   */
  it('reaches the organisation analytics host and nothing else', () => {
    expect(DESTINATIONS['usage-data']).toEqual(['analytics.passioncode.ai'])
    expect(allowedDestination('usage-data', 'analytics.passioncode.ai')).toBe(true)
    expect(allowedDestination('usage-data', 'analytics.sshlg.me')).toBe(false)
    expect(allowedDestination('feed-update', 'analytics.passioncode.ai')).toBe(false)
  })

  it('is audited before it leaves, and refused anywhere else', async () => {
    const d = deps()
    await request({ ...spec('usage-data', 'https://analytics.passioncode.ai/api/v0/events'), method: 'POST', body: '[]' }, d)
    expect(d.written[0]).toMatchObject({ purpose: 'usage-data', destination: 'analytics.passioncode.ai' })

    await expect(request(spec('usage-data', 'https://elsewhere.test/api/v0/events'), deps())).rejects.toBeInstanceOf(DestinationError)
  })
})
