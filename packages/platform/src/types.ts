import type { Envelope, RpcMap, RpcType } from '@okolos/contracts'

/**
 * The surface the rest of the product is allowed to see.
 *
 * Everything that differs between Chrome and Firefox is absorbed here: Chrome
 * runs a service worker with no DOM and needs an offscreen document to run
 * inference, Firefox keeps a background page and a blocking webRequest. A
 * detector that knew any of that would have to be rewritten per browser; one
 * that takes candidates and returns verdicts does not.
 */
export interface Platform {
  readonly kind: 'chrome' | 'firefox'
  readonly storage: KeyValueStore
  readonly alarms: Alarms
  readonly runtime: Runtime
  readonly tabs: Tabs
  readonly inference: Inference
  readonly blocking: Blocking
  readonly downloads: Downloads
  readonly extensions: Extensions
  /**
   * Resolves a message key against the browser's own catalogue.
   *
   * Here rather than in `@okolos/i18n` because this is the one place allowed to
   * name a browser API. The renderers ask `@okolos/i18n`; the entry point wires
   * the two together on the first line it runs.
   */
  readonly message: (key: string, substitutions?: readonly string[]) => string
}

/** The other extensions installed, and the ability to turn one off. */
export interface Extensions {
  available(): boolean
  list(): Promise<
    ReadonlyArray<{
      id: string
      name: string
      version: string
      permissions: readonly string[]
      hostPermissions: readonly string[]
      publisher: string | null
      /**
       * How it got onto the machine: `normal` is the store, and everything else is not.
       *
       * Optional because a browser without `management` reports nothing, and "we could
       * not tell" is not "it came from the store" — which is the whole point of the
       * signal (B-56).
       */
      installType?: string
      enabled: boolean
    }>
  >
  disable(id: string): Promise<void>
  selfId(): string
}

/** Downloads, where the only moment to intervene is before the bytes land. */
export interface Downloads {
  /** Fires as an item is created, before it is written. */
  onCreated(
    handler: (item: {
      id: number
      url: string
      finalUrl?: string
      filename: string
      mime: string | null
    }) => void,
  ): void
  cancel(id: number): Promise<void>
  /** True when this browser exposes the API at all. */
  available(): boolean
}

/** Network-level blocking, which is the only kind that happens before render. */
export interface Blocking {
  /** Replaces every rule this extension owns. Partial updates drift. */
  replaceRules(rules: readonly unknown[]): Promise<void>
  /** How many rules are installed now — a count, without rebuilding anything. */
  ruleCount(): Promise<number>
  /**
   * Fires with the URL of each top-level web navigation — the one about to be
   * redirected to our interstitial among them. Kept cheap: it runs on navigations
   * that are not blocked too.
   */
  onBlocked(handler: (url: string) => void): void
}

export interface KeyValueStore {
  get<T>(key: string): Promise<T | undefined>
  set(key: string, value: unknown): Promise<void>
  remove(key: string): Promise<void>
}

export interface Alarms {
  /** Ensures the alarm exists with this period; a running one keeps its countdown. */
  create(name: string, periodInMinutes: number): Promise<void>
  onFired(handler: (name: string) => void): void
}

/**
 * Who sent a message, in the only three facts a handler here has a use for.
 *
 * The adapter dropped the sender entirely, which is why a finding inside an
 * iframe had nowhere to go: the background answered the frame that asked and had
 * no way to know it was a frame, which tab it belonged to, or what to call it. The
 * content script's own comment promised "subframes still collect and report; the
 * top frame is the one that speaks", and the reporting half did not exist.
 *
 * Origin rather than the full url, and derived rather than trusted: the frame's
 * address is not ours to log, and naming where a finding was is the whole point of
 * telling the top frame at all.
 */
export interface RpcSender {
  /** Absent when the message came from an extension page rather than a tab. */
  readonly tabId?: number
  /** `0` is the top frame. Anything above it is an embedded one. */
  readonly frameId?: number
  /** Origin only — no path, no query. Absent when it cannot be parsed. */
  readonly origin?: string
}

