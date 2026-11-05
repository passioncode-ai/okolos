import { describe, expect, it } from 'vitest'

import { readFileSync } from 'node:fs'
import path from 'node:path'

import { handle, normaliseDomain, type Env } from './router.js'

/**
 * The name the brand pack fixes for a list, read from the pack itself.
 *
 * Not a literal in this file: a test that quotes the current string agrees with the code
 * and not with the reader, which is how `Okolos phishing list` stayed on a `lang="ru"`
 * page while `docs/brand/terminology.md` said otherwise (B-24).
 */
function brandName(id: string): string {
  const table = readFileSync(
    path.resolve(import.meta.dirname, '../../../docs/brand/terminology.md'),
    'utf8',
  )
  const found = new RegExp(`^\\| \`${id}\`  *\\| ([^|]+) \\|`, 'm').exec(table)
  if (!found) throw new Error(`the brand pack names no list "${id}"`)
  return (found[1] as string).trim()
}

type Row = { feed: string; entry_date: string }

function env(overrides: { listing?: Row | null; fail?: boolean; inserted?: unknown[] } = {}): Env {
  const inserted = overrides.inserted ?? []
  return {
    DB: {
      prepare: () => ({
        bind: (...values: unknown[]) => ({
          run: async () => {
            if (overrides.fail) throw new Error('database unavailable')
            inserted.push(values)
            return {}
          },
          first: async <T>() => {
            if (overrides.fail) throw new Error('database unavailable')
            return (overrides.listing ?? null) as T | null
          },
          all: async <T>() => ({ results: [] as T[] }),
        }),
      }),
    },
  }
}

const get = (path: string) => new Request(`https://proxy.test${path}`)
const post = (path: string, body: unknown) =>
  new Request(`https://proxy.test${path}`, { method: 'POST', body: JSON.stringify(body) })

describe('a domain nobody has heard of', () => {
  it('is reported as not listed, in those words', async () => {
    const response = await handle(get('/status/domain?domain=example.test'), env())
    await expect(response.json()).resolves.toMatchObject({ status: 'not-listed' })
  })

  it('needs a domain to answer about', async () => {
    expect((await handle(get('/status/domain'), env())).status).toBe(400)
  })
})

describe('a domain that is listed', () => {
  it('says which list and when it was added', async () => {
    const response = await handle(
      get('/status/domain?domain=bad.test'),
      env({ listing: { feed: 'OpenPhish', entry_date: '2026-08-01' } }),
    )
    await expect(response.json()).resolves.toMatchObject({
      status: 'listed',
      feed: 'OpenPhish',
      entryDate: '2026-08-01',
    })
  })

  it('carries the identifier for machines and the name for people', async () => {
    // The identifier stays in the API — a caller keying off a display name
    // breaks the first time the name is improved — and the name rides beside
    // it, because `phishing` is a database key and the owner reads a reason.
    const response = await handle(
      get('/status/domain?domain=bad.test'),
      env({ listing: { feed: 'phishing', entry_date: '2026-08-01' } }),
    )
    await expect(response.json()).resolves.toMatchObject({
      feed: 'phishing',
      // The name in the language of the page beside it. Asserted against the brand pack
      // rather than against a literal: `tools/feed-names.test.ts` holds `OUR_FEEDS` to
      // `docs/brand/terminology.md`, and this reads the same table (B-24).
      feedName: brandName('phishing'),
    })
  })

  it('leaves a third-party list called what it calls itself', async () => {
    const response = await handle(
      get('/status/domain?domain=bad.test'),
      env({ listing: { feed: 'OpenPhish', entry_date: '2026-08-01' } }),
    )
    await expect(response.json()).resolves.toMatchObject({ feedName: 'OpenPhish' })
  })

  it('names the list on the page a site owner actually reads', async () => {
    /**
     * The HTML, not the JSON. This page is what an owner opens when their
     * domain has been blocked, and until 2026-08-08 it said "listed by
     * phishing" — a column name presented as the reason.
     */
    const response = await handle(
      get('/status?domain=bad.test'),
      env({ listing: { feed: 'phishing', entry_date: '2026-08-01' } }),
    )
    const html = await response.text()
    /**
     * In Russian, because the page is `lang="ru"` and every other word on it is. It said
     * `Okolos phishing list` until 2026-08-20 — to a site owner reading Russian — and
     * this assertion said so too, agreeing with the code rather than with the brand pack
     * that fixes one name per language (B-24).
     */
    expect(html).toContain(brandName('phishing'))
    expect(html, 'the English name is still on a Russian page').not.toContain('phishing list')
    expect(html, 'the raw identifier is still on the page').not.toMatch(
      /listed<\/strong> by <strong>phishing/,
    )
  })

  it('points the owner at whoever actually listed them', async () => {
    // Most listings are not ours. Saying so is the difference between an owner
    // fixing the problem and arguing with the wrong party.
    const response = await handle(
      get('/status/domain?domain=bad.test'),
      env({ listing: { feed: 'OpenPhish', entry_date: '2026-08-01' } }),
    )
    await expect(response.json()).resolves.toMatchObject({ appealTo: 'OpenPhish' })
  })
})

