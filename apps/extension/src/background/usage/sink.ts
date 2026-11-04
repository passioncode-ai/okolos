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

export const ENDPOINT = 'https://analytics.passioncode.ai/api/v0/events'
const SDK_VERSION = 'okolos-usage@1'
/** Aptabase refuses more in one request. */
const BATCH = 25
/** Aptabase refuses an event older than a day; a late one is dropped, never sent. */
const MAX_AGE_MS = 24 * 60 * 60 * 1000
/** A device that never reaches the network must not grow this without end. */
const QUEUE_MAX = 500
/** One flush sends at most this many batches; the rest waits for the next. */
const BATCHES_PER_FLUSH = 4

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
  sessionId(): string
  /** Injected into the store build only; `null` everywhere else, which sends nothing. */
  readonly appKey: string | null
  /** `production` for the store build, `sandbox` for every other build. */
  readonly environment: 'production' | 'sandbox'
  /** Where collection starts before anybody touched the switch: the browser's answer in Firefox. */
  readonly initialConsent: 'on' | 'off'
  readonly appVersion: string
  readonly system: {
    readonly osName: string
    readonly osVersion?: string
    readonly engineName: string
    readonly engineVersion: string
    readonly locale: string
  }
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
      const event: QueuedEvent = {
        eventName: name,
        at: deps.now(),
        sessionId: deps.sessionId(),
        props: { ...(props as Record<string, string>), iid, environment: deps.environment, platform: 'browser_extension' },
      }
      const queue = [...state.queue, event].slice(-QUEUE_MAX)
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
      for (let round = 0; round < BATCHES_PER_FLUSH && state.queue.length > 0; round += 1) {
        const batch = state.queue.slice(0, BATCH)
        const body = JSON.stringify(batch.map((event) => wire(event, deps)))
        let drop: boolean
        try {
          const response = await deps.send({
            url: ENDPOINT,
            body,
            headers: { 'App-Key': deps.appKey, 'Content-Type': 'application/json' },
          })
          // Retried only on 429 and 5xx; a 400 or 404 would fail the same way every time.
          drop = response.ok || response.status === 400 || response.status === 404
        } catch {
          drop = false
        }
        if (!drop) return
        // Re-read: an event tracked while the request was in flight was appended at the end and
        // must not be lost. Only a flush takes from the head, so the batch is the first
        // `batch.length` events of what is stored now.
        const latest = await read()
        state = { ...latest, queue: latest.queue.slice(batch.length) }
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

function wire(event: QueuedEvent, deps: UsageDeps) {
  return {
    timestamp: new Date(event.at).toISOString(),
    sessionId: event.sessionId,
    eventName: event.eventName,
    systemProps: {
      isDebug: deps.environment !== 'production',
      locale: deps.system.locale,
      osName: deps.system.osName,
      osVersion: deps.system.osVersion ?? '',
      appVersion: deps.appVersion,
      appBuildNumber: '',
      sdkVersion: SDK_VERSION,
      engineName: deps.system.engineName,
      engineVersion: deps.system.engineVersion,
    },
    props: event.props,
  }
}
