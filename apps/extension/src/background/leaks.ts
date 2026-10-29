import { t } from '@okolos/i18n'
import {
  HIBP_KEY_HEADER_SHAPE,
  HIBP_SOURCE,
  mergeLeaks,
  type KeyRemedy,
  type Leak,
  type LeakInventory,
  type SourceStatus,
} from '@okolos/core-leaks'
import { request, type RequestDeps } from '@okolos/net'
import { withDeadline } from '@okolos/platform'

/**
 * Asking several places whether an address has appeared in a breach.
 *
 * Every source here is optional and every one of them can be silent, which is
 * the normal case rather than the exception: one needs a key the user may not
 * have, another rate-limits, a third is simply down. The merge reports which
 * ones answered, and the panel shows that beside the total — a number whose
 * basis is unstated is the thing this feature exists to replace.
 *
 * What leaves the device is the address the user typed into the box, to the
 * sources they can see named, when they press the button. Nothing is looked up
 * in the background.
 *
 * Every source gets a deadline. Without one a source that accepts the
 * connection and then says nothing holds the whole check open forever, and the
 * panel sits on "Asking the sources…" with no way out — the failure that is
 * indistinguishable, to the person waiting, from the product being broken. A
 * source that misses its deadline is reported the same way as one that refused:
 * named, with the reason.
 */

/** Long enough for a slow API, short enough that a hung one is not forever. */
export const SOURCE_TIMEOUT_MS = 10_000

export interface LeakSource {
  readonly name: string
  /** Null when the source cannot run — the reason is shown to the user. */
  readonly unavailable: string | null
  /** Set when `unavailable` is for want of the person's key, so the screen can point at the field. */
  readonly needsKey?: KeyRemedy
  lookup(address: string, deps: RequestDeps): Promise<readonly Leak[]>
}

/**
 * The source answered that the key is not good. Its own type so the merge can tell "fix
 * the key" from "wait and try again", which a message string cannot carry.
 */
class KeyRefused extends Error {}

/** The key remedies, named once. */
const KEY_MISSING: KeyRemedy = 'missing'
const KEY_REFUSED: KeyRemedy = 'refused'
const KEY_UNREADABLE: KeyRemedy = 'unreadable'

export const CAVALIER: LeakSource = {
  name: 'Hudson Rock Cavalier',
  unavailable: null,
  async lookup(address, deps) {
    const response = await request(
      {
        url: `https://cavalier.hudsonrock.com/api/json/v2/osint-tools/search-by-email?email=${encodeURIComponent(address)}`,
        method: 'GET',
        purpose: 'leak-lookup',
        payloadShape: `email:${redact(address)}`,
        triggeredBy: 'user:leak-check',
        // Cavalier answers to a full address and to nothing else. Declared, so
        // the choke point permits it knowingly and the journal records that an
        // address left the device — rather than it slipping past a guard that
        // could not see through percent-encoding.
        carries: 'address',
      },
      deps,
    )
    const body = (await response.json()) as { stealers?: Array<{ date_compromised?: string }> }
    return (body.stealers ?? []).map((entry) => ({
      name: 'Infostealer infection',
      occurredAt: entry.date_compromised?.slice(0, 10) ?? null,
      source: CAVALIER.name,
      classes: ['saved passwords', 'session cookies'],
    }))
  },
}

/**
 * The breached-account API needs a paid key. Without one the source is not
 * silently dropped: it reports why it could not run, and the coverage line says
 * the list may be incomplete because of it.
 *
 * The key is the person's own, saved on the settings screen (B-125). It travels in
 * exactly one place, the `hibp-api-key` header the API requires; the audit entry the
 * choke point writes carries no headers, and nothing here logs it.
 */