describe('when the lookup fails', () => {
  it('never answers "clean" for a question it could not ask', async () => {
    const response = await handle(get('/status/domain?domain=bad.test'), env({ fail: true }))
    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({ status: 'unknown' })
  })
})

describe('appeals', () => {
  it('records one and returns a reference the owner can quote', async () => {
    const inserted: unknown[] = []
    const response = await handle(
      post('/appeal', { domain: 'mysite.test', contact: 'me@mysite.test', message: 'we cleaned it' }),
      env({ inserted }),
    )
    const body = (await response.json()) as { reference: string }
    expect(body.reference).toMatch(/^OK-/)
    expect(inserted).toHaveLength(1)
  })

  it('says nothing was saved when nothing was saved', async () => {
    const response = await handle(post('/appeal', { domain: 'mysite.test' }), env({ fail: true }))
    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining('nothing was saved'),
    })
  })

  it('refuses an appeal with no domain', async () => {
    expect((await handle(post('/appeal', { message: 'hello' }), env())).status).toBe(400)
  })

  it('refuses a body that is not JSON', async () => {
    const request = new Request('https://proxy.test/appeal', { method: 'POST', body: 'not json' })
    expect((await handle(request, env())).status).toBe(400)
  })
})

describe('what the backend never does', () => {
  it('sets no cookies on any route', async () => {
    for (const request of [get('/healthz'), get('/status/domain?domain=a.test')]) {
      const response = await handle(request, env())
      expect(response.headers.get('set-cookie')).toBeNull()
    }
  })

  it('answers a preflight without requiring anything of the caller', async () => {
    const request = new Request('https://proxy.test/appeal', { method: 'OPTIONS' })
    expect((await handle(request, env())).status).toBe(204)
  })
})

describe('domain normalisation', () => {
  it('accepts what an owner would actually type', () => {
    expect(normaliseDomain('HTTPS://My-Site.TEST/path')).toBe('my-site.test')
    expect(normaliseDomain(' mysite.test. ')).toBe('mysite.test')
  })

  it('refuses what it cannot read', () => {
    expect(normaliseDomain('')).toBeNull()
    expect(normaliseDomain(null)).toBeNull()
  })
})

describe('a domain that is not one', () => {
  it('refuses dots standing alone', () => {
    // `..` normalised to "." and `../../etc/passwd` to ".." — both went into
    // the database as domains and came back out as answers about a domain.
    // Parameterised SQL means it is not an injection; it is nonsense stored
    // and nonsense returned.
    expect(normaliseDomain('..')).toBeNull()
    expect(normaliseDomain('.')).toBeNull()
    expect(normaliseDomain('../../etc/passwd')).toBeNull()
  })

  it('refuses a single label, which is never a public domain', () => {
    // This service answers about sites on the public internet. `localhost` is
    // not one, and an appeal filed for it is a row nobody can act on.
    expect(normaliseDomain('localhost')).toBeNull()
    expect(normaliseDomain('intranet')).toBeNull()
  })

  it('keeps the hosts it is actually for', () => {
    expect(normaliseDomain('evil.test')).toBe('evil.test')
    expect(normaliseDomain('EVIL.test.')).toBe('evil.test')
    expect(normaliseDomain('https://evil.test/path')).toBe('evil.test')
    expect(normaliseDomain('evil.test:8080')).toBe('evil.test')
    expect(normaliseDomain('xn--80ak6aa92e.com')).toBe('xn--80ak6aa92e.com')
  })

  it('keeps an address literal, which a listing can legitimately be', () => {
    expect(normaliseDomain('127.0.0.1')).toBe('127.0.0.1')
    expect(normaliseDomain('[::1]')).toBe('[::1]')
  })
})

