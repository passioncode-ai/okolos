import { request, type RequestDeps } from '@okolos/net'
import { withDeadline } from '@okolos/platform'

import { CATALOGUE } from './catalogue.js'
import type { UsageDeps } from './sink.js'

/**
 * The sink's `send`, through the single network module under the purpose `usage-data`
 * (ADR-0003): the audit entry is written before the request, the redactor reads the body, and
 * the purpose can reach `analytics.passioncode.ai` only. The audit row names the event that
 * left and its values from the closed catalogue, which is what a person can check against the
 * self-audit panel.
 */
export function usageSender(deps: RequestDeps, deadlineMs = SEND_DEADLINE_MS): UsageDeps['send'] {
  return (spec) =>
    sentWithin(
      request(
        {
          url: spec.url,
          method: 'POST',
          purpose: 'usage-data',
          payloadShape: shapeOf(spec.body),
          // Sent with the feed alarm, the only one that flushes: the row names it as it is.
          triggeredBy: 'alarm:feeds',
          body: spec.body,
          headers: spec.headers,
        },
        deps,
      ),
      deadlineMs,
    )
}

/**
 * A send waits at most this long. The usage steps run one at a time, so one request that never
 * answers would hold the settings switch and the first-run screen behind it; the transport sets
 * no deadline of its own.
 */
const SEND_DEADLINE_MS = 15_000

/**
 * The shared deadline (`@okolos/platform`, one copy of the failure path), its refusal turned into
 * a transport failure (`TypeError`), so the event waits for the next send instead of being dropped.
 */
async function sentWithin(sent: Promise<Response>, ms: number): Promise<Response> {
  // i18n-exempt: a transport failure the sink reads to keep the event; never shown to anyone
  const late = `usage send gave no answer within ${ms} ms`
  try {
    return await withDeadline(sent, ms, late)
  } catch (cause) {
    throw cause instanceof Error && cause.message === late ? new TypeError(late) : cause
  }
}

/**
 * What the self-audit row shows: the event's name and its values from the closed catalogue
 * (`usage-event:check_done check=password result=found`), so the outcome that left can be
 * checked in the log (B-215, round 21). Only catalogue props with a listed value are named; the
 * install number and the constant labels are not, and a body that does not parse is `unknown`.
 */
function shapeOf(body: string): string {
  try {
    const parsed = JSON.parse(body) as { eventName?: unknown; props?: Record<string, unknown> }
    const name = typeof parsed.eventName === 'string' ? parsed.eventName : 'unknown'
    if (!Object.hasOwn(CATALOGUE, name)) return `usage-event:${name}`
    const allowed = CATALOGUE[name as keyof typeof CATALOGUE] as Readonly<Record<string, readonly string[]>>
    const values = Object.keys(allowed)
      .filter((key) => (allowed[key] as readonly unknown[]).includes(parsed.props?.[key]))
      .map((key) => `${key}=${String(parsed.props?.[key])}`)
    return [`usage-event:${name}`, ...values].join(' ')
  } catch {
    return 'usage-event:unknown'
  }
}