export type RpcHandler = <T extends RpcType>(
  message: Envelope<T>,
  sender: RpcSender,
) => Promise<RpcMap[T]['res']> | undefined

export interface Runtime {
  send<T extends RpcType>(type: T, payload: RpcMap[T]['req']): Promise<RpcMap[T]['res']>
  onMessage(handler: RpcHandler): void
  /** Fires once, on a fresh install — not on updates or browser restarts. */
  onInstalled(handler: () => void): void
  /** Fires on browser start and on every install reason (install, update, browser update). */
  onBrowserStart(handler: () => void): void
  /** Absolute URL of a file inside the extension package. */
  getUrl(path: string): string
  openOptionsPage(): Promise<void>
}

/** Where a model is allowed to run in this browser. */
export type InferenceHostKind = 'offscreen' | 'background' | 'none'

export interface Inference {
  /**
   * Makes sure a context exists that can run a model, and says which one it is.
   *
   * Chrome's service worker has no DOM and no WebGPU, so inference needs an
   * offscreen document; Firefox keeps a background page and can run it there.
   * `none` is a real answer — a browser that offers neither must be told apart
   * from one where the model simply has not been fetched yet.
   */
  ensureHost(): Promise<InferenceHostKind>
}

export interface Tabs {
  /** Origin and path only — the same rule the collector obeys. */
  activeUrl(): Promise<string | null>

  /**
   * Marks one tab's own icon — a surface the page cannot reach.
   *
   * Needed because everything else this product draws lives *inside* the page, and a
   * page that deletes our host from the document takes all of it away at once
   * (ADR-0001, B-68). The badge needs no permission the manifest does not already
   * have: `action` is declared for the popup.
   *
   * Best effort by design: a tab that has closed, or a browser without the API, is
   * "nobody to tell" rather than an error for the caller to handle.
   */
  mark(tabId: number, text: string, title: string): Promise<boolean>
  create(url: string): Promise<void>
  /**
   * Delivers a message to the content script in the tab the user is looking at,
   * and reports whether it arrived.
   *
   * Separate from `runtime.send` because they reach different places, and that
   * difference cost a whole feature: a background context's `runtime.sendMessage`
   * reaches the extension's own pages and never a content script. The download
   * verdict went out that way, the listener sat in `content/index.ts`, and no
   * banner ever appeared — a module with nine tests, unreachable at runtime.
   *
   * Returns `false` rather than throwing when there is nowhere to deliver: a
   * download begun from a bookmark has no page, and neither has one begun in a
   * tab that has since navigated. The caller decides what to do about that; what
   * it must not do is assume the message landed.
   */
  sendToActive<T extends RpcType>(type: T, payload: RpcMap[T]['req']): Promise<boolean>
  /**
   * Delivers to one frame of one tab, addressed rather than guessed.
   *
   * `sendToActive` finds the tab the user is looking at, which is right for a
   * download and wrong for this: a finding inside an iframe belongs on the page
   * that embeds it, and that page is identified by the sender, not by which window
   * happens to be focused when the verdict comes back.
   */
  sendToFrame<T extends RpcType>(
    type: T,
    payload: RpcMap[T]['req'],
    to: { tabId: number; frameId: number },
  ): Promise<boolean>
}