describe('the same appeal, sent twice', () => {
  it('says it is already on file rather than that nothing was saved', async () => {
    /**
     * The reference is a hash of the domain and the message, and it is the
     * primary key. An owner who submits the same appeal again — a refreshed
     * page, an impatient second click — hits a key conflict, and the handler
     * reported "the appeal could not be recorded — nothing was saved".
     *
     * It was saved. The first time. Telling them otherwise sends them away
     * believing nobody has their case.
     */
    const conflicting = {
      DB: {
        prepare: () => ({
          bind: () => ({
            run: async () => {
              throw new Error('UNIQUE constraint failed: appeals.reference')
            },
            first: async () => null,
            all: async () => ({ results: [] }),
          }),
        }),
      },
    } as unknown as Env

    const response = await handle(
      post('/appeal', { domain: 'evil.test', message: 'this is mine' }),
      conflicting,
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as { reference: string; alreadyFiled?: boolean }
    expect(body.alreadyFiled).toBe(true)
    expect(body.reference).toMatch(/^OK-/)
  })

  it('still reports a real database failure as one', async () => {
    // The distinction has to survive: a conflict means it is on file, and
    // anything else means it is not.
    const response = await handle(post('/appeal', { domain: 'evil.test' }), env({ fail: true }))
    expect(response.status).toBe(503)
  })
})

describe('the page a person or a crawler actually gets', () => {
  /**
   * REQ-26 promised a public status page and SCR-14 was marked built, on a
   * renderer that nothing called: no document, no entry point, no request to
   * this worker. The same shape as the static analyser closed on unreachable
   * code, recorded in the retro and repeated here.
   *
   * It is served from the worker with the answer already in the markup rather
   * than fetched by a script, because the second reader of a public page is a
   * crawler and a page that needs JavaScript says nothing to one.
   */
  it('serves HTML, not JSON, at the human address', async () => {
    const response = await handle(get('/status?domain=evil.test'), env({ listing: null }))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toMatch(/text\/html/)
  })

  it('puts the answer in the markup, where it can be read without running anything', async () => {
    const response = await handle(
      get('/status?domain=evil.test'),
      env({ listing: { feed: 'openphish', entry_date: '2026-08-01' } }),
    )
    const html = await response.text()
    expect(html).toContain('evil.test')
    // The verdict word, in the language the page ships in. Matching /listed/i
    // pinned the English wording and would have gone red the day this page
    // started speaking to the people who read it.
    expect(html).toMatch(/числится/)
    expect(html).toContain('openphish')
  })

  it('says plainly when a domain is not listed', async () => {
    const html = await (await handle(get('/status?domain=ok.test'), env({ listing: null }))).text()
    expect(html).toMatch(/не числится/)
  })

  it('escapes the feed name, which is data this service does not write', async () => {
    /**
     * The first version of this test sent markup as the *domain*, and passed
     * with escaping disabled — because `normaliseDomain` rejects it, so
     * nothing reached the output either way. Green for the wrong reason.
     *
     * The feed name is the value that actually matters: it comes out of the
     * database, this service does not write it, and it is interpolated into a
     * public page.
     */
    const html = await (
      await handle(
        get('/status?domain=evil.test'),
        env({ listing: { feed: '<script>alert(1)</script>', entry_date: '2026-08-01' } }),
      )
    ).text()
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('rejects a domain that is not one before it ever reaches the markup', () => {
    // Stated beside the escaping test so the two are not confused again: this
    // is normalisation's job, and it is why the first version of that test
    // proved nothing.
    expect(normaliseDomain('<script>alert(1)</script>')).toBeNull()
  })

  it('asks for a domain rather than guessing when none was given', async () => {
    const response = await handle(get('/status'), env())
    const html = await response.text()
    expect(response.headers.get('content-type')).toMatch(/text\/html/)
    expect(html).toMatch(/введите домен/i)
  })

  it('does not claim a domain is clean when the lookup failed', async () => {
    const html = await (
      await handle(get('/status?domain=evil.test'), env({ fail: true }))
    ).text()
    // Neither of the two things a failed lookup must never say.
    expect(html).not.toMatch(/не числится/)
    expect(html).toMatch(/не удалось выяснить/)
  })

  it('carries a canonical link, so one question has one address', async () => {
    const html = await (await handle(get('/status?domain=Evil.TEST.'), env({ listing: null }))).text()
    expect(html).toMatch(/<link rel="canonical" href="[^"]*domain=evil\.test"/)
  })
})

describe('the request a link checker makes', () => {
  /**
   * Every route tested `request.method === 'GET'`, so HEAD fell through to the
   * 404. Crawlers, link checkers and monitors use HEAD, and a public page that
   * answers 404 to them is a public page that reads as broken from outside —
   * on the one surface of this product whose whole purpose is being found and
   * quoted.
   */
  const head = (path: string) => new Request(`https://proxy.test${path}`, { method: 'HEAD' })

  it('answers HEAD on the status page as it answers GET', async () => {
    const response = await handle(head('/status?domain=evil.test'), env({ listing: null }))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toMatch(/text\/html/)
  })

  it('answers HEAD on the JSON endpoint too', async () => {
    const response = await handle(head('/status/domain?domain=evil.test'), env({ listing: null }))
    expect(response.status).toBe(200)
  })

  it('answers HEAD on the health check, which is what a monitor uses', async () => {
    expect((await handle(head('/healthz'), env())).status).toBe(200)
  })

  it('still refuses HEAD where there is nothing to get', async () => {
    // /appeal is a POST. HEAD on it is not a page, and pretending otherwise
    // would advertise an endpoint that does nothing.
    expect((await handle(head('/appeal'), env())).status).toBe(404)
  })
})

describe('serving the blocking feed', () => {
  /**
   * The extension pulls this every six hours and verifies it against a key
   * compiled into the build. The worker never signs: the private half stays
   * off the server, so what is served is whatever was published, verbatim.
   *
   * Until this route existed the extension fetched a 404 and journalled that
   * it could not be reached — honest, and still no protection.
   */
  const feedEnv = (row: { body: string; updated_at: string } | null) =>
    ({
      DB: {
        prepare: () => ({
          bind: () => ({
            first: async () => row,
            run: async () => ({}),
            all: async () => ({ results: [] }),
          }),
        }),
      },
    }) as unknown as Env

  const signed = JSON.stringify({
    update: { kind: 'snapshot', body: { name: 'phishing', version: 3, updatedAt: 'x', entries: ['bad.test'] } },
    signature: 'sig',
  })

  it('serves what was published, byte for byte', async () => {
    const response = await handle(
      get('/feeds/phishing'),
      feedEnv({ body: signed, updated_at: '2026-08-08T00:00:00.000Z' }),
    )
    expect(response.status).toBe(200)
    expect(await response.text()).toBe(signed)
  })

  it('says nothing has been published rather than inventing an empty feed', async () => {
    // An empty signed snapshot would be a claim that nothing is dangerous, and
    // the extension would install zero rules believing that was the answer.
    const response = await handle(get('/feeds/phishing'), feedEnv(null))
    expect(response.status).toBe(404)
    expect(await response.text()).not.toContain('entries')
  })

  it('refuses a feed name it does not publish', async () => {
    expect((await handle(get('/feeds/../../etc/passwd'), feedEnv(null))).status).toBe(404)
    expect((await handle(get('/feeds/'), feedEnv(null))).status).toBe(404)
  })

  it('answers HEAD, because a monitor will ask that way', async () => {
    const response = await handle(
      new Request('https://proxy.test/feeds/phishing', { method: 'HEAD' }),
      feedEnv({ body: signed, updated_at: '2026-08-08T00:00:00.000Z' }),
    )
    expect(response.status).toBe(200)
  })

  it('is cacheable but not for long, because a feed goes stale', async () => {
    const response = await handle(
      get('/feeds/phishing'),
      feedEnv({ body: signed, updated_at: '2026-08-08T00:00:00.000Z' }),
    )
    const cache = response.headers.get('cache-control') ?? ''
    expect(cache).toMatch(/max-age=(\d+)/)
    expect(Number(/max-age=(\d+)/.exec(cache)?.[1]), 'an hour at most').toBeLessThanOrEqual(3600)
  })
})

describe('an owner who wants to appeal, using only a browser', () => {
  /**
   * SCN-026 step 3 was marked implemented on the strength of a renderer no page
   * loaded. The endpoint existed; the only way to reach it was to hand-write a
   * JSON POST. An owner with two minutes and no account had no route at all.
   */
  const form = (path: string, fields: Record<string, string>) =>
    new Request(`https://proxy.test${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html' },
      body: new URLSearchParams(fields).toString(),
    })

  it('is offered a form when the listing is ours to lift', async () => {
    // `phishing`, not `okolos-phishing`: ownership is the set of feeds this
    // service publishes, not a prefix on their names. The one feed actually
    // published is called `phishing`, so a prefix test would have hidden the
    // form from every listing we can lift.
    const response = await handle(
      get('/status?domain=mysite.test'),
      env({ listing: { feed: 'phishing', entry_date: '2026-08-01' } }),
    )
    const html = await response.text()
    expect(html).toContain('action="/appeal"')
    expect(html).toContain('method="post"')
    // The three fields the scenario names, and the domain carried without retyping.
    expect(html).toMatch(/name="domain"[^>]*value="mysite\.test"/)
    expect(html).toContain('name="contact"')
    expect(html).toContain('name="message"')
  })

  it('is not offered a form we cannot honour', async () => {
    // An appeal form for someone else's listing collects a plea nobody reads.
    const response = await handle(
      get('/status?domain=mysite.test'),
      env({ listing: { feed: 'OpenPhish', entry_date: '2026-08-01' } }),
    )
    const html = await response.text()
    expect(html).not.toContain('action="/appeal"')
    expect(html).toContain('OpenPhish')
  })

  it('gets the reference back as a page, not as JSON', async () => {
    const response = await handle(
      form('/appeal', { domain: 'mysite.test', contact: 'me@mysite.test', message: 'cleaned' }),
      env(),
    )
    expect(response.headers.get('content-type')).toMatch(/text\/html/)
    const html = await response.text()
    expect(html).toMatch(/OK-[0-9A-Z]+/)
    expect(html).toContain('mysite.test')
  })

  it('is told a resent appeal is already on file, with its reference', async () => {
    let hits = 0
    const duplicating: Env = {
      DB: {
        prepare: () => ({
          bind: () => ({
            run: async () => {
              hits += 1
              throw new Error('UNIQUE constraint failed: appeals.reference')
            },
            first: async <T>() => null as T | null,
            all: async <T>() => ({ results: [] as T[] }),
          }),
        }),
      },
    }
    const response = await handle(form('/appeal', { domain: 'mysite.test', message: 'again' }), duplicating)
    expect(hits).toBe(1)
    expect(response.status).toBe(200)
    const html = await response.text()
    expect(html).toMatch(/already on file/i)
    expect(html).toMatch(/OK-[0-9A-Z]+/)
  })

  it('is never shown a reference for an appeal that was not saved', async () => {
    const response = await handle(form('/appeal', { domain: 'mysite.test' }), env({ fail: true }))
    const html = await response.text()
    expect(html).toMatch(/nothing was saved/i)
    expect(html).not.toMatch(/OK-[0-9A-Z]+/)
  })

  it('refuses a domain carrying markup at the door, before anything echoes it', async () => {
    // What protects this page is normalisation, not escaping: a value that is
    // not a public hostname never becomes a domain, so it is never echoed. This
    // test would pass with every escape removed — the one that exercises
    // escaping is "escapes the feed name, which is data this service does not
    // write", because the feed name is the one echoed string a visitor cannot
    // set and normalisation does not filter.
    const response = await handle(
      form('/appeal', { domain: 'x.test"><script>alert(1)</script>', message: 'hi' }),
      env(),
    )
    expect(response.status).toBe(400)
    expect(await response.text()).not.toContain('<script>')
  })

  it('still answers API clients in JSON', async () => {
    // The form is an addition, not a replacement — the JSON contract stands.
    const response = await handle(post('/appeal', { domain: 'mysite.test', message: 'x' }), env())
    expect(response.headers.get('content-type')).toMatch(/application\/json/)
    await expect(response.json()).resolves.toMatchObject({ domain: 'mysite.test', alreadyFiled: false })
  })
})

describe('the privacy policy, where someone can read it before installing', () => {
  it('is served at a stable address, whole and without a script', async () => {
    const response = await handle(get('/privacy'), env())
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toMatch(/text\/html/)
    const html = await response.text()
    expect(html).not.toContain('<script')
    expect(html).toContain('Что Okolos отправляет')
  })

  it('names what actually leaves the device, so the page is not a summary of a summary', async () => {
    const html = await (await handle(get('/privacy'), env())).text()
    for (const purpose of ['password-range', 'leak-lookup', 'feed-update', 'domain-status', 'usage-data']) {
      expect(html, `${purpose} is not on the served page`).toContain(purpose)
    }
  })

  it('carries exactly the markup the generator produces from the document', async () => {
    // Two copies of a policy is two policies, and the one a reader sees is the
    // one nobody edits.
    const { readFileSync } = await import('node:fs')
    const pathMod = await import('node:path')
    const root = pathMod.resolve(import.meta.dirname, '../../..')
    // @ts-expect-error — a plain .mjs tool, imported for its converter.
    const { toHtml } = await import('../../../tools/privacy-page.mjs')
    const expected = toHtml(readFileSync(pathMod.join(root, 'docs/privacy.md'), 'utf8')) as string
    const html = await (await handle(get('/privacy'), env())).text()
    expect(
      html.includes(expected),
      'the served page differs from docs/privacy.md — run `node tools/privacy-page.mjs`',
    ).toBe(true)
  })
})
