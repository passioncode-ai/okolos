import { AuditWriteError } from '@okolos/net'

import { admissible, type EventName, type EventProps } from './catalogue.js'

/**
 * The one place usage and error events pass through (B-198, B-199).
 *
 * The operator's decision of 2026-11-04: anonymous data about use and errors, on by default,
 * switched off in settings. Everything the growth platform needs to count an event (`iid`,
 * `environment`, `platform`) is attached here and nowhere else, so no call site can forget it
 * (skill usage-events). What may be sent is the closed catalogue; what is sent goes through the
 * network module under the purpose `usage-data`, which can reach `analytics.passioncode.ai`
 * only and writes the audit entry first (ADR-0003).
 */

/**
 * The single-event route, one event a request: with `osName` empty the server reads the OS and
 * the browser from the request's own User-Agent header, so the extension never asks which
 * system it runs on (B-166's promise, `tools/docs.test.ts` «asks no OS»). The batch route
 * stores `systemProps` as sent and would need the extension to read the OS itself.
 */
export const ENDPOINT = 'https://analytics.passioncode.ai/api/v0/event'
const SDK_VERSION = 'okolos-usage@1'
/** At most this many events a flush, each its own request; the rest waits for the next. */
const PER_FLUSH = 25
/** Aptabase refuses an event older than a day; a late one is dropped, never sent. */
const MAX_AGE_MS = 24 * 60 * 60 * 1000
/** A device that never reaches the network must not grow this without end. */
const QUEUE_MAX = 500

export interface QueuedEvent {
  readonly eventName: EventName
  readonly at: number
  readonly sessionId: string
  readonly props: Readonly<Record<string, string>>
}

export interface UsageState {
  readonly consent: 'on' | 'off'
  /** The random install id while collection is on; deleted when it is switched off. */
  readonly iid: string | null
  readonly queue: readonly QueuedEvent[]
}

export interface UsageDeps {
  load(): Promise<UsageState | undefined>
  save(state: UsageState): Promise<void>
  /** Sends through the network module's `request` with purpose `usage-data`. */
  send(spec: { url: string; body: string; headers: Record<string, string> }): Promise<Response>
  now(): number
  randomId(): string
  /** The session of this install in the hour of `at` (`sessionFor`), the same in every wake. */
  sessionId(iid: string, at: number): string
  /** Injected into the store build only; `null` everywhere else, which sends nothing. */
  readonly appKey: string | null
  /** `production` for the store build, `sandbox` for every other build. */
  readonly environment: 'production' | 'sandbox'
  /** Where collection starts before anybody touched the switch: the browser's answer in Firefox. */
  readonly initialConsent: 'on' | 'off'
  /** The extension's version, sent as `systemProps.appVersion`. */
  readonly extensionVersion: string
  /** The browser's language, for `systemProps.locale`. Nothing about the device. */
  readonly locale: string
}

export interface UsageSink {
  track<E extends EventName>(name: E, props: EventProps<E>): Promise<boolean>
  flush(): Promise<void>
  setConsent(on: boolean): Promise<void>
  consent(): Promise<'on' | 'off'>
}

export function createUsageSink(deps: UsageDeps): UsageSink {
  const read = async (): Promise<UsageState> =>
    (await deps.load()) ?? { consent: deps.initialConsent, iid: null, queue: [] }

  return {
    async track(name, props) {
      if (deps.appKey === null) return false
      const state = await read()
      if (state.consent !== 'on') return false
      if (!admissible(name, props as Readonly<Record<string, unknown>>)) return false
      const iid = state.iid ?? deps.randomId()
      // One reading of the clock: the time and the session cannot fall in two different hours.
      const at = deps.now()
      const event: QueuedEvent = {
        eventName: name,
        at,
        sessionId: deps.sessionId(iid, at),
        props: { ...(props as Record<string, string>), iid, environment: deps.environment, platform: 'browser_extension' },
      }
      // Nothing older than a day stays on the device, sent or not (docs/privacy.md).
      const queue = [...state.queue.filter((queued) => event.at - queued.at <= MAX_AGE_MS), event].slice(-QUEUE_MAX)
      await deps.save({ consent: 'on', iid, queue })
      return true
    },

    async flush() {
      if (deps.appKey === null) return
      let state = await read()
      if (state.consent !== 'on') {
        if (state.queue.length > 0) await deps.save({ ...state, queue: [] })
        return
      }
      const fresh = state.queue.filter((event) => deps.now() - event.at <= MAX_AGE_MS)
      if (fresh.length !== state.queue.length) {
        state = { ...state, queue: fresh }
        await deps.save(state)
      }
      for (let sent = 0; sent < PER_FLUSH && state.queue.length > 0; sent += 1) {
        const event = state.queue[0] as QueuedEvent
        let drop: boolean
        try {
          const response = await deps.send({
            url: ENDPOINT,
            body: JSON.stringify(wire(event, deps)),
            headers: { 'App-Key': deps.appKey, 'Content-Type': 'application/json' },
          })
          drop = response.ok || !retried(response.status)
        } catch (cause) {
          // Kept only for what may pass next time: a transport failure (fetch throws TypeError,
          // and so does the sender's deadline) or a failed audit write. Anything else, the net
          // module's own refusals included, would fail the same way and hold the queue.
          drop = !(cause instanceof TypeError || cause instanceof AuditWriteError)
        }
        if (!drop) return
        // Re-read: an event tracked while the request was in flight was appended at the end.
        // Only a flush takes from the head, so the one just sent is the first stored now.
        const latest = await read()
        state = { ...latest, queue: latest.queue.slice(1) }
        await deps.save(state)
      }
    },

    async setConsent(on) {
      await deps.save(on ? { consent: 'on', iid: deps.randomId(), queue: [] } : { consent: 'off', iid: null, queue: [] })
    },

    async consent() {
      return (await read()).consent
    },
  }
}

/** Kept for the next flush only on 408, 429 and 5xx; any other 4xx would fail the same way again. */
function retried(status: number): boolean {
  return status === 408 || status === 429 || status >= 500
}

function wire(event: QueuedEvent, deps: UsageDeps) {
  return {
    timestamp: new Date(event.at).toISOString(),
    sessionId: event.sessionId,
    eventName: event.eventName,
    systemProps: {
      isDebug: deps.environment !== 'production',
      locale: deps.locale.slice(0, 10),
      // Empty, so the single-event route fills the OS and the browser from the User-Agent.
      osName: '',
      appVersion: deps.extensionVersion,
      sdkVersion: SDK_VERSION,
    },
    props: event.props,
  }
}
