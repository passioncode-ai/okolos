import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { feedPaths } from './feed/paths.mjs'

/**
 * How old the shipped blocklist is, and how old it is allowed to be.
 *
 * There was no gate of any kind on this. Measured 2026-08-19: the feed in the
 * repository and the one the extension downloads matched, the signature verified,
 * every test was green — and the list was **five days and twenty-two hours old**
 * against a source that turns over roughly every twelve hours. The intersection
 * of its 248 hosts with that day's OpenPhish was **one host**. Two hundred and
 * eighty hosts the source considered live were not blocked, and the extension
 * asked four times a day and got the same file back.
 *
 * That is the failure this module exists to make visible: every mechanism working
 * perfectly on a list that protects almost nobody.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The ceiling, and why it is this number rather than twelve hours.
 *
 * ADR-0010 records the source's cycle as ~12 hours, and a freshness gate at
 * twelve hours would be red on almost every commit — publishing is a local step
 * by ADR-0002, because the private key stays on the machine and moving it into CI
 * is the trade that decision refused. A gate that is red for a reason nobody can
 * fix from where they are standing is the gate people learn to skip, which is
 * exactly what `OKOLOS_SKIP_GATES=1` was invented for and what B-26 was about.
 *
 * So the ceiling is set where the *harm* is, not where the source's cycle is.
 * Fourteen days is past the point where most entries are dead — the measurement
 * above found one live host in 248 after six days — so a feed older than this is
 * not a stale list, it is an abandoned one, and shipping it claims a protection
 * that does not exist.
 */
export const FEED_MAX_AGE_DAYS = 14

/** Where the interval belongs for anyone reading the schedule. */
export const FEED_REFRESH_HOURS = 12

/** The committed snapshot: a seed and a reference, refreshed by `pnpm feed:snapshot`. */
export const FEED_PATH = 'feeds/phishing.json'

/**
 * The newest feed among `candidates`, by the timestamp each carries.
 *
 * The agent writes its state outside the git working tree (F1), so on the
 * publishing machine `~/.okolos/state/feeds/phishing.json` is the feed that was
 * last signed and served, while the committed snapshot moves only when someone
 * commits it. CI has only the snapshot. A candidate that is missing or unreadable
 * is skipped; with none readable the snapshot is returned, and its own read fails
 * loudly.
 */
export function freshestFeed(candidates = [FEED_PATH, feedPaths().feed]) {
  let best = null
  let bestAt = -Infinity
  for (const candidate of candidates) {
    const file = path.resolve(root, candidate)
    if (!existsSync(file)) continue
    try {
      const at = Date.parse(JSON.parse(readFileSync(file, 'utf8'))?.body?.updatedAt)
      if (Number.isFinite(at) && at > bestAt) {
        best = candidate
        bestAt = at
      }
    } catch {
      // unreadable: not a candidate
    }
  }
  return best ?? candidates[0]
}

/**
 * The feed's age in days, from the timestamp it carries.
 *
 * From `body.updatedAt` and not from the file's mtime: a checkout, a rebase or a
 * copy rewrites mtime, so the filesystem would report a fresh feed for a file
 * whose contents were built a month ago. The timestamp is what the signature
 * covers.
 */
export function feedAgeDays(now = Date.now(), file = FEED_PATH) {
  // `resolve` and not `join`: the caller may hand an absolute path — a test does —
  // and joining prefixes the repository root onto it, producing a path that
  // exists nowhere and an error about the wrong thing.
  const raw = JSON.parse(readFileSync(path.resolve(root, file), 'utf8'))
  const updatedAt = raw?.body?.updatedAt
  if (typeof updatedAt !== 'string') {
    throw new Error(`${file} carries no body.updatedAt — its age cannot be known`)
  }
  const at = Date.parse(updatedAt)
  if (!Number.isFinite(at)) {
    throw new Error(`${file} has an unreadable body.updatedAt: ${updatedAt}`)
  }
  return (now - at) / 86_400_000
}

/**
 * The release verdict: `null` when the feed may ship, a sentence when it may not.
 *
 * A sentence rather than a boolean, because the person who reads it is about to
 * decide whether to publish, and "false" tells them nothing about what to do.
 */
export function feedTooOld(now = Date.now(), file = FEED_PATH) {
  const days = feedAgeDays(now, file)
  if (days <= FEED_MAX_AGE_DAYS) return null
  return (
    `${file} is ${days.toFixed(1)} days old, past the ${FEED_MAX_AGE_DAYS}-day ceiling. ` +
    `The source turns over about every ${FEED_REFRESH_HOURS} hours, so a list this old ` +
    `blocks almost nothing that is still live — measured 2026-08-19, one host of 248 ` +
    `after six days. Run \`pnpm feed:refresh\` on the machine that holds the signing key ` +
    `(ADR-0002: the worker never signs), or install the launchd agent ` +
    `(\`pnpm feed:agent\`) so it stops being a thing anyone has to remember. ` +
    `\`pnpm feed:snapshot\` then copies the published feed into ${FEED_PATH} for a commit.`
  )
}
