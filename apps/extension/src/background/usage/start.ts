import type { RequestDeps } from '@okolos/net'
import type { Platform } from '@okolos/platform'

import type { EventName, EventProps } from './catalogue.js'
import { browserConsent, switchConsent, type ConsentApi, type ConsentState } from './consent.js'
import { usageSender } from './send.js'
import { createUsageSink, type UsageState } from './sink.js'
import { sessionIdAt } from './system.js'

/**
 * Set by the build. The store build made by `pnpm package` carries the App-Key and
 * `production`; every other build carries no key and `sandbox`, and a build with no key sends
 * nothing (client contract «Build modes»).
 */
declare const __OKOLOS_USAGE__: { appKey: string | null; environment: 'production' | 'sandbox' } | undefined

const STATE_KEY = 'usage:state'

export interface Usage {
  track<E extends EventName>(name: E, props: EventProps<E>): Promise<void>
  flush(): Promise<void>
  /** What the settings switch shows, by the browser's rules and the person's choice. */
  state(): Promise<ConsentState>
  /** From the settings switch, inside the click: Firefox asks only from a user gesture. */
  set(on: boolean): Promise<ConsentState>
}

/**
 * The worker's usage and error events: one sink, its state in `storage.local`, sent through the
 * audited network path. A Firefox that took the grant back makes the stored switch off at once,
 * so its install id and queue go with it.
 */
export function startUsage(platform: Platform, audit: () => Promise<RequestDeps>, permissions: ConsentApi = platform.dataConsent): Usage {
  const build = typeof __OKOLOS_USAGE__ === 'undefined' ? { appKey: null, environment: 'sandbox' as const } : __OKOLOS_USAGE__
  const suffix = Math.floor(Math.random() * 100_000_000)
  let send: ((spec: { url: string; body: string; headers: Record<string, string> }) => Promise<Response>) | null = null

  const sink = (allowed: ConsentState) =>
    createUsageSink({
      load: () => platform.storage.get<UsageState>(STATE_KEY),
      save: (state) => platform.storage.set(STATE_KEY, state),
      send: async (spec) => {
        send ??= usageSender(await audit())
        return send(spec)
      },
      now: () => Date.now(),
      randomId: () => crypto.randomUUID(),
      sessionId: () => sessionIdAt(Date.now(), suffix),
      appKey: allowed === 'unsupported' ? null : build.appKey,
      environment: build.environment,
      initialConsent: allowed === 'on' ? 'on' : 'off',
      extensionVersion: platform.runtime.version(),
      locale: globalThis.navigator?.language ?? '',
    })

  const current = async () => {
    const allowed = await browserConsent(platform.kind, permissions)
    const s = sink(allowed)
    if (allowed !== 'on' && (await s.consent()) === 'on') await s.setConsent(false)
    return { allowed, s }
  }

  return {
    async track(name, props) {
      const { s } = await current()
      await s.track(name, props).catch(() => false)
    },
    async flush() {
      const { s } = await current()
      await s.flush().catch(() => undefined)
    },
    async state() {
      const { allowed, s } = await current()
      return allowed === 'unsupported' ? 'unsupported' : await s.consent()
    },
    async set(on) {
      // Chrome: the switch is the consent. Firefox: the page already asked the browser inside
      // the click (a worker has no user gesture), so the worker only reads its answer, and an
      // "on" Firefox did not grant stays off.
      const answer = platform.kind === 'chrome' ? await switchConsent('chrome', permissions, on) : await browserConsent('firefox', permissions)
      if (answer === 'unsupported') return 'unsupported'
      const { s } = await current()
      const next = on && answer === 'on'
      await s.setConsent(next)
      return next ? 'on' : 'off'
    },
  }
}
