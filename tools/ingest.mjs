#!/usr/bin/env node
/**
 * Building the blocklist from public sources, and refusing to build a dangerous one.
 *
 *   node tools/ingest.mjs                 # fetch, build, write ~/.okolos/state/feeds/phishing.json
 *   node tools/ingest.mjs --out FILE      # write somewhere else
 *   node tools/ingest.mjs --dry-run       # build and print, write nothing
 *
 * The output lives outside the git working tree, and the version comes from the
 * served feed (F1): `version = max(served, local, seed) + 1`. It used to be read
 * from the tracked `feeds/phishing.json`, so any routine `git checkout -- .` took
 * the counter backwards and the next run published a version every extension
 * refuses as a replay. The tracked file is now a committed snapshot — a seed and a
 * reference — refreshed with `pnpm feed:snapshot`, never by the agent.
 *
 * The feed shipped to production until now held four `.test` domains. The
 * mechanism worked and protected nobody, which is a worse position than an
 * obviously missing feature: every gate was green about a list that blocked
 * nothing real.
 *
 * ## Why one source and not three
 *
 * The extension blocks by **host** — `declarativeNetRequest` rules built from
 * `||host^`. That decides which feeds can be used at all.
 *
 * **URLhaus is not ingested, and the reason is the interesting part.** It lists
 * *URLs* where malware is hosted, 63,978 of them, and the third line of the
 * download is a `dropbox.com` link. At host granularity that entry blocks
 * Dropbox for every user of this extension. The same is true of the Google
 * Drive, GitHub and Firebase Storage URLs further down. A malware URL on a
 * shared host is a fact about the URL, not about the host, and this product
 * cannot act on it without a path-level mechanism it does not have.
 *
 * **Phishing Army extended is not ingested either**, for a quieter reason: it
 * is a cumulative aggregate of 600k+ domains with no dates, and the rule
 * ceiling is 5000. Taking 5000 of 600k with no recency signal is not a
 * selection, it is a coin toss with a number attached.
 *
 * **OpenPhish community is ingested**: ~300 live phishing URLs, refreshed
 * roughly twelve-hourly, each a host set up for the campaign. It is the shape
 * a host-level blocklist under a hard ceiling actually wants — fresh, small,
 * and about hosts rather than paths.
 *
 * ## What this refuses to do
 *
 * A source that fails must never produce a **smaller** list. Publishing fewer
 * entries because a fetch timed out silently unblocks whatever fell out, and
 * the feed's own version number would announce the shrinkage as an update. So a
 * failed fetch stops the run.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { acquireLock } from './feed/lock.mjs'
import { feedPaths } from './feed/paths.mjs'
import { DEFAULT_WORKER, nextVersion, readServed } from './feed/served.mjs'


const root = path.resolve(import.meta.dirname, '..')

/**
 * The suffix table, read from the file the product reads.
 *
 * Not imported from `@okolos/core-lookalike`: its `exports` point at TypeScript
 * source, and this is plain Node. So the *data* is shared rather than the module
 * — one file, two readers — which is the point. This tool used to carry its own
 * list of forty-eight exact matches, and it was missing every platform the source
 * actually emits hosts under.
 */
const SUFFIXES = JSON.parse(
  readFileSync(path.join(root, 'packages/core-lookalike/src/suffixes.json'), 'utf8'),
)
const SUFFIX_SET = new Set([...SUFFIXES.icann, ...SUFFIXES.private])

/**
 * Whether this host **is** a suffix rather than a site under one.
 *
 * Mirrors `isPublicSuffix` in `packages/core-lookalike/src/suffix.ts`, over the
 * same data. A single label is a top-level domain: `com`, `io`, `test`.
 */
export function isPublicSuffix(host) {
  const cleaned = String(host).trim().toLowerCase().replace(/\.$/, '')
  if (cleaned === '') return false
  return SUFFIX_SET.has(cleaned) || !cleaned.includes('.')
}

/** Where the entries come from. One for now, deliberately — see the note above. */
export const SOURCES = [
  { name: 'OpenPhish community', url: 'https://openphish.com/feed.txt' },
]

/**
 * Hosts that must never be blocked whole, however they arrive.
 *
 * Two kinds are in here and they fail differently. A **shared host** —
 * `dropbox.com`, `drive.google.com` — appears in these feeds because somebody
 * put a file on it; blocking it takes down a service millions of people use for
 * something unrelated. A **public suffix** — `vercel.app`, `pages.dev` — is not
 * a site at all: blocking it takes down every site anyone has ever deployed
 * there.
 *
 * Subdomains are *not* guarded: `evil-login.vercel.app` is one campaign's host
 * and blocking it harms nobody else. The guard is an exact match, on purpose.
 */
