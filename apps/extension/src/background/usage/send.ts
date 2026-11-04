import { request, type RequestDeps } from '@okolos/net'

import type { UsageDeps } from './sink.js'

/**
 * The sink's `send`, through the single network module under the purpose `usage-data`
 * (ADR-0003): the audit entry is written before the request, the redactor reads the body, and
 * the purpose can reach `analytics.passioncode.ai` only. The audit row says how many events
 * left, which is what a person can check against the self-audit panel.
 */
export function usageSender(deps: RequestDeps): UsageDeps['send'] {
  return (spec) =>
    request(
      {
        url: spec.url,
        method: 'POST',
        purpose: 'usage-data',
        payloadShape: `usage-events:${countEvents(spec.body)}`,
        triggeredBy: 'alarm:usage',
        body: spec.body,
        headers: spec.headers,
      },
      deps,
    )
}

function countEvents(body: string): number {
  try {
    const parsed: unknown = JSON.parse(body)
    return Array.isArray(parsed) ? parsed.length : 0
  } catch {
    return 0
  }
}
