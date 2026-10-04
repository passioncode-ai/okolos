import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

import { filesIn } from './tree.mjs'

// @ts-expect-error — a plain .mjs tool, imported for the parsing it does.
import { NEVER_BLOCK, RULE_LIMIT, SHORT_HOST_CHARS, SOURCES, buildSnapshot, defaultOut, guard, hostFrom, hostsFrom, ingest, shrankTooFar } from './ingest.mjs'

/**
 * The blocklist builder, and the two ways it can hurt someone.
 *
 * Blocking too little is a product that does nothing. Blocking too much is a
 * product that takes down Dropbox for everyone who installed it — and that is
 * not hypothetical: URLhaus lists malware URLs, its third line is a
 * `dropbox.com` link, and at host granularity that entry is a global outage
 * with this extension's name on it.
 */

describe('a feed line becomes a host, or nothing at all', () => {
  it('reads a bare domain', () => {
    expect(hostFrom('evil-login.test')).toBe('evil-login.test')
  })

  it('reads the host out of a URL and drops the path', () => {
    expect(hostFrom('https://secure-bank.test/login?next=/a')).toBe('secure-bank.test')
  })

  it('lower-cases and drops a trailing dot', () => {
    expect(hostFrom('HTTPS://Evil.TEST./x')).toBe('evil.test')
  })

  it('ignores comments and blank lines', () => {
    for (const line of ['', '   ', '# a header', '#']) expect(hostFrom(line)).toBeNull()
  })

  it('refuses a bare IP address', () => {
    // The interstitial names the domain a list flagged. There is no domain in
    // `182.117.68.188:46150`, and URLhaus is full of them.
    expect(hostFrom('http://182.117.68.188:46150/i')).toBeNull()
    expect(hostFrom('182.117.68.188')).toBeNull()
  })

  it('refuses a single label', () => {
    expect(hostFrom('localhost')).toBeNull()
    expect(hostFrom('http://intranet/')).toBeNull()
  })

  it('refuses a line it cannot parse rather than guessing', () => {
    expect(hostFrom('not a url at all !!')).toBeNull()
    expect(hostFrom('http://')).toBeNull()
  })
})

describe('the sweep keeps order and drops repeats', () => {
  it('keeps the source order — the cap depends on it', () => {
    const hosts = hostsFrom('https://a.test/1\nhttps://b.test/2\nhttps://c.test/3')
    expect(hosts).toEqual(['a.test', 'b.test', 'c.test'])
  })

  it('keeps the first sighting of a host that appears twice', () => {
    expect(hostsFrom('https://a.test/1\nhttps://a.test/2\nhttps://b.test/')).toEqual([
      'a.test',
      'b.test',
    ])
  })

  it('survives a real header block', () => {
    const text = [
      '################################',
      '# abuse.ch Plain-Text URL List #',
      '# Last updated: 2026-08-13     #',
      '################################',
      '#',
      '# url',
      'https://phish.test/login',
    ].join('\n')
    expect(hostsFrom(text)).toEqual(['phish.test'])
  })
})

