/**
 * What the worker serves — the feed's source of truth for its version (F1).
 *
 * Extensions refuse any update whose version is not above the one they hold
 * (`packages/core-feeds/src/apply.ts`), so the only version that matters when
 * choosing the next one is the highest anyone may already hold: the served one.
 */

export const DEFAULT_WORKER = 'https://okolos-proxy.sergeysheleg4.workers.dev'
export const SERVED_TIMEOUT_MS = 20_000

/**
 * `{ state: 'absent' }` when nothing is published under the name (a first run), or
 * `{ state: 'served', version, updatedAt, count, text }`. Anything else throws: a
 * version that cannot be read cannot be stepped past.
 */
export async function readServed({
  base = DEFAULT_WORKER,
  name = 'phishing',
  fetchImpl = fetch,
  timeoutMs = SERVED_TIMEOUT_MS,
  now = Date.now,
} = {}) {
  // `cb` past the edge cache: `/feeds/*` is served with max-age=900, and a copy
  // fifteen minutes old could hide the version a previous run just published.
  const url = `${base}/feeds/${name}?cb=${now()}`
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (response.status === 404) return { state: 'absent' }
  if (!response.ok) throw new Error(`the served feed answered HTTP ${response.status} at ${url}`)
  const text = await response.text()
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`the served feed at ${url} is not JSON`)
  }
  const body = parsed?.update?.body ?? parsed?.body
  const version = body?.version
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new Error(`the served feed carries no usable version: ${JSON.stringify(version)}`)
  }
  return {
    state: 'served',
    version,
    updatedAt: typeof body.updatedAt === 'string' ? body.updatedAt : null,
    count: Array.isArray(body.entries) ? body.entries.length : 0,
    text,
  }
}

/** One past the highest version anyone has seen — served or local. */
export function nextVersion({ served, local = [] }) {
  const known = [served ?? 0, ...local].filter((value) => Number.isSafeInteger(value))
  return Math.max(0, ...known) + 1
}

/** A sentence when `version` would be refused by extensions holding `served`, else null. */
export function refuseBackwards(version, served) {
  if (served === null || served === undefined) return null
  if (version > served) return null
  return (
    `version ${version} is not newer than the served ${served}: every extension holding ` +
    `${served} would refuse it as a replay. Nothing was published.`
  )
}
