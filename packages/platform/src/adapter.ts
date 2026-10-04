import { isEnvelope, type Envelope, type RpcMap, type RpcType } from '@okolos/contracts'

import type {
  Platform,
  RpcHandler,
  RpcSender,
  WebExtensionApi,
} from './types.js'

/**
 * Strips a URL down to origin and path.
 *
 * Query strings and fragments carry session tokens and reset links. They are
 * removed here, at the boundary, rather than trusted to be removed by every
 * caller downstream — a rule enforced in one place is a rule.
 */
export function toSafeUrl(raw: string | undefined): string | null {
  if (!raw) return null
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return `${url.origin}${url.pathname}`
  } catch {
    return null
  }
}

/**
 * Both browsers are built from the same adapter: the differences that matter
 * to this product (worker vs page, offscreen vs direct inference) live in the
 * extension composition, not in these calls.
 */
/**
 * How long any single RPC may take before it is called a failure.
 *
 * Deliberately generous: the slowest legitimate call is a leak check, whose
 * sources each get ten seconds of their own. A deadline shorter than the work
 * would turn a slow answer into a wrong one.
 */
export const RPC_TIMEOUT_MS = 30_000

/**
 * Rejects with `message` if `work` has not settled in time.
 *
 * Exported because it existed twice: here, for a message to a service worker that may never
 * answer, and in `background/leaks.ts`, for a source that may never reply. Two copies of the
 * same fifteen lines, each with its own comment explaining the same `clearTimeout` — and
 * they had already drifted, one testing the handle with `!== undefined` and the other for
 * truthiness. This is the third pair of copies swept in one session (the instant formatters,
 * the severity table), and it is the one that decides *behaviour under failure*, which is
 * the worst place for two answers to live.
 */