describe('hosts that must never be blocked whole', () => {
  const refusedHosts = (hosts: string[]): string[] =>
    (guard(hosts).refused as Array<{ host: string }>).map((r) => r.host)

  it('refuses Dropbox, which is how this rule got written', () => {
    const { kept } = guard(['dropbox.com', 'phish.test'])
    expect(refusedHosts(['dropbox.com', 'phish.test'])).toEqual(['dropbox.com'])
    expect(kept).toEqual(['phish.test'])
  })

  it('refuses a shortener the fixed list had never heard of', () => {
    // All five of these came out of the first real run and none was listed.
    // OpenPhish saw a shortened link and reported the shortener's host.
    expect(refusedHosts(['g5.lu', 'goo.su', 's4w.in', 'i.gal', 'vo.la'])).toHaveLength(5)
  })

  it('keeps a short host that has a subdomain — that is one campaign', () => {
    expect(guard(['login.vo.la']).kept).toEqual(['login.vo.la'])
  })

  it('keeps an ordinary phishing host of ordinary length', () => {
    // The median host in the first run was 22 characters. The threshold has to
    // leave those alone or the feed blocks nothing.
    expect(guard(['wells-fargo-ac06dd.previewship.net']).kept).toHaveLength(1)
    expect(guard(['biyhv.com']).kept).toHaveLength(1)
  })

  it('says why it refused each host, not merely that it did', () => {
    const refused = guard(['dropbox.com', 'g5.lu']).refused as Array<{ why: string }>
    expect(refused).toHaveLength(2)
    for (const r of refused) expect(r.why).not.toBe('')
    expect(refused[0]?.why).not.toBe(refused[1]?.why)
  })

  it('draws the short-host line where it was measured', () => {
    expect(SHORT_HOST_CHARS).toBe(8)
  })

  it('refuses a deployment platform whose apex is a suffix, not a site', () => {
    // Blocking `vercel.app` takes down every site anyone has ever deployed
    // there, including sites that have nothing to do with this feed.
    expect(guard(['vercel.app']).kept).toEqual([])
    expect(guard(['pages.dev']).kept).toEqual([])
  })

  it('still blocks one campaign on a shared platform', () => {
    // The guard is an exact match on purpose: a subdomain is one campaign's
    // host, and blocking it harms nobody else.
    expect(guard(['cardiffsegurogrupoamigo360.vercel.app']).kept).toEqual([
      'cardiffsegurogrupoamigo360.vercel.app',
    ])
  })

  it('refuses this service itself', () => {
    // A feed that listed the service would take the feed's own delivery down
    // with it, and the status page the owner would use to complain.
    const { kept } = guard(['okolos-proxy.sergeysheleg4.workers.dev'])
    expect(kept).toEqual([])
  })

  it('reports what it refused rather than dropping it in silence', () => {
    // A feed that has started listing shared hosts is news. Swallowed, it looks
    // exactly like a feed that has not.
    expect(guard(['github.com', 'drive.google.com']).refused).toHaveLength(2)
  })

  it('names every guarded host in lower case, so the comparison can match', () => {
    for (const host of NEVER_BLOCK) expect(host).toBe((host as string).toLowerCase())
  })
})

describe('the snapshot fits what the browser can enforce', () => {
  const hosts = Array.from({ length: RULE_LIMIT + 250 }, (_, i) => `h${i}.test`)

  it('caps at the rule ceiling and says how many it left out', () => {
    const { update, dropped } = buildSnapshot({
      hosts,
      version: 4,
      updatedAt: '2026-08-13T00:00:00.000Z',
    })
    expect(update.body.entries).toHaveLength(RULE_LIMIT)
    expect(dropped).toBe(250)
  })

  it('keeps the freshest, because the source orders newest first', () => {
    const { update } = buildSnapshot({
      hosts,
      version: 4,
      updatedAt: '2026-08-13T00:00:00.000Z',
    })
    expect(update.body.entries[0]).toBe('h0.test')
  })

  it('leaves nothing out when the feed fits', () => {
    const { update, dropped } = buildSnapshot({
      hosts: ['a.test'],
      version: 2,
      updatedAt: '2026-08-13T00:00:00.000Z',
    })
    expect(dropped).toBe(0)
    expect(update).toEqual({
      kind: 'snapshot',
      body: {
        name: 'phishing',
        version: 2,
        updatedAt: '2026-08-13T00:00:00.000Z',
        entries: ['a.test'],
      },
    })
  })
})

describe('the sources are the ones the reasoning allows', () => {
  it('ingests OpenPhish and nothing that lists paths on shared hosts', () => {
    expect(SOURCES).toHaveLength(1)
    expect((SOURCES[0] as { url: string }).url).toContain('openphish.com')
  })

  it('does not ingest URLhaus', () => {
    // Recorded as a test rather than only as a comment: a future pass adding it
    // for the entry count should have to delete this line and read why.
    const urls = (SOURCES as Array<{ url: string }>).map((s) => s.url).join(' ')
    expect(urls).not.toContain('urlhaus')
    expect(urls).not.toContain('phishing.army')
  })
})

