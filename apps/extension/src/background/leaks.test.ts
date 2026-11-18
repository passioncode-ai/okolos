import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import type { AuditEntry, RpcMap } from '@okolos/contracts'
import { HIBP_KEY_HEADER_SHAPE, type KeyRemedy } from '@okolos/core-leaks'

import { CAVALIER, hibp, hibpFromStore, lookupLeaks, type LeakSource } from './leaks.js'

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fromCatalogue, useResolver, type Catalogue } from '@okolos/i18n'

/**
 * The shipped Russian catalogue. Two sentences here — a source with no key, and one that
 * ran out of time — travel in the same field a person can be shown, and were written in
 * English in this file until 2026-08-20 (B-75). A fake catalogue would let a missing key
 * pass as a message.
 */
const CATALOGUE = JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, '../../_locales/ru/messages.json'), 'utf8'),
) as Catalogue

useResolver(fromCatalogue(CATALOGUE))

const message = (key: string): string => {
  const entry = CATALOGUE[key]
  if (!entry) throw new Error(`the shipped catalogue has no key "${key}"`)
  return entry.message
}

function deps(response: () => Promise<Response>) {
  const audit: AuditEntry[] = []
  return {
    audit,
    deps: {
      writeAudit: async (entry: AuditEntry) => {
        audit.push(entry)
      },
      now: () => '2026-08-05T12:00:00.000Z',
      newId: () => 'a-1',
      transport: response,
    },
  }
}

const silent: LeakSource = {
  name: 'Quiet Source',
  unavailable: null,
  lookup: async () => {
    throw new Error('the request timed out')
  },
}

describe('a source that cannot run', () => {
  it('says why instead of being dropped', async () => {
    const { deps: d } = deps(async () => new Response('[]'))
    const inventory = await lookupLeaks('a@b.test', [hibp(null)], d)

    expect(inventory.sources[0]).toMatchObject({
      answered: false,
      // The sentence names the source, so it reads on its own under the coverage line.
      why: message('leakSourceNoKey').replace('$NAME$', 'Have I Been Pwned'),
      needsKey: 'missing',
    })
    expect(inventory.complete).toBe(false)
  })

  it('never makes a request it cannot complete', async () => {
    const transport = vi.fn()
    const { deps: d } = deps(transport as unknown as () => Promise<Response>)
    await lookupLeaks('a@b.test', [hibp(null)], d)
    expect(transport).not.toHaveBeenCalled()
  })
})

describe('a source that fails mid-flight', () => {
  it('does not take the others with it', async () => {
    const { deps: d } = deps(async () => new Response(JSON.stringify({ stealers: [] })))
    const inventory = await lookupLeaks('a@b.test', [silent, CAVALIER], d)

    expect(inventory.sources.map((source) => source.answered)).toEqual([false, true])
  })

  it('is not mistaken for having nothing to report', async () => {
    const { deps: d } = deps(async () => new Response('[]'))
    const inventory = await lookupLeaks('a@b.test', [silent], d)
    // The fact, not the sentence built from it: composing the wording moved to
    // the screen, and asserting a source is visibly silent is the stronger claim.
    expect(inventory.complete).toBe(false)
    expect(inventory.sources.filter((source) => !source.answered)).toHaveLength(1)
  })
})

describe('what the audit log records', () => {
  it('names the purpose and shows the address only in part', async () => {
    const { deps: d, audit } = deps(async () => new Response(JSON.stringify({ stealers: [] })))
    await lookupLeaks('user@example.test', [CAVALIER], d)

    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ purpose: 'leak-lookup', outcome: 'sent' })
    expect(audit[0]?.payloadShape).toBe('email:u***@example.test')
    expect(audit[0]?.payloadShape).not.toContain('user')
  })
})

describe('reading what a source returned', () => {
  it('turns Cavalier stealer records into dated leaks', async () => {
    const { deps: d } = deps(
      async () =>
        new Response(JSON.stringify({ stealers: [{ date_compromised: '2025-11-02T00:00:00Z' }] })),
    )
    const inventory = await lookupLeaks('a@b.test', [CAVALIER], d)
    expect(inventory.leaks[0]).toMatchObject({ occurredAt: '2025-11-02' })
  })

  it('treats a 404 from the breach API as "nothing found", not as a failure', async () => {
    const { deps: d } = deps(async () => new Response('', { status: 404 }))
    const inventory = await lookupLeaks('a@b.test', [hibp('key')], d)
    expect(inventory.sources[0]?.answered).toBe(true)
    expect(inventory.leaks).toEqual([])
  })
})