/** The subset of the WebExtension API both browsers actually agree on. */
export interface WebExtensionApi {
  /**
   * Optional because a test double has no reason to carry it, and because a
   * page loaded outside an extension context has none either — in both cases
   * the adapter falls back to showing the key, which is what a user would see
   * if a message were missing. Same failure, same appearance, one code path.
   */
  i18n?: { getMessage?(key: string, substitutions?: string[]): string }
  storage: {
    local: {
      get(keys: string | string[] | null): Promise<Record<string, unknown>>
      set(items: Record<string, unknown>): Promise<void>
      remove(keys: string | string[]): Promise<void>
    }
  }
  alarms: {
    create(name: string, info: { periodInMinutes: number }): void
    /** Optional so a test double may omit it; both browsers ship it promise-based. */
    get?(name: string): Promise<{ name: string; periodInMinutes?: number; scheduledTime?: number } | undefined>
    onAlarm: { addListener(cb: (alarm: { name: string }) => void): void }
  }
  runtime: {
    getURL(path: string): string
    openOptionsPage?(): Promise<void> | void
    onInstalled: { addListener(cb: (details: { reason: string }) => void): void }
    onStartup?: { addListener(cb: () => void): void }
    sendMessage(message: unknown): Promise<unknown>
    onMessage: {
      addListener(
        cb: (
          message: unknown,
          // Shaped rather than `unknown`: the adapter has to read three fields out
          // of it, and typing them here is what makes a rename visible instead of
          // silently producing `undefined`. `origin` is Chrome-only, so the adapter
          // derives it from `url` and both are optional.
          sender: { tab?: { id?: number }; frameId?: number; url?: string; origin?: string },
          sendResponse: (response: unknown) => void,
        ) => boolean | void,
      ): void
    }
  }
  tabs: {
    query(info: { active: true; currentWindow: true }): Promise<Array<{ url?: string; id?: number }>>
    create(info: { url: string }): Promise<unknown> | void
    /**
     * The only way a background context reaches a content script.
     *
     * `runtime.sendMessage` from the background goes to the extension's own
     * pages, never to a content script, and the download verdict was sent that
     * way for a while: the listener existed in `content/index.ts` and nothing
     * ever arrived. Optional here because a test double has no reason to carry
     * it, which is also how `Tabs.sendToActive` can honestly answer "no page".
     */
    sendMessage?(
      tabId: number,
      message: unknown,
      options?: { frameId: number },
    ): Promise<unknown>
  }
  /**
   * The extension's own icon. Optional for the same reason `sendMessage` is: a test
   * double has no reason to carry it, and "no icon to mark" is an honest answer.
   */
  action?: {
    setBadgeText(details: { text: string; tabId?: number }): Promise<void> | void
    setBadgeBackgroundColor?(details: { color: string; tabId?: number }): Promise<void> | void
    setTitle(details: { title: string; tabId?: number }): Promise<void> | void
  }
  declarativeNetRequest?: {
    getDynamicRules(): Promise<Array<{ id: number }>>
    updateDynamicRules(update: {
      removeRuleIds?: number[]
      addRules?: unknown[]
    }): Promise<void>
    onRuleMatchedDebug?: {
      addListener(cb: (info: { request: { url: string } }) => void): void
    }
  }
  downloads?: {
    onCreated: {
      addListener(
        cb: (item: {
          id: number
          url: string
          /**
           * Where the download actually came from, after redirects.
           *
           * The matrix promised the reputation check ran on this and the code read
           * `url` — the address the link carried, before any hop. A short link to a
           * malicious host was therefore checked against the short link (B-57).
           * Optional because Firefox's `DownloadItem` has no such field.
           */
          finalUrl?: string
          filename?: string
          mime?: string
        }) => void,
      ): void
    }
    cancel(id: number): Promise<void>
  }
  management?: {
    getAll(): Promise<
      Array<{
        id: string
        name: string
        version: string
        permissions?: string[]
        hostPermissions?: string[]
        installType?: string
        enabled: boolean
        updateUrl?: string
      }>
    >
    setEnabled(id: string, enabled: boolean): Promise<void>
    getSelf(): Promise<{ id: string }>
  }
  webNavigation?: {
    onBeforeNavigate: {
      addListener(
        cb: (details: { url: string; frameId: number }) => void,
        filter?: unknown,
      ): void
    }
  }
  /** Chrome only. Absent in Firefox, which runs the model on its background page. */
  offscreen?: {
    hasDocument(): Promise<boolean>
    createDocument(info: {
      url: string
      reasons: string[]
      justification: string
    }): Promise<void>
  }
}