describe('a public suffix is never a site, and the rule is what makes that fatal', () => {
  /**
   * Blocking rules are `||host^`, which covers every subdomain. So listing
   * `github.io` takes down **every GitHub Pages site** for everyone who installed
   * the extension.
   *
   * The guard was forty-eight hand-written exact matches, and measured 2026-08-20
   * today's source carried nine hosts under `github.io`, four under
   * `backblazeb2.com`, and more under `trycloudflare.com`, `edgeone.dev`,
   * `bolt.host` and `webflow.io` — **not one of those platforms was on the list.**
   * Eighteen of its 281 entries were two labels, so the source does report
   * apexes; the day it reports one of these is the day the extension breaks a
   * platform. The short-host heuristic does not save it: `github.io` is nine
   * characters, and the heuristic wants fewer.
   */
  const refusedFor = (host: string): string | undefined =>
    guard([host]).refused.find((r: { host: string }) => r.host === host)?.why

  for (const platform of [
    'github.io',
    'backblazeb2.com',
    'trycloudflare.com',
    'edgeone.dev',
    'bolt.host',
    'webflow.io',
    'pages.dev',
    'weebly.com',
    'blogspot.com',
    'amplifyapp.com',
  ]) {
    it(`refuses the apex of ${platform}, which the old list did not carry`, () => {
      expect(guard([platform]).kept).toEqual([])
      expect(refusedFor(platform)).toContain('public suffix')
    })
  }

  it('keeps a site under one, because that harms nobody else', () => {
    // `evil-login.github.io` is one campaign's host. The guard is about the
    // ground, not about everything standing on it.
    expect(guard(['evil-login.github.io']).kept).toEqual(['evil-login.github.io'])
    expect(guard(['bucket-of-theirs.backblazeb2.com']).kept).toEqual([
      'bucket-of-theirs.backblazeb2.com',
    ])
  })

  it('refuses a bare top-level domain, which is the same mistake one label up', () => {
    expect(guard(['com']).kept).toEqual([])
    expect(guard(['io']).kept).toEqual([])
  })

  it('reads the same table the product reads, rather than a second copy', () => {
    /**
     * The list is a JSON file with two readers: this tool, which is plain Node,
     * and `packages/core-lookalike/src/suffix.ts`, whose package exports
     * TypeScript. Two copies of a list agree with each other and with nothing
     * else — the shape this repository has now paid for four times, and the
     * ingest copy was the one that was wrong.
     */
    const table = JSON.parse(
      readFileSync(path.join(root, 'packages/core-lookalike/src/suffixes.json'), 'utf8'),
    ) as { icann: string[]; private: string[] }
    expect(table.private).toContain('github.io')
    expect(table.icann).toContain('co.uk')
    // Every entry in the shared file must be refused by the guard that reads it.
    const sample = [...table.private.slice(0, 12), ...table.icann.slice(0, 12)]
    expect(guard(sample).kept, 'a suffix the guard did not refuse').toEqual([])
  })

  it('still refuses the shared hosts that are sites rather than suffixes', () => {
    // `dropbox.com` is a real site with a real apex — not a suffix, and not
    // something to block. The hand-written list keeps exactly this job.
    expect(guard(['dropbox.com']).kept).toEqual([])
    expect(refusedFor('dropbox.com')).toContain('shared host')
  })
})

describe('a list that shrank too far is not published', () => {
  /**
   * A source answering `200 OK` with a truncated body is not a failure any other
   * check can see: the parse succeeds, the hosts are real, and the run writes a
   * higher version with fewer entries. Measured 2026-08-20 by truncating the
   * body: **v6 with 7 entries, silently unblocking 241 of 248** — announced as an
   * update, because the version rose.
   */
  it('refuses when most of the list would disappear', () => {
    const complaint = shrankTooFar(248, 7) ?? ''
    expect(complaint).toContain('248')
    expect(complaint).toContain('7 entries')
    expect(complaint, 'the share, so the reader can judge it').toContain('97%')
    expect(complaint, 'and that nothing was written').toContain('Nothing was written')
  })

  it('allows the ordinary churn of a phishing list', () => {
    // These lists do turn over quickly and a real day can drop a quarter. What a
    // real day does not do is drop nine in ten.
    expect(shrankTooFar(248, 200)).toBeNull()
    expect(shrankTooFar(248, 170)).toBeNull()
  })

  it('refuses just past the ceiling and allows just under it', () => {
    // The boundary itself, because a threshold nobody tested at its edge is a
    // threshold nobody knows the direction of.
    expect(shrankTooFar(300, 200)).toBeNull()
    expect(shrankTooFar(300, 199)).not.toBeNull()
  })

  it('says nothing about a list that grew', () => {
    expect(shrankTooFar(100, 400)).toBeNull()
    expect(shrankTooFar(100, 100)).toBeNull()
  })

  it('says nothing on a first run, when there is nothing to shrink from', () => {
    expect(shrankTooFar(0, 5)).toBeNull()
  })

  it('says nothing when both lists are empty, which is where the arithmetic bites', () => {
    /**
     * The one input the early return exists for, found by a plant that stayed
     * green until this test existed. Zero from zero is a share of `0/0`, which is
     * `NaN`, and `NaN <= limit` is **false** — so without the guard an empty
     * previous list and an empty new one would produce a refusal about nothing.
     *
     * Unreachable through `main`, which throws on a source that parses to zero
     * hosts before it gets here. Tested anyway: a function that answers nonsense
     * for an input it cannot currently receive is a function waiting for a caller.
     */
    expect(shrankTooFar(0, 0)).toBeNull()
  })
})