describe('a source that never answers', () => {
  it('is reported as unreachable rather than holding the check open', async () => {
    // Without a deadline the panel sits on "Asking the sources…" forever, which
    // is indistinguishable — to the person waiting — from a broken product.
    const hangs: LeakSource = {
      name: 'Silent Source',
      unavailable: null,
      lookup: () => new Promise(() => {}),
    }
    const { deps: d } = deps(async () => new Response('[]'))
    const inventory = await lookupLeaks('a@b.test', [hangs], d, 20)

    expect(inventory.sources[0]).toMatchObject({ answered: false })
    // The catalogue's sentence with the name and the seconds substituted, not a phrase
    // written here: `[leakSourceTimedOut]` in that field is what a missing key looks like.
    expect(inventory.sources[0]?.why).toContain('Silent Source')
    expect(inventory.sources[0]?.why).not.toMatch(/^\[/)
    expect(inventory.sources[0]?.why).not.toMatch(/\$[A-Z]+\$/)
  })

  it('does not take the sources that did answer with it', async () => {
    const hangs: LeakSource = {
      name: 'Silent Source',
      unavailable: null,
      lookup: () => new Promise(() => {}),
    }
    const { deps: d } = deps(async () => new Response(JSON.stringify({ stealers: [] })))
    const inventory = await lookupLeaks('a@b.test', [hangs, CAVALIER], d, 20)

    expect(inventory.sources.map((source) => source.answered)).toEqual([false, true])
    // The point is the source that DID answer is still named — a timeout on one
    // must not take the others with it.
    expect(inventory.sources.filter((source) => source.answered).map((s) => s.name)).toContain(
      'Hudson Rock Cavalier',
    )
  })
})

/**
 * The person's own key (B-125). Nothing wrote it until 2026-10-29, so these paths had
 * never run outside a unit test. The value here is obviously fake on purpose: no real
 * credential belongs in a repository, a test one included.
 */
const FAKE_KEY = 'fake-hibp-key-for-tests-0000'

describe('a source that needs the person\'s key', () => {
  it('sends the key only in the header Have I Been Pwned asks for', async () => {
    const transport = vi.fn(async (_spec: { url: string; headers?: Record<string, string> }) =>
      new Response(JSON.stringify([{ Name: 'Example', BreachDate: '2024-01-02', DataClasses: [] }])),
    )
    const { deps: d, audit } = deps(transport as unknown as () => Promise<Response>)
    const inventory = await lookupLeaks('a@b.test', [hibp(FAKE_KEY)], d)

    expect(inventory.sources[0]).toMatchObject({ answered: true })
    const spec = transport.mock.calls[0]?.[0]
    expect(spec?.headers?.['hibp-api-key']).toBe(FAKE_KEY)
    expect(spec?.url).not.toContain(FAKE_KEY)
    // The outbound log is exportable and shown on a screen: the key is in no field of it.
    expect(JSON.stringify(audit)).not.toContain(FAKE_KEY)
    // But its "what left" line says a key left, by the header's name (B-125 round 2).
    // One constant, read by the self-audit summary too, so the two cannot drift apart.
    expect(audit[0]?.payloadShape).toBe(`email:a***@b.test, ${HIBP_KEY_HEADER_SHAPE}`)
    expect(HIBP_KEY_HEADER_SHAPE).toBe('header:hibp-api-key')
  })

  it('says the key was refused, and marks it as the key\'s fault, on a 401', async () => {
    const { deps: d } = deps(async () => new Response('{"statusCode":401}', { status: 401 }))
    const inventory = await lookupLeaks('a@b.test', [hibp(FAKE_KEY), CAVALIER], d)

    expect(inventory.sources[0]).toMatchObject({
      answered: false,
      why: message('leakSourceKeyRefused').replace('$NAME$', 'Have I Been Pwned'),
      needsKey: 'refused',
    })
    expect(inventory.sources[0]?.why).not.toContain(FAKE_KEY)
  })

  it('names any other error by its status, and does not blame the key for it', async () => {
    // It used to read the error body as a list of breaches and fail on `.map`, so the
    // reason a person would have been shown was "body.map is not a function".
    const { deps: d } = deps(async () => new Response('{"statusCode":429}', { status: 429 }))
    const inventory = await lookupLeaks('a@b.test', [hibp(FAKE_KEY)], d)

    expect(inventory.sources[0]).toMatchObject({ answered: false })
    expect(inventory.sources[0]?.why).toContain('429')
    expect(inventory.sources[0]?.why).toContain('Have I Been Pwned')
    expect(inventory.sources[0]).not.toHaveProperty('needsKey')
  })
})

/**
 * B-125 round 2: "no key saved" and "the store could not be read" were one answer, so a
 * storage failure told the person to add a key they may already have.
 */
describe('reading the saved key', () => {
  it('uses the key that is there', async () => {
    const source = await hibpFromStore(async () => FAKE_KEY)
    expect(source.unavailable).toBeNull()
  })

  it('says no key is saved when none is, and points at the field', async () => {
    for (const stored of [null, '', 42]) {
      const source = await hibpFromStore(async () => stored)
      expect(source.needsKey).toBe('missing')
    }
  })

  it('says the key could not be read when the store failed, and offers no field', async () => {
    const source = await hibpFromStore(async () => {
      throw new Error('IDBDatabase closed')
    })
    expect(source.unavailable).toBe(
      message('leakSourceKeyUnreadable').replace('$NAME$', 'Have I Been Pwned'),
    )
    expect(source.needsKey).toBe('unreadable')

    const transport = vi.fn()
    const { deps: d } = deps(transport as unknown as () => Promise<Response>)
    const inventory = await lookupLeaks('a@b.test', [source], d)
    expect(transport, 'a source with no key it can read must not be asked').not.toHaveBeenCalled()
    expect(inventory.sources[0]).toMatchObject({ answered: false, needsKey: 'unreadable' })
  })
})

describe('the leaks/check contract admits every key remedy the background sends', () => {
  it('types needsKey as exactly the remedies core-leaks produces', () => {
    // Round 2 added 'unreadable' and the contract still said 'missing' | 'refused': the
    // receiver's cast to RpcMap[T]['res'] hid it. Checked by `tsc -p tsconfig.tests.json`.
    type Wire = NonNullable<RpcMap['leaks/check']['res']['sources'][number]['needsKey']>
    expectTypeOf<Wire>().toEqualTypeOf<KeyRemedy>()
  })
})
