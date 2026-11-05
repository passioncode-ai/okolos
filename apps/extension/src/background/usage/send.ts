import { request, type RequestDeps } from '@okolos/net'

import type { UsageDeps } from './sink.js'

/**
 * The sink's `send`, through the single network module under the purpose `usage-data`
 * (ADR-0003): the audit entry is written before the request, the redactor reads the body, and
 * the purpose can reach `analytics.passioncode.ai` only. The audit row names the event that
 * left, which is what a person can check against the self-audit panel.
 */
export function usageSender(deps: RequestDeps): UsageDeps['send'] {
  return (spec) =>
    request(
      {
        url: spec.url,
        method: 'POST',
        purpose: 'usage-data',
        payloadShape: `usage-event:${eventName(spec.body)}`,
        // Sent with the feed alarm, the only one that flushes: the row names it as it is.
        triggeredBy: 'alarm:feeds',
        body: spec.body,
        headers: spec.headers,
      },
      deps,
    )
}

/** The event's name from the closed catalogue, which is what the self-audit row shows. */
function eventName(body: string): string {
  try {
    const parsed = JSON.parse(body) as { eventName?: unknown }
    return typeof parsed.eventName === 'string' ? parsed.eventName : 'unknown'
  } catch {
    return 'unknown'
  }
}
