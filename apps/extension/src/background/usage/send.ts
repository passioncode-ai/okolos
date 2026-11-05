import { request, type RequestDeps } from '@okolos/net'

import type { UsageDeps } from './sink.js'

/**
 * The sink's `send`, through the single network module under the purpose `usage-data`
 * (ADR-0003): the audit entry is written before the request, the redactor reads the body, and
 * the purpose can reach `analytics.passioncode.ai` only. The audit row names the event that
 * left, which is what a person can check against the self-audit panel.
 */
export function usageSender(deps: RequestDeps, deadlineMs = SEND_DEADLINE_MS): UsageDeps['send'] {
  return (spec) =>
    withDeadline(request(
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
    ), deadlineMs)
}

/**
 * A send waits at most this long. The usage steps run one at a time, so one request that never
 * answers would hold the settings switch and the first-run screen behind it; the transport sets
 * no deadline of its own.
 */
const SEND_DEADLINE_MS = 15_000

/** Rejects as a transport failure (`TypeError`) at the deadline, so the event waits for the next send. */
function withDeadline(sent: Promise<Response>, ms: number): Promise<Response> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TypeError(`usage send gave no answer within ${ms} ms`)), ms)
  })
  return Promise.race([sent, late]).finally(() => clearTimeout(timer))
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