export async function withDeadline<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms)
      }),
    ])
  } finally {
    // Without this the page is held awake by a pending timer for every call
    // that answered normally, which on a busy surface is most of them.
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** The envelope the receiver sends instead of a result when it cannot produce one. */
function isErrorAnswer(answer: unknown): answer is { error: string; detail?: unknown } {
  return (
    typeof answer === 'object' &&
    answer !== null &&
    'error' in answer &&
    typeof (answer as { error: unknown }).error === 'string'
  )
}

export function createPlatform(kind: Platform['kind'], api: WebExtensionApi): Platform {
  // Resolved lazily and cached: `getSelf` is async, and every caller of
  // `selfId` is on a path that must not await for it.
  let selfExtensionId = ''
  void api.management?.getSelf().then((self) => {
    selfExtensionId = self.id
  })

  return {
    kind,

    storage: {
      async get<T>(key: string): Promise<T | undefined> {
        const result = await api.storage.local.get(key)
        return result[key] as T | undefined
      },
      async set(key: string, value: unknown): Promise<void> {
        await api.storage.local.set({ [key]: value })
      },
      async remove(key: string): Promise<void> {
        await api.storage.local.remove(key)
      },
    },

    alarms: {
      /**
       * Creates the alarm only when it is missing or its period changed (LC-08).
       *
       * `alarms.create` replaces an alarm of the same name, and the background asks
       * for its alarms on every wake-up — so an unconditional create reset every
       * timer each time a page messaged the worker, and the daily inventory alarm
       * on a browser in daily use never fired. Asking first keeps the countdown.
       * A browser that cannot answer `get` still gets the alarm: a reset timer is
       * the old cost, a missing one would be a schedule that never runs.
       */
      async create(name: string, periodInMinutes: number): Promise<void> {
        const existing = await api.alarms.get?.(name).catch(() => undefined)
        if (existing && existing.periodInMinutes === periodInMinutes) return
        api.alarms.create(name, { periodInMinutes })
      },
      onFired(handler: (name: string) => void): void {
        api.alarms.onAlarm.addListener((alarm) => {
          handler(alarm.name)
        })
      },
    },

    message: (key, substitutions = []) =>
      api.i18n?.getMessage?.(key, [...substitutions]) ?? `[${key}]`,
    runtime: {
      async send<T extends RpcType>(type: T, payload: RpcMap[T]['req']): Promise<RpcMap[T]['res']> {
        const envelope: Envelope<T> = { v: 1, type, payload }
        // A message to a service worker that is starting, evicted or already
        // gone can be dropped without ever settling this promise, and every
        // caller above treats an unsettled call as work still in progress —
        // which is a spinner with no end and no way out. The same reasoning
        // gave leak sources a deadline; the message itself needs one too.
        const answer = await withDeadline(
          api.runtime.sendMessage(envelope),
          RPC_TIMEOUT_MS,
          `the background service did not answer "${type}" within ${Math.round(
            RPC_TIMEOUT_MS / 1000,
          )} seconds`,
        )

        /**
         * An error answer is a failure, not a result — and it used to be handed back
         * as one.
         *
         * The receiver answers `{ v: 1, error: 'failed', detail }` when a handler
         * throws and `{ v: 1, error: 'unsupported' }` for a type it does not know.
         * Both were returned to the caller as if they were the response, and the
         * caller read the field it wanted off them: `response?.verdicts ?? []` in the
         * page scan turned a **failed scan into a clean page**. Nothing was logged,
         * because nothing threw. Found by reading a CI trace whose console held eight
         * preload warnings and not one line from this product (B-74).
         *
         * Rejecting here means every caller's existing `catch` covers it, which is
         * where the decision belongs: the scan journals a give-up, a notification
         * shrugs, and neither has to know the envelope's shape.
         */
        if (isErrorAnswer(answer)) {
          throw new Error(
            // i18n-exempt: the caller's `catch` decides what a reader sees; since B-115 a
            // journalled failure carries this text as `diagnostic` beside a catalogue
            // sentence rather than interpolated into one
            `the background service refused "${type}": ${answer.error}` +
              (typeof answer.detail === 'string' && answer.detail !== ''
                ? ` — ${answer.detail}`
                : ''),
          )
        }
        return answer as RpcMap[T]['res']
      },
      onInstalled(handler: () => void): void {
        api.runtime.onInstalled.addListener((details) => {
          if (details.reason === 'install') handler()
        })
      },

      onBrowserStart(handler: () => void): void {
        // Browser start, install, update and browser update: the only moments the
        // installed rules can differ from what the stored feed says. A plain worker
        // wake-up is not one of them, and rebuilding on every wake was LC-08's cost.
        api.runtime.onStartup?.addListener(() => handler())
        api.runtime.onInstalled.addListener(() => handler())
      },

      getUrl(path: string): string {
        return api.runtime.getURL(path)
      },

      async openOptionsPage(): Promise<void> {
        await api.runtime.openOptionsPage?.()
      },

      onMessage(handler: RpcHandler): void {
        api.runtime.onMessage.addListener((message, sender, sendResponse) => {
          // An unknown type or a future version is answered and survived. A
          // receiver that throws here turns a version skew into a broken page.
          if (!isEnvelope(message)) {
            sendResponse({ v: 1, error: 'unsupported' })
            return true
          }

          /**
           * The sender, narrowed to three facts and no more.
           *
           * It used to be discarded, and that is why a finding inside an iframe had
           * nowhere to go: the background answered whoever asked without being able
           * to tell a frame from a page. `origin` is derived from the url rather
           * than taken from `sender.origin`, which only Chrome sets — and derived
           * to an origin rather than kept whole, because the frame's path is not
           * ours to hold.
           */
          const origin = ((): string | undefined => {
            try {
              return sender.url ? new URL(sender.url).origin : undefined
            } catch {
              return undefined
            }
          })()
          const from: RpcSender = {
            ...(typeof sender.tab?.id === 'number' ? { tabId: sender.tab.id } : {}),
            ...(typeof sender.frameId === 'number' ? { frameId: sender.frameId } : {}),
            ...(origin ? { origin } : {}),
          }

          const result = handler(message, from)
          if (!result) {
            sendResponse({ v: 1, error: 'unsupported' })
            return true
          }

          result.then(sendResponse, (cause: unknown) => {
            sendResponse({ v: 1, error: 'failed', detail: String(cause) })
          })
          return true
        })
      },
    },

    extensions: {
      available: () => Boolean(api.management),

      async list() {
        const all = (await api.management?.getAll()) ?? []
        return all.map((entry) => ({
          id: entry.id,
          name: entry.name,
          version: entry.version,
          permissions: entry.permissions ?? [],
          hostPermissions: entry.hostPermissions ?? [],
          // The store does not expose an author field, so the update URL is
          // the closest thing to "who ships this" the browser will tell us —
          // and a change of it is exactly the event worth reporting.
          //
          // `installType` used to stand in for it when there was no update URL, which
          // conflated two different facts: a sideloaded extension's "publisher" was the
          // word `sideload`, and moving from the store to a sideload read as a change of
          // publisher rather than as what it is. It is its own field now (B-56).
          publisher: entry.updateUrl ?? null,
          // Spread, not `installType: undefined`: `exactOptionalPropertyTypes` refuses
          // that, and it would mean "present and unknown" where the field means absent.
          ...(entry.installType === undefined ? {} : { installType: entry.installType }),
          enabled: entry.enabled,
        }))
      },

      async disable(id: string): Promise<void> {
        await api.management?.setEnabled(id, false)
      },

      selfId: () => selfExtensionId,
    },

    downloads: {
      available: () => Boolean(api.downloads),

      onCreated(handler): void {
        api.downloads?.onCreated.addListener((item) => {
          handler({
            id: item.id,
            url: item.url,
            // Both addresses travel: the link the page carried and where it landed.
            // A short link to a malicious host is innocent at the first and not at
            // the second, and the check used to see only the first (B-57).
            ...(item.finalUrl !== undefined && item.finalUrl !== item.url
              ? { finalUrl: item.finalUrl }
              : {}),
            filename: (item.filename ?? '').split(/[\\/]/).pop() ?? '',
            mime: item.mime ?? null,
          })
        })
      },

      async cancel(id: number): Promise<void> {
        await api.downloads?.cancel(id)
      },
    },

    blocking: {
      async replaceRules(rules: readonly unknown[]): Promise<void> {
        const dnr = api.declarativeNetRequest
        if (!dnr) return

        // Every rule replaced at once, never patched. A partial update leaves
        // rules from a feed version nobody can name any more.
        const existing = await dnr.getDynamicRules()
        await dnr.updateDynamicRules({
          removeRuleIds: existing.map((rule) => rule.id),
          addRules: [...rules],
        })
      },

      async ruleCount(): Promise<number> {
        const dnr = api.declarativeNetRequest
        if (!dnr) return 0
        return (await dnr.getDynamicRules()).length
      },

      onBlocked(handler: (url: string) => void): void {
        // The navigation that is about to be redirected is the only place the
        // original URL is still visible: after the redirect the tab shows our
        // own page and the target is gone.
        //
        // Filtered to web pages, because the filter decides what wakes the worker
        // (LC-08) and the rules only ever match http(s) main frames. It cannot be
        // narrowed to the feed's hosts: a filter built from the stored feed would
        // be registered after an asynchronous read, and a listener registered late
        // misses the very event that woke the worker. Nor can the redirect carry
        // the URL instead — the interstitial refuses its own query string so the
        // warned-about address stays out of history (interstitial/index.ts). The
        // handler is therefore kept to a memory write; the feed is read only when
        // the interstitial asks.
        api.webNavigation?.onBeforeNavigate.addListener(
          (details) => {
            if (details.frameId !== 0) return
            handler(details.url)
          },
          { url: [{ schemes: ['http', 'https'] }] },
        )
      },
    },

    inference: {
      /**
       * Where a classifier could run — and on Chrome the answer is nowhere, by decision.
       *
       * This used to create an offscreen document and return `'offscreen'`, which made
       * `prepare()` report `ready`, which opened the third stage's gate, which sent every
       * unresolved candidate on a round trip that came back `null` because there are no
       * weights and there will not be. A document per worker wake-up, a permission in the
       * store listing, and a status claiming a classifier that cannot answer (B-50).
       *
       * The third stage is **not shipped** — measured 2026-08-08 and recorded in REQ-37:
       * nine false positives out of thirty-four at 0.97–1.00 confidence, on screen-reader
       * labels in both languages, while the first stage's rules give 100% recall with none
       * on the same corpus. So the offscreen document, the `offscreen` permission and the
       * page that hosted it are gone with it, and this says `none` rather than building
       * scaffolding for something that will not run.
       *
       * Firefox keeps `'background'`: its background context is a page with a DOM, so
       * there is nothing to create and nothing to ask for. If the model ever ships, this
       * is the one function that changes.
       */
      async ensureHost(): Promise<'offscreen' | 'background' | 'none'> {
        return kind === 'firefox' ? 'background' : 'none'
      },
    },

    tabs: {
      async activeUrl(): Promise<string | null> {
        const [tab] = await api.tabs.query({ active: true, currentWindow: true })
        return toSafeUrl(tab?.url)
      },

      async create(url: string): Promise<void> {
        await api.tabs.create({ url })
      },

      async mark(tabId: number, text: string, title: string): Promise<boolean> {
        /**
         * The one surface a page cannot reach.
         *
         * Everything else this product draws lives inside the page, so a page that
         * deletes our host from the document takes all of it at once — measured, and
         * the last open item in ADR-0001. The icon is outside; the badge needs no
         * permission beyond the `action` key the popup already requires.
         *
         * Per tab, not global: "something is wrong" is a fact about the page in front
         * of the user, and a global badge would still be there on the next site.
         */
        const action = api.action
        if (!action) return false
        try {
          await action.setBadgeText({ text, tabId })
          // Colour is best-effort on its own: Firefox has it, and a browser that does
          // not must still get the text rather than nothing.
          await action.setBadgeBackgroundColor?.({ color: '#b3261e', tabId })
          await action.setTitle({ title, tabId })
          return true
        } catch {
          // The tab closed between the finding and the mark. Nobody to tell.
          return false
        }
      },

      async sendToFrame<T extends RpcType>(
        type: T,
        payload: RpcMap[T]['req'],
        to: { tabId: number; frameId: number },
      ): Promise<boolean> {
        /**
         * Addressed, not guessed. A finding inside an iframe belongs on the page
         * that embeds it, and that page is named by the sender rather than by
         * whichever window happens to be focused when the verdict comes back.
         *
         * Type first and destination last, matching `sendToActive` — the first
         * version took `(tabId, frameId, type, payload)` and `tools/test-quality`
         * could not find the sender for `frame/finding` at all, because every rule
         * about who sends what reads the type from the first argument. An API whose
         * argument order defeats the project's own gate is the wrong argument order.
         */
        if (!api.tabs.sendMessage) return false
        const envelope: Envelope<T> = { v: 1, type, payload }
        try {
          await api.tabs.sendMessage(to.tabId, envelope, { frameId: to.frameId })
          return true
        } catch {
          // The frame navigated, the tab closed, or nothing is listening there.
          // "Nobody to tell" is not an error for the caller to handle.
          return false
        }
      },

      async sendToActive<T extends RpcType>(type: T, payload: RpcMap[T]['req']): Promise<boolean> {
        /**
         * The active tab, because that is the page the person is looking at.
         *
         * A download carries no tab: `DownloadItem` has a `referrer` and no id, so
         * there is nothing to address but the tab in front of the user — which is
         * also the tab a download almost always starts from. The cases that miss
         * are named in the caller and in SCN-012's known limit rather than papered
         * over: a download begun in a background tab, or from a bookmark, or in a
         * tab that has since navigated away.
         *
         * No deadline wrapper here, unlike `runtime.send`. That one waits for the
         * background service to answer and a caller upstream is showing a spinner;
         * this one is a notification whose only failure mode is "nobody was
         * listening", and `sendMessage` to a tab without a content script rejects
         * promptly on its own.
         */
        if (!api.tabs.sendMessage) return false
        const [tab] = await api.tabs.query({ active: true, currentWindow: true })
        if (typeof tab?.id !== 'number') return false

        const envelope: Envelope<T> = { v: 1, type, payload }
        try {
          await api.tabs.sendMessage(tab.id, envelope)
          return true
        } catch {
          // A tab with no content script — an extension page, a PDF viewer, a
          // `chrome://` page — rejects. That is "no page to tell", not an error
          // worth propagating into a download handler.
          return false
        }
      },
    },
  }
}