export const NEVER_BLOCK = new Set([
  // Shared file hosting and document services
  'dropbox.com', 'www.dropbox.com', 'drive.google.com', 'docs.google.com',
  'sites.google.com', 'storage.googleapis.com', 'firebasestorage.googleapis.com',
  'onedrive.live.com', 'sharepoint.com', '1drv.ms', 'mega.nz', 'mediafire.com',
  'github.com', 'raw.githubusercontent.com', 'githubusercontent.com', 'gitlab.com',
  's3.amazonaws.com', 'amazonaws.com', 'blob.core.windows.net',
  // Deployment platforms whose apex is a suffix, not a site
  'vercel.app', 'netlify.app', 'pages.dev', 'workers.dev', 'web.app',
  'firebaseapp.com', 'herokuapp.com', 'azurewebsites.net', 'glitch.me',
  'repl.co', 'replit.app', 'r2.dev', 'surge.sh', 'onrender.com',
  // Site builders
  'weebly.com', 'wixsite.com', 'blogspot.com', 'wordpress.com', 'notion.site',
  'squarespace.com', 'godaddysites.com', 'my.canva.site',
  // Link shorteners — the destination is the question, not the shortener
  'bit.ly', 't.co', 'tinyurl.com', 'is.gd', 'cutt.ly', 'rebrand.ly',
  // Ours. A feed that lists this service would take the service down with it.
  'okolos-proxy.sergeysheleg4.workers.dev',
])

/** Chrome's dynamic-rule ceiling, mirrored from `packages/core-feeds/src/rules.ts`. */
export const RULE_LIMIT = 5000

/**
 * Below this many characters, a two-label host is a shortener, not a campaign.
 *
 * The fixed list above cannot keep up: the first real run produced `g5.lu`,
 * `goo.su`, `s4w.in`, `i.gal` and `vo.la`, none of which was on it, and all
 * five are URL shorteners. OpenPhish lists the shortened link because that is
 * what it saw; blocking the host takes down every link anyone has ever
 * shortened there.
 *
 * Measured before it was written, on the 253 entries of the first run: five
 * hosts fall under this rule and all five are shorteners, against a median host
 * length of 22. A throwaway phishing host is long — it imitates a brand or it
 * is a free subdomain — and short domains are expensive.
 *
 * The asymmetry decides the threshold rather than the accuracy does. A wrong
 * block here breaks every link on a shortener for everyone who installed this;
 * a wrong pass harms whoever clicks that one link. So the rule refuses, and
 * says which hosts it refused, rather than quietly keeping them.
 */
export const SHORT_HOST_CHARS = 8

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/

/**
 * The host a feed line is about, or null when the line is not about one.
 *
 * Comments, blank lines and anything that will not parse are dropped rather
 * than guessed at: a malformed line in a blocklist is not an invitation to
 * improvise a host out of it.
 */
export function hostFrom(line) {
  const trimmed = line.trim()
  if (trimmed === '' || trimmed.startsWith('#')) return null

  let host
  try {
    host = new URL(trimmed.includes('://') ? trimmed : `http://${trimmed}`).hostname
  } catch {
    return null
  }
  host = host.toLowerCase().replace(/\.$/, '')

  // A bare address is not a host this product can speak about. The interstitial
  // says which list flagged the *domain*, and there is no domain here to say.
  if (IPV4.test(host) || host.includes(':')) return null

  const labels = host.split('.')
  if (labels.length < 2 || labels.some((label) => label === '')) return null

  return host
}

/** Every host a source's text is about, in the order the source gave them. */
export function hostsFrom(text) {
  const seen = new Set()
  const hosts = []
  for (const line of text.split('\n')) {
    const host = hostFrom(line)
    if (host === null || seen.has(host)) continue
    seen.add(host)
    hosts.push(host)
  }
  return hosts
}

/**
 * Removes the hosts that must never be blocked whole, and says which.
 *
 * Returned rather than logged, because a caller that drops a guarded host in
 * silence has no way to notice a feed that has started listing Dropbox.
 */
