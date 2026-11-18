// The store listing names the served /privacy page as the policy (docs/store/listing.md). A store
// archive that sends usage data must not go out while that page still says it does not: the
// worker is deployed separately (docs/runbooks/worker-deploy.md), so `pnpm package` checks, before
// it builds anything, that the served page carries docs/privacy.md as tools/privacy-page.mjs
// renders it (rounds 2 and 5 of B-199's certification).

export const PRIVACY_URL = 'https://okolos-proxy.sergeysheleg4.workers.dev/privacy'

/** The «Обновлено YYYY-MM-DD» date of a policy, in Markdown or in the served HTML; null when absent. */
export function policyDate(text) {
  const match = /Обновлено (\d{4}-\d{2}-\d{2})/.exec(text)
  return match ? match[1] : null
}

/**
 * Why the served page is not the document's, or null when it carries it. By content, not by the
 * date alone: docs/privacy.md changed five times on one day, every version dated that day.
 * @param {string} served the body /privacy answered
 * @param {string} document docs/privacy.md
 * @param {string} html the document as tools/privacy-page.mjs renders it for the worker
 */
export function servedPolicyBehind(served, document, html) {
  const wanted = policyDate(document)
  const got = policyDate(served)
  if (wanted === null) return 'docs/privacy.md has no «Обновлено» date'
  if (got === null) return `${PRIVACY_URL} carries no «Обновлено» date`
  if (got < wanted) return `${PRIVACY_URL} is the policy of ${got}, docs/privacy.md is of ${wanted}`
  if (!served.includes(html)) {
    return got === wanted
      ? `${PRIVACY_URL} differs from docs/privacy.md (both dated ${wanted})`
      : `${PRIVACY_URL} (dated ${got}) differs from docs/privacy.md (dated ${wanted})`
  }
  return null
}
