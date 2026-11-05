import { AuditWriteError, type RequestDeps } from '@okolos/net'
import { withDeadline, type Platform } from '@okolos/platform'

import type { EventName, EventProps } from './catalogue.js'
import { browserConsent, ConsentUnreadable, type ConsentApi, type ConsentState } from './consent.js'
import { usageSender } from './send.js'
import { createUsageSink, type UsageState } from './sink.js'
import { sessionFor } from './system.js'

/**
 * Set by the build. The store build made by `pnpm package` carries the App-Key and
 * `production`; every other build carries no key and `sandbox`, and a build with no key sends
 * nothing (client contract «Build modes»).
 */
interface Build {
  readonly appKey: string | null
  readonly environment: 'production' | 'sandbox'
}

declare const __OKOLOS_USAGE__: Build | undefined

const STATE_KEY = 'usage:state'

export interface Usage {
  track<E extends EventName>(name: E, props: EventProps<E>): Promise<void>
  flush(): Promise<void>
  /** What the settings switch shows, by the browser's rules and the person's choice. */
  state(): Promise<ConsentState>
  /** From the settings switch, inside the click: Firefox asks only from a user gesture. */
  set(on: boolean): Promise<ConsentState>
  /**
   * After an erase: a new install number and an empty queue, only if collection is on at that
   * moment. One step, so a switch-off that lands first is never undone by it.
   */
  renew(): Promise<ConsentState>
}

/**
 * The worker's usage and error events: one sink, its state in `storage.local`, sent through the
 * audited network path. A Firefox that took the grant back makes the stored switch off at once,
 * so its install id and queue go with it.
 */

/** The outbound log is opened per send within this, or the send counts as a failed audit write. */
const AUDIT_OPEN_MS = 5_000
export function startUsage(
  platform: Platform,
  audit: () => Promise<RequestDeps>,
  permissions: ConsentApi = platform.dataConsent,
  build: Build = typeof __OKOLOS_USAGE__ === 'undefined' ? { appKey: null, environment: 'sandbox' } : __OKOLOS_USAGE__,
): Usage {

  const sink = (allowed: ConsentState | 'unreadable') =>
    createUsageSink({
      load: () => platform.storage.get<UsageState>(STATE_KEY),
      save: (state) => platform.storage.set(STATE_KEY, state),
      send: async (spec) => {
        // The audit is opened per send, as every other caller does: a handle kept for the
        // worker's life would write to a connection a reset or the browser closed. One that
        // cannot be opened is an audit write that failed: nothing left, so the event is kept.
        // Opened within 5 s too: an open with no deadline of its own would hold the flush, and the
        // switch behind it, past the page's RPC deadline (B-214).
        let deps: RequestDeps
        try {
          // i18n-exempt: a failure the sink reads to keep the event; never shown to anyone
          deps = await withDeadline(audit(), AUDIT_OPEN_MS, 'the outbound log did not open in time')
        } catch (cause) {
          throw new AuditWriteError(cause)
        }
        return usageSender(deps)(spec)
      },
      now: () => Date.now(),
      randomId: () => crypto.randomUUID(),
      sessionId: (iid, at) => sessionFor(at, iid),
      // Nothing leaves while the browser's answer is unknown, and nothing stored is touched.
      appKey: allowed === 'unsupported' || allowed === 'unreadable' ? null : build.appKey,
      environment: build.environment,
      initialConsent: allowed === 'on' ? 'on' : 'off',
      extensionVersion: platform.runtime.version(),
      locale: globalThis.navigator?.language ?? '',
    })

  // Firefox: the browser keeps the choice. A grant taken back drops the stored "on" with its
  // install id; a grant given again (in about:addons) turns it back on with a new one.
  const current = async () => {
    let allowed: ConsentState | 'unreadable'
    try {
      allowed = await browserConsent(platform.kind, permissions)
    } catch (cause) {
      if (!(cause instanceof ConsentUnreadable)) throw cause
      // A failed read is not a grant taken back: keep the stored state, send nothing (B-215).
      return { allowed: 'unreadable' as const, s: sink('unreadable') }
    }
    const s = sink(allowed)
    const stored = await s.consent()
    if (allowed !== 'on' && stored === 'on') await s.setConsent(false)
    if (allowed === 'on' && stored === 'off' && platform.kind === 'firefox') await s.setConsent(true)
    return { allowed, s }
  }

  // Every change to the stored state, one at a time. Each step reads, awaits and writes the
  // whole state, and the worker can run several at once (a message, the alarm, the switch): two
  // events at once kept one, and a switch-off between an event's read and its write brought the
  // old install id back.
  let chain: Promise<unknown> = Promise.resolve()
  const serial = <T>(step: () => Promise<T>): Promise<T> => {
    const run = chain.then(step, step)
    chain = run.catch(() => undefined)
    return run
  }

  return {
    // An event that cannot be recorded goes missing; it never becomes a rejection in the worker.
    track: (name, props) =>
      serial(async () => {
        const { s } = await current()
        await s.track(name, props)
      }).then(
        () => undefined,
        () => undefined,
      ),
    flush: () =>
      serial(async () => {
        const { s } = await current()
        await s.flush()
      }).then(
        () => undefined,
        () => undefined,
      ),
    state: () =>
      serial(async () => {
        const { allowed, s } = await current()
        // Unreadable: the person's stored choice, which nothing changed.
        return allowed === 'unsupported' ? 'unsupported' : await s.consent()
      }),
    // Chrome: the switch is the consent. Firefox: the page already asked the browser inside the
    // click (a worker has no user gesture), so the worker reads its answer once, inside the step,
    // and an "on" Firefox did not grant stays off.
    set: (on) =>
      serial(async () => {
        const { allowed, s } = await current()
        // i18n-exempt: the RPC refusal the page turns into usageSaveFailed; never shown as is
        if (allowed === 'unreadable') throw new Error('the browser data consent could not be read; the switch was not saved')
        if (allowed === 'unsupported') return 'unsupported'
        const next = on && allowed === 'on'
        await s.setConsent(next)
        return next ? 'on' : 'off'
      }),
    renew: () =>
      serial(async () => {
        const { allowed, s } = await current()
        // i18n-exempt: the RPC refusal the page turns into usageRenewFailed; never shown as is
        if (allowed === 'unreadable') throw new Error('the browser data consent could not be read; the install number was not replaced')
        if (allowed === 'unsupported') return 'unsupported'
        if ((await s.consent()) !== 'on') return 'off'
        await s.setConsent(true)
        return 'on'
      }),
  }
}
