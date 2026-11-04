import type { Purpose } from '@okolos/contracts'

/**
 * Where each purpose may send, checked at run time.
 *
 * The egress point was otherwise exemplary — one `fetch` in the tree, the audit
 * entry written before the request and a failed write cancelling it, a closed set
 * of six purposes, a redactor with two rounds of percent-decoding — and the
 * destination was computed **only for the journal**. Any URL with a valid purpose
 * and a clean payload went to any host.
 *
 * Hosts were gated by a document instead: `tools/docs.test.ts` swept `https://`
 * literals out of `apps/extension/src` and required each to be listed. Three ways
 * past that, and none of them exotic: a literal in `packages/` (where the model
 * manager's and the leak lookup's own URLs live), a URL assembled from parts, and
 * anything not spelled `https://`. A gate that reads one directory for one prefix
 * is a gate about that directory and that prefix.
 *
 * **This list is the single source and the check is a comparison, not a scan.**
 * It is keyed by purpose rather than being one flat set, because "the leak lookup
 * may reach Have I Been Pwned" and "the feed may reach Have I Been Pwned" are
 * different claims, and only the first is true.
 */
export const DESTINATIONS: Readonly<Record<Purpose, readonly string[]>> = {
  /** The project's own worker, which serves the signed feed files. */
  'feed-update': ['okolos-proxy.sergeysheleg4.workers.dev'],

  /**
   * The k-anonymity range API. Five characters of a SHA-1 prefix go out and
   * nothing else — `docs/privacy.md` says so, and the redactor enforces it.
   */
  'password-range': ['api.pwnedpasswords.com'],

  /**
   * Two, and the difference between them is stated in SCN-015: the address goes
   * out whole to both, which is why each is declared in `carries` and appears in
   * the audit entry.
   */
  'leak-lookup': ['haveibeenpwned.com', 'cavalier.hudsonrock.com'],

  /**
   * **No destination, deliberately.** The third stage is not shipped
   * ([ADR-0006](../../../docs/adr/0006-third-stage-not-shipped.md)), so nothing
   * in the product asks for a model file. An empty list is not an oversight and
   * not a placeholder: it means a call that appears here later **cannot send at
   * all** until somebody adds a host on purpose, which is the difference between
   * an unimplemented purpose and an open one.
   */
  'model-update': [],

  /**
   * **No destination, and no producer.** Nothing in the tree computes a file
   * hash to send anywhere: downloads are judged against the feed and against
   * locally computed digests, and the digest never leaves. The purpose survives
   * because the audit panel has wording for it and REQ-19 names it; the empty
   * list is what keeps that from being a way out.
   */
  'file-hash': [],

  /**
   * **No destination, because this one does not use the choke point.** The public
   * status page is reached by *navigating* the user's own tab to
   * `okolos-proxy…/status`, which is a link the person follows rather than a
   * request the product makes — so there is nothing to audit and nothing to send.
   * If it ever becomes a fetch, this list is where it has to be admitted.
   */
  'domain-status': [],

  /**
   * Usage and error events (B-198, B-199): names of actions and errors from a closed
   * catalogue, a random install id, the extension version, browser and system, and never
   * a page address, page text, file name, email or password. The organisation's Aptabase,
   * not `analytics.sshlg.me`: PassionCode products send to their own server
   * (sshlg-growth, 2026-11-04).
   */
  'usage-data': ['analytics.passioncode.ai'],
}

/**
 * Whether `hostname` is a destination `purpose` is allowed to reach.
 *
 * Exact host match, no suffix matching. `||host^`-style suffix rules are right
 * for blocking and wrong here: `api.pwnedpasswords.com.evil.test` ends with the
 * allowed name, and a subdomain of a destination is not the destination.
 */
export function allowedDestination(purpose: Purpose, hostname: string): boolean {
  const hosts = DESTINATIONS[purpose]
  /**
   * Unreachable through `request`, which checks its closed set of purposes first,
   * and reachable by anyone importing this — where the type is a suggestion.
   * Without it, `hosts` is `undefined` and `.includes` throws a `TypeError` out of
   * a security check, which a caller is far more likely to catch and ignore than a
   * `false`. A plant proved it carries exactly this input, so a test says so.
   */
  if (!hosts) return false
  return hosts.includes(hostname.trim().toLowerCase())
}