export function guard(hosts) {
  const kept = []
  const refused = []
  for (const host of hosts) {
    /**
     * A public suffix is never a site, and the rule is what makes that fatal.
     *
     * Blocking rules are `||host^`, which covers every subdomain, so listing
     * `github.io` takes down **every GitHub Pages site** for everyone who
     * installed the extension. The guard used to be forty-eight hand-written
     * exact matches, and measured 2026-08-20 today's source carried nine hosts
     * under `github.io`, four under `backblazeb2.com`, and more under
     * `trycloudflare.com`, `edgeone.dev`, `bolt.host` and `webflow.io` — **not one
     * of them on the list**. Eighteen of its 281 entries were two labels, so the
     * source does report apexes; the day it reports one of these is the day the
     * extension breaks a platform. The short-host heuristic does not save it:
     * `github.io` is nine characters.
     *
     * This asks the question directly, against the same suffix table the
     * lookalike checks use, so a platform added in one place is known in both.
     */
    if (isPublicSuffix(host)) {
      refused.push({ host, why: 'a public suffix, not a site — a rule here covers every subdomain' })
    } else if (NEVER_BLOCK.has(host)) {
      refused.push({ host, why: 'a shared host — blocking it whole hits everyone on it' })
    } else if (host.length < SHORT_HOST_CHARS && host.split('.').length === 2) {
      refused.push({ host, why: 'too short to be a campaign host — almost certainly a shortener' })
    } else {
      kept.push(host)
    }
  }
  return { kept, refused }
}

/**
 * The largest share of the list a single run may remove.
 *
 * A source answering `200 OK` with a truncated body is not a failure any check
 * above can see: the parse succeeds, the hosts are real, and the run publishes a
 * higher version with fewer entries. Measured 2026-08-20 by truncating the body:
 * **v6 with 7 entries, silently unblocking 241 of 248** — announced as an update,
 * because the version rose.
 *
 * A third is generous on purpose. Phishing lists do turn over quickly and a real
 * day can drop a quarter of them; what a real day does not do is drop nine in
 * ten. The refusal names the numbers and stops, rather than writing a file that
 * looks like progress.
 */
export const MAX_SHRINK = 1 / 3

/** A sentence when the new list has shrunk too far to publish, `null` when it has not. */
export function shrankTooFar(previousCount, nextCount, limit = MAX_SHRINK) {
  const lost = previousCount - nextCount
  /**
   * Grew, stayed the same, or there was nothing there — all one answer.
   *
   * A separate `previousCount === 0` guard stood here too and a plant proved it
   * unreachable: a first run has nothing to lose, so `lost` is negative and this
   * line returns already. This line is **not** dead, and a second plant named the
   * input it carries — zero from zero is a share of `0/0`, which is `NaN`, and
   * `NaN <= limit` is false, so without it an empty previous list and an empty new
   * one produce a refusal about nothing. Unreachable through `main`, which throws
   * on a source that parsed to zero hosts long before here; kept and tested
   * anyway, because a function that answers nonsense for an input it cannot
   * currently receive is a function waiting for a caller.
   */
  if (lost <= 0) return null
  const share = lost / previousCount
  if (share <= limit) return null
  return (
    `the list would shrink from ${previousCount} to ${nextCount} entries — ` +
    `${Math.round(share * 100)}% gone, past the ${Math.round(limit * 100)}% ceiling. ` +
    `A source answering 200 with a truncated body looks exactly like this, and ` +
    `publishing it would raise the version while unblocking ${lost} hosts. ` +
    `Nothing was written. Run again, or check the source by hand.`
  )
}

/**
 * The snapshot, capped, with the count it left out.
 *
 * Order is the source's own — OpenPhish emits newest first — so the cap keeps
 * the freshest entries rather than an arbitrary slice.
 */
export function buildSnapshot({ hosts, version, updatedAt, limit = RULE_LIMIT }) {
  const entries = hosts.slice(0, limit)
  return {
    update: { kind: 'snapshot', body: { name: 'phishing', version, updatedAt, entries } },
    dropped: Math.max(0, hosts.length - entries.length),
  }
}