describe('the version comes from what is served, not from the worktree (F1)', () => {
  /**
   * `version = previous + 1` used to be read from the tracked `feeds/phishing.json`.
   * The worktree stood at v51 and HEAD at v42, so one `git checkout -- .` made the next
   * run publish v43, which every extension holding v51 refuses as a replay — for about
   * eight runs, while the smoke test passed because the worker served what was signed.
   */
  const hosts = (n: number) => Array.from({ length: n }, (_, i) => `https://login-${i}.campaign-host.test/x`)
  const servedBody = (version: number, entries: number) =>
    JSON.stringify({
      update: { kind: 'snapshot', body: { name: 'phishing', version, updatedAt: '2026-10-03T00:00:00.000Z', entries: hosts(entries).map((u) => new URL(u).hostname) } },
      signature: 'c2ln',
    })

  function world({ served, source = hosts(300).join('\n') }: { served: { status: number; body?: string } | 'down'; source?: string }) {
    return (async (url: string) => {
      if (url.startsWith('https://openphish.com/')) return new Response(source)
      if (served === 'down') throw new TypeError('fetch failed')
      return new Response(served.body ?? '', { status: served.status })
    }) as typeof fetch
  }

  function planted(version: number, entries: number): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'okolos-ingest-'))
    const out = path.join(dir, 'state', 'feeds', 'phishing.json')
    if (version > 0) {
      const local = { kind: 'snapshot', body: { name: 'phishing', version, updatedAt: '2026-09-01T00:00:00.000Z', entries: hosts(entries).map((u) => new URL(u).hostname) } }
      mkdirSync(path.dirname(out), { recursive: true })
      writeFileSync(out, JSON.stringify(local))
    }
    return out
  }

  const quiet = () => undefined

  it('steps past the served version when the local file was taken backwards', async () => {
    const out = planted(3, 300)
    const update = await ingest({ out, seed: null, fetchImpl: world({ served: { status: 200, body: servedBody(51, 300) } }), log: quiet })
    expect(update.body.version).toBe(52)
    expect(JSON.parse(readFileSync(out, 'utf8')).body.version).toBe(52)
  })

  it('steps past a local version that is ahead of the served one', async () => {
    const out = planted(60, 300)
    const update = await ingest({ out, seed: null, fetchImpl: world({ served: { status: 200, body: servedBody(51, 300) } }), log: quiet })
    expect(update.body.version).toBe(61)
  })

  it('counts the tracked seed too, so a new machine never starts below the repository', async () => {
    const out = planted(0, 0)
    const seed = planted(42, 300)
    const update = await ingest({ out, seed, fetchImpl: world({ served: { status: 404 } }), log: quiet })
    expect(update.body.version).toBe(43)
  })

  it('refuses to build when the served version cannot be read, and writes nothing', async () => {
    const out = planted(3, 300)
    const before = readFileSync(out, 'utf8')
    await expect(ingest({ out, seed: null, fetchImpl: world({ served: 'down' }), log: quiet })).rejects.toThrow()
    await expect(ingest({ out, seed: null, fetchImpl: world({ served: { status: 503 } }), log: quiet })).rejects.toThrow(/503/)
    expect(readFileSync(out, 'utf8')).toBe(before)
  })

  it('measures shrinkage against what users hold, not against a local file that may be gone', async () => {
    const out = planted(0, 0)
    await expect(
      ingest({ out, seed: null, fetchImpl: world({ served: { status: 200, body: servedBody(51, 300) }, source: hosts(20).join('\n') }), log: quiet }),
    ).rejects.toThrow(/shrink/)
    expect(existsSync(out)).toBe(false)
  })

  it('writes the file whole and owner-only, leaving no temporary beside it', async () => {
    const out = planted(0, 0)
    await ingest({ out, seed: null, fetchImpl: world({ served: { status: 404 } }), log: quiet })
    expect(statSync(out).mode & 0o777).toBe(0o600)
    expect(filesIn(path.dirname(out), '.json')).toEqual(['phishing.json'])
    expect(filesIn(path.dirname(out), '.tmp')).toEqual([])
  })

  it('writes nothing on a dry run', async () => {
    const out = planted(0, 0)
    const update = await ingest({ out, seed: null, dryRun: true, fetchImpl: world({ served: { status: 404 } }), log: quiet })
    expect(update.body.version).toBe(1)
    expect(existsSync(out)).toBe(false)
  })

  it('writes outside the git working tree by default', () => {
    expect(defaultOut().startsWith(root), defaultOut()).toBe(false)
    expect(defaultOut()).toMatch(/\.okolos\/state\/feeds\/phishing\.json$/)
  })
})
