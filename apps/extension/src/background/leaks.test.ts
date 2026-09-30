import { describe, expect, it, vi } from 'vitest'
import type { AuditEntry } from '@okolos/contracts'

import { CAVALIER, hibp, lookupLeaks, type LeakSource } from './leaks.js'

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
      why: message('leakSourceNoKey'),
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