async function fetchSource({ name, url }, fetchImpl = fetch) {
  const response = await fetchImpl(url, {
    redirect: 'follow',
    headers: { 'user-agent': 'okolos-feed-ingest (+https://github.com/passioncode-ai/okolos)' },
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`)
  const text = await response.text()
  if (text.trim() === '') throw new Error(`${name}: empty response`)
  return text
}

/** Where a run writes when nobody says otherwise: the agent's state, outside the tree. */
export function defaultOut() {
  return feedPaths().feed
}

/** The committed snapshot, read as a lower bound for the version on a new machine. */
const SEED = path.join(root, 'feeds/phishing.json')

/** A feed file's version and entry count, or null when there is no readable file. */
function readLocal(file) {
  if (!file) return null
  let parsed
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
  const body = parsed?.update?.body ?? parsed?.body
  return {
    version: Number.isSafeInteger(body?.version) ? body.version : 0,
    count: Array.isArray(body?.entries) ? body.entries.length : 0,
  }
}

/**
 * Fetches, guards, versions and writes one snapshot. Returns the update.
 *
 * Every dependency is passed in so the version rule can be tested against a
 * planted stale file without a network: `fetchImpl` answers both the source and
 * the worker, `out` is where the snapshot goes, `seed` the committed lower bound.
 */
export async function ingest({
  out = defaultOut(),
  seed = SEED,
  base = process.env.OKOLOS_WORKER_URL ?? DEFAULT_WORKER,
  fetchImpl = fetch,
  dryRun = false,
  now = () => new Date(),
  log = console.log,
} = {}) {
  // The served feed first: without its version the next one cannot be chosen
  // safely, and a source fetched for nothing is a request wasted.
  const served = await readServed({ base, fetchImpl })
  const local = readLocal(out)
  const committed = readLocal(seed)
  log(
    `served: ${served.state === 'served' ? `v${served.version}, ${served.count} entries` : 'nothing yet'}; ` +
      `local: ${local ? `v${local.version}` : 'none'}; seed: ${committed ? `v${committed.version}` : 'none'}`,
  )

  const all = []
  for (const source of SOURCES) {
    // Not caught. A source that failed must not produce a shorter list: the
    // version would rise, the entries would fall, and every host that dropped
    // out would be silently unblocked by what announces itself as an update.
    const text = await fetchSource(source, fetchImpl)
    const hosts = hostsFrom(text)
    if (hosts.length === 0) throw new Error(`${source.name}: parsed to zero hosts`)
    log(`${source.name}: ${hosts.length} hosts`)
    all.push(...hosts)
  }

  const { kept, refused } = guard([...new Set(all)])
  if (refused.length > 0) {
    // Printed, always. A guard that drops hosts in silence is indistinguishable
    // from a feed that never listed them, and the day this list starts refusing
    // twenty a run is the day the source changed shape.
    log(`refused ${refused.length} host(s):`)
    for (const { host, why } of refused) log(`  ${host} — ${why}`)
  }

  const { update, dropped } = buildSnapshot({
    hosts: kept,
    version: nextVersion({
      served: served.state === 'served' ? served.version : null,
      local: [local?.version ?? 0, committed?.version ?? 0],
    }),
    updatedAt: now().toISOString(),
  })
  if (dropped > 0) log(`over the ${RULE_LIMIT} ceiling: ${dropped} entries left out`)

  log(`version ${update.body.version}: ${update.body.entries.length} entries`)

  // After the build and before the write: the numbers to compare only exist here.
  // Against what users hold — the served list — when there is one; a local file
  // can be missing or stale, and the served list is what a shrink would unblock.
  const previousCount = served.state === 'served' ? served.count : (local?.count ?? committed?.count ?? 0)
  const shrink = shrankTooFar(previousCount, update.body.entries.length)
  if (shrink) throw new Error(shrink)

  if (dryRun) {
    log('--dry-run: nothing written')
    return update
  }
  // Whole or not at all: a half-written feed is a feed the next run cannot read
  // its version from.
  mkdirSync(path.dirname(out), { recursive: true, mode: 0o700 })
  const temporary = `${out}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(update, null, 2)}\n`, { mode: 0o600 })
  renameSync(temporary, out)
  log(`wrote ${out} — sign and publish with tools/publish-feed.mjs`)
  return update
}

function argument(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

async function main() {
  const paths = feedPaths()
  // One run at a time across every entry point (LC-03); a child of the feed job
  // passes the job's token through and is let in.
  const lock = acquireLock(paths.lock, { inherited: process.env.OKOLOS_FEED_LOCK })
  try {
    await ingest({ out: argument('--out') ?? paths.feed, dryRun: process.argv.includes('--dry-run') })
  } finally {
    lock.release()
  }
}

if (import.meta.filename === process.argv[1]) {
  main().catch((cause) => {
    console.error(`ingest: ${cause instanceof Error ? cause.message : String(cause)}`)
    process.exit(1)
  })
}