export function hibp(apiKey: string | null): LeakSource {
  const name = HIBP_SOURCE
  return {
    name,
    // Not caught by the sweep — a capital letter inside the run defeats its anchor, the
    // same family of blind spot as B-76 — and it travels in the same field as the
    // timeout above, which a person can be shown.
    unavailable: apiKey ? null : t('leakSourceNoKey', name),
    ...(apiKey ? {} : { needsKey: KEY_MISSING }),
    async lookup(address, deps) {
      const response = await request(
        {
          url: `https://haveibeenpwned.com/api/v3/breachedaccount/${encodeURIComponent(address)}?truncateResponse=false`,
          method: 'GET',
          purpose: 'leak-lookup',
          // The header is named, never its value: the self-audit's "what left" line has to say a
          // key left, and this log is exportable (B-125 round 2).
          payloadShape: `email:${redact(address)}, ${HIBP_KEY_HEADER_SHAPE}`,
          triggeredBy: 'user:leak-check',
          headers: { 'hibp-api-key': apiKey ?? '' },
          // The address is a path segment here, which the guard did not
          // inspect at all until 2026-08-08. Declared for the same reason.
          carries: 'address',
        },
        deps,
      )
      if (response.status === 404) return []
      // 401 is this API's word for a key it does not accept. Any other failure used to be
      // read as a list of breaches and surfaced as "body.map is not a function".
      if (response.status === 401) throw new KeyRefused(t('leakSourceKeyRefused', name))
      if (!response.ok) throw new Error(t('leakSourceStatus', name, String(response.status)))
      const body = (await response.json()) as Array<{
        Name?: string
        Domain?: string
        BreachDate?: string
        DataClasses?: string[]
      }>
      return body.map((entry) => ({
        name: entry.Name ?? 'Unnamed breach',
        occurredAt: entry.BreachDate ?? null,
        source: 'Have I Been Pwned',
        classes: entry.DataClasses ?? [],
        // Carried through so the panel can offer a page rather than describe
        // one. HIBP leaves it blank for breaches it cannot attribute.
        ...(entry.Domain ? { domain: entry.Domain } : {}),
      }))
    },
  }
}

/**
 * The breached-account source, built from whatever the store says about the saved key.
 *
 * Three answers, and the third is why this exists: a key, no key, or a store that could not
 * be read. The last used to read as "no key saved", so a storage failure told the person to
 * add a key they may already have, and linked to a field that is not drawn when storage
 * fails. It is still not asked, and the reason says what actually happened.
 */
export async function hibpFromStore(read: () => Promise<unknown>): Promise<LeakSource> {
  let stored: unknown
  try {
    stored = await read()
  } catch {
    return {
      ...hibp(null),
      unavailable: t('leakSourceKeyUnreadable', HIBP_SOURCE),
      needsKey: KEY_UNREADABLE,
    }
  }
  return hibp(typeof stored === 'string' && stored !== '' ? stored : null)
}

export async function lookupLeaks(
  address: string,
  sources: readonly LeakSource[],
  deps: RequestDeps,
  timeoutMs = SOURCE_TIMEOUT_MS,
): Promise<LeakInventory> {
  const statuses: SourceStatus[] = []

  for (const source of sources) {
    if (source.unavailable) {
      statuses.push({
        name: source.name,
        answered: false,
        why: source.unavailable,
        ...(source.needsKey === undefined ? {} : { needsKey: source.needsKey }),
      })
      continue
    }
    try {
      const leaks = await withDeadline(
        source.lookup(address, deps),
        timeoutMs,
        t('leakSourceTimedOut', source.name, String(Math.round(timeoutMs / 1000))),
      )
      statuses.push({ name: source.name, answered: true, leaks })
    } catch (cause) {
      // One source failing must not take the others with it, and must not be
      // mistaken for that source having nothing to report.
      statuses.push({
        name: source.name,
        answered: false,
        why: cause instanceof Error ? cause.message : String(cause),
        ...(cause instanceof KeyRefused ? { needsKey: KEY_REFUSED } : {}),
      })
    }
  }

  return mergeLeaks(statuses)
}

/** What the audit log shows: enough to recognise, not enough to be the address. */
function redact(address: string): string {
  const [local = '', domain = ''] = address.split('@')
  return `${local.slice(0, 1)}***@${domain}`
}
