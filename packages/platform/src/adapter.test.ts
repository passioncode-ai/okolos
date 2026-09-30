import { describe, expect, it, vi } from 'vitest'
import type { Envelope } from '@okolos/contracts'

import { createPlatform, RPC_TIMEOUT_MS, toSafeUrl, withDeadline } from './adapter.js'
import type { WebExtensionApi } from './types.js'

/**
 * Each section may be stubbed on its own; the rest keeps working. `offscreen`
 * is the exception: it has no base to merge into, so a test that wants one
 * supplies the whole thing.
 */
type OptionalSection =
  | 'offscreen'
  | 'declarativeNetRequest'
  | 'webNavigation'
  | 'downloads'
  | 'management'
  // Supplied whole or not at all, like the others: a half-stubbed icon would let a
  // test assert about a badge while the title call silently did nothing.
  | 'action'
type ApiOverrides = {
  [K in Exclude<keyof WebExtensionApi, OptionalSection>]?: Partial<WebExtensionApi[K]>
} & { [K in OptionalSection]?: WebExtensionApi[K] }

function fakeApi(overrides: ApiOverrides = {}): WebExtensionApi {
  const store: Record<string, unknown> = {}
  const base: WebExtensionApi = {
    storage: {
      local: {
        get: async (key) => (typeof key === 'string' ? { [key]: store[key] } : { ...store }),
        set: async (items) => {
          Object.assign(store, items)
        },
        remove: async (key) => {
          delete store[key as string]
        },
      },
    },
    alarms: { create: vi.fn(), onAlarm: { addListener: vi.fn() } },
    runtime: {
      getURL: (path: string) => `chrome-extension://test/${path}`,
      openOptionsPage: vi.fn(async () => undefined),
      onInstalled: { addListener: vi.fn() },
      sendMessage: vi.fn(async () => ({ ok: true })),
      onMessage: { addListener: vi.fn() },
    },
    tabs: {
      // An id as well as a url: a message to a content script is addressed to a
      // tab, and the fixture that omitted the id was the reason nothing noticed
      // there was no way to address one.
      query: async () => [{ url: 'https://example.test/a/b?token=secret#frag', id: 7 }],
      create: vi.fn(async () => undefined),
      sendMessage: vi.fn(async () => ({ ok: true })),
    },
  }

  // Merged one level deep on purpose. With a flat spread, adding a capability
  // to Platform forced every test that stubs one runtime method to restate all
  // of them — churn that hides what each test actually cares about.
  const {
    offscreen,
    declarativeNetRequest,
    webNavigation,
    downloads,
    management,
    action,
    ...sections
  } = overrides
  return {
    ...base,
    ...sections,
    ...(offscreen ? { offscreen } : {}),
    ...(declarativeNetRequest ? { declarativeNetRequest } : {}),
    ...(webNavigation ? { webNavigation } : {}),
    ...(downloads ? { downloads } : {}),
    ...(management ? { management } : {}),
    ...(action ? { action } : {}),
    runtime: { ...base.runtime, ...overrides.runtime },
    tabs: { ...base.tabs, ...overrides.tabs },
    storage: { ...base.storage, ...overrides.storage },
    alarms: { ...base.alarms, ...overrides.alarms },
  }
}

describe('toSafeUrl', () => {
  it('keeps origin and path and drops query and fragment', () => {
    expect(toSafeUrl('https://bank.test/login?token=abc#x')).toBe('https://bank.test/login')
  })

  it('refuses schemes that are not http(s)', () => {
    expect(toSafeUrl('chrome-extension://abc/page.html')).toBeNull()
    expect(toSafeUrl('javascript:alert(1)')).toBeNull()
  })

  it('returns null instead of throwing on nonsense', () => {
    expect(toSafeUrl('not a url')).toBeNull()
    expect(toSafeUrl(undefined)).toBeNull()
  })
})

describe('one adapter, both browsers', () => {
  for (const kind of ['chrome', 'firefox'] as const) {
    it(`round-trips storage on ${kind}`, async () => {
      const platform = createPlatform(kind, fakeApi())
      await platform.storage.set('quietMode', true)
      expect(await platform.storage.get<boolean>('quietMode')).toBe(true)
      await platform.storage.remove('quietMode')
      expect(await platform.storage.get<boolean>('quietMode')).toBeUndefined()
    })

    it(`strips the query from the active tab url on ${kind}`, async () => {
      const platform = createPlatform(kind, fakeApi())
      expect(await platform.tabs.activeUrl()).toBe('https://example.test/a/b')
    })
  }
})

describe('rpc survives what it does not understand', () => {
  it('answers unsupported for a malformed message instead of throwing', () => {
    // The sender is shaped now, not `unknown`: the adapter reads three fields out
    // of it, and a listener typed loosely here would have hidden the day one of
    // them was renamed.
    type Sender = { tab?: { id?: number }; frameId?: number; url?: string; origin?: string }
    const listeners: Array<(m: unknown, s: Sender, r: (x: unknown) => void) => void> = []
    const api = fakeApi({
      runtime: {
        onMessage: {
          addListener: (cb) => {
            listeners.push(cb)
          },
        },
      },
    })
    const platform = createPlatform('chrome', api)
    platform.runtime.onMessage(() => undefined)

    const answers: unknown[] = []
    listeners[0]?.({ nonsense: true }, {}, (response) => answers.push(response))
    listeners[0]?.({ v: 2, type: 'page/candidates' }, {}, (response) => answers.push(response))

    expect(answers).toEqual([
      { v: 1, error: 'unsupported' },
      { v: 1, error: 'unsupported' },
    ])
  })

  it('wraps an outgoing call in a versioned envelope', async () => {
    const sendMessage = vi.fn(async (_message: unknown) => ({ ok: true }))
    const api = fakeApi({ runtime: { sendMessage } })
    const platform = createPlatform('firefox', api)

    await platform.runtime.send('trust/add', { domain: 'example.test' })

    const sent = sendMessage.mock.calls[0]?.[0] as Envelope<'trust/add'>
    expect(sent).toEqual({ v: 1, type: 'trust/add', payload: { domain: 'example.test' } })
  })
})

describe('install-time wiring goes through the adapter too', () => {
  it('fires the handler only on a fresh install, not on an update', () => {
    // Held in an array: TypeScript narrows a closed-over `let` to `never`
    // once it sees only the assignment inside the callback.
    const listeners: Array<(d: { reason: string }) => void> = []
    const api = fakeApi({
      runtime: {
        onInstalled: {
          addListener: (cb) => {
            listeners.push(cb)
          },
        },
      },
    })
    const platform = createPlatform('firefox', api)
    const onInstall = vi.fn()
    platform.runtime.onInstalled(onInstall)

    listeners[0]?.({ reason: 'update' })
    expect(onInstall).not.toHaveBeenCalled()
    listeners[0]?.({ reason: 'install' })
    expect(onInstall).toHaveBeenCalledOnce()
  })

  it('resolves a packaged file to an extension url', () => {
    const platform = createPlatform('chrome', fakeApi())
    expect(platform.runtime.getUrl('first-run.html')).toBe('chrome-extension://test/first-run.html')
  })
})

describe('where a model may run', () => {
  it('reports no host on Chrome, and creates nothing to find that out', async () => {
    /**
     * This used to create an offscreen document and answer `'offscreen'`, which made
     * `prepare()` report `ready`, which opened the third stage's gate, which sent every
     * unresolved candidate on a round trip that came back `null` (B-50).
     *
     * The third stage is not shipped — measured 2026-08-08, REQ-37: nine false positives
     * of thirty-four at 0.97–1.00 confidence, while the first stage's rules give 100%
     * recall with none. So there is nowhere to run one on Chrome, and saying so costs a
     * document per wake-up and a permission in the store listing less than pretending.
     */
    const created: unknown[] = []
    const platform = createPlatform('chrome', fakeApi({
      offscreen: {
        hasDocument: async () => false,
        createDocument: async (info) => {
          created.push(info)
        },
      },
    }))

    await expect(platform.inference.ensureHost()).resolves.toBe('none')
    expect(created, 'a document was created for a classifier that is not shipped').toEqual([])
  })

  it('runs on the background page in Firefox, which has one', async () => {
    const platform = createPlatform('firefox', fakeApi())
    await expect(platform.inference.ensureHost()).resolves.toBe('background')
  })

  it('says plainly when there is nowhere to run a model at all', async () => {
    // Distinct from "the model has not been fetched": one is a device fact, the
    // other is a state the user can change.
    const platform = createPlatform('chrome', fakeApi())
    await expect(platform.inference.ensureHost()).resolves.toBe('none')
  })
})

describe('blocking before the page renders', () => {
  it('replaces every rule it owns rather than patching', async () => {
    // A partial update leaves rules from a feed version nobody can name.
    const updates: unknown[] = []
    const platform = createPlatform('chrome', fakeApi({
      declarativeNetRequest: {
        getDynamicRules: async () => [{ id: 1 }, { id: 2 }],
        updateDynamicRules: async (update) => {
          updates.push(update)
        },
      },
    }))

    await platform.blocking.replaceRules([{ id: 9 }])
    expect(updates[0]).toMatchObject({ removeRuleIds: [1, 2], addRules: [{ id: 9 }] })
  })

  it('does nothing, quietly, where the browser has no such API', async () => {
    const platform = createPlatform('firefox', fakeApi())
    await expect(platform.blocking.replaceRules([{ id: 1 }])).resolves.toBeUndefined()
  })

  it('reports the URL of a top-level navigation, which is the only place it survives', () => {
    // Held in an object: assigned inside a callback, TypeScript narrows a bare
    // `let` to never and the call below stops type-checking.
    const held: { fire?: (details: { url: string; frameId: number }) => void } = {}
    const platform = createPlatform('chrome', fakeApi({
      webNavigation: {
        onBeforeNavigate: {
          addListener: (cb) => {
            held.fire = cb
          },
        },
      },
    }))

    const seen: string[] = []
    platform.blocking.onBlocked((url) => seen.push(url))
    held.fire?.({ url: 'https://bad.test/login', frameId: 0 })
    expect(seen).toEqual(['https://bad.test/login'])
  })

  it('ignores subframe navigations, which are not the page being blocked', () => {
    const held: { fire?: (details: { url: string; frameId: number }) => void } = {}
    const platform = createPlatform('chrome', fakeApi({
      webNavigation: { onBeforeNavigate: { addListener: (cb) => { held.fire = cb } } },
    }))

    const seen: string[] = []
    platform.blocking.onBlocked((url) => seen.push(url))
    held.fire?.({ url: 'https://ads.test/frame', frameId: 3 })
    expect(seen).toEqual([])
  })
})

describe('downloads', () => {
  it('reports a bare filename, whatever path the browser hands over', () => {
    // Chrome gives a full path; the user only ever sees the last part, and the
    // extension checks are about the name, not the folder.
    const held: { fire?: (item: { id: number; url: string; filename?: string }) => void } = {}
    const platform = createPlatform('chrome', fakeApi({
      downloads: {
        onCreated: { addListener: (cb) => { held.fire = cb } },
        cancel: async () => undefined,
      },
    }))

    const seen: string[] = []
    platform.downloads.onCreated((item) => seen.push(item.filename))
    held.fire?.({ id: 1, url: 'https://x.test/a', filename: '/Users/example/Downloads/setup.exe' })
    expect(seen).toEqual(['setup.exe'])
  })

  it('says when the browser has no downloads API rather than pretending', () => {
    expect(createPlatform('chrome', fakeApi()).downloads.available()).toBe(false)
  })
})

describe('the other extensions', () => {
  it('reports what each one is allowed to do', async () => {
    const platform = createPlatform('chrome', fakeApi({
      management: {
        getAll: async () => [
          {
            id: 'abc',
            name: 'Colour Picker',
            version: '1.0.0',
            permissions: ['storage'],
            hostPermissions: ['<all_urls>'],
            enabled: true,
            updateUrl: 'https://clients2.google.com/service/update2/crx',
          },
        ],
        setEnabled: async () => undefined,
        getSelf: async () => ({ id: 'self' }),
      },
    }))

    const [entry] = await platform.extensions.list()
    expect(entry).toMatchObject({ id: 'abc', hostPermissions: ['<all_urls>'] })
    expect(entry?.publisher).toContain('clients2.google.com')
  })

  it('says plainly when the browser will not tell it', () => {
    expect(createPlatform('chrome', fakeApi()).extensions.available()).toBe(false)
  })
})

describe('a message that is never answered', () => {
  /**
   * An MV3 service worker can be starting, evicted, or already gone when a
   * message arrives, and the call is then dropped without settling. Every
   * caller treats an unsettled call as work in progress, so the surface shows
   * a spinner forever — the leak panel did exactly that, roughly one run in
   * six, and it was read as a test flake for three days.
   */
  it('becomes a stated failure rather than a promise that never settles', async () => {
    vi.useFakeTimers()
    try {
      const platform = createPlatform(
        'chrome',
        fakeApi({ runtime: { sendMessage: () => new Promise(() => {}) } }),
      )

      const call = platform.runtime.send('leaks/check', { address: 'someone@example.test' })
      const settled = vi.fn()
      void call.then(settled, settled)

      await vi.advanceTimersByTimeAsync(RPC_TIMEOUT_MS - 1)
      expect(settled, 'gave up before the deadline').not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(2)
      await expect(call).rejects.toThrow(/did not answer "leaks\/check"/)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not hold a timer open for a call that answered', async () => {
    // One stray timer per call keeps the page awake and, in a service worker,
    // postpones the very eviction the deadline exists to survive.
    vi.useFakeTimers()
    try {
      const platform = createPlatform(
        'chrome',
        fakeApi({ runtime: { sendMessage: async () => ({ ok: true }) } }),
      )

      await platform.runtime.send('leaks/check', { address: 'someone@example.test' })
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

/** The shape the download handler actually sends, so the envelope test is about the envelope. */
const DOWNLOAD_VERDICT = {
  // Codes for the headline and the shape, words for the reasons: the split the
  // contract draws, because the words for a code belong to the surface (B-75).
  action: 'warn' as const,
  headline: 'passed-what-ran',
  shape: [{ code: 'double-extension', filename: 'invoice.pdf.exe' }],
  reasons: 'listed by URLhaus on 2026-08-04',
  skipped: 'hash: the file has not been written yet',
}

describe('reaching the content script', () => {
  /**
   * `runtime.sendMessage` from a background context reaches the extension's own
   * pages and never a content script. The download verdict was sent that way, the
   * listener sat in `content/index.ts`, and no banner ever appeared — a module
   * with nine tests that could not run in the product. These check the channel
   * that does reach it, and that it answers honestly when there is nothing to
   * reach.
   */
  it('addresses the active tab and carries the same envelope as runtime.send', async () => {
    const sendMessage = vi.fn(async () => ({ ok: true }))
    const api = fakeApi({ tabs: { sendMessage } })
    const platform = createPlatform('chrome', api)

    await expect(platform.tabs.sendToActive('download/verdict', DOWNLOAD_VERDICT)).resolves.toBe(
      true,
    )
    expect(sendMessage).toHaveBeenCalledWith(7, {
      v: 1,
      type: 'download/verdict',
      payload: DOWNLOAD_VERDICT,
    })
  })

  it('says no rather than throwing when the tab has no content script', async () => {
    // An extension page, a PDF viewer, a `chrome://` page: `sendMessage` rejects.
    // A download handler deciding whether to cancel has no use for an exception
    // about a banner, and treating a rejection as success is how the caller would
    // have gone on believing the user was told.
    const api = fakeApi({
      tabs: {
        sendMessage: vi.fn(async () => {
          throw new Error('Could not establish connection')
        }),
      },
    })
    await expect(
      createPlatform('chrome', api).tabs.sendToActive('download/verdict', DOWNLOAD_VERDICT),
    ).resolves.toBe(false)
  })

  it('says no when there is no active tab to address', async () => {
    const api = fakeApi({ tabs: { query: async () => [] } })
    await expect(
      createPlatform('chrome', api).tabs.sendToActive('download/verdict', DOWNLOAD_VERDICT),
    ).resolves.toBe(false)
  })

  it('says no when the tab has no id, rather than addressing undefined', async () => {
    const api = fakeApi({
      tabs: { query: async () => [{ url: 'https://example.test/' }] },
    })
    await expect(
      createPlatform('chrome', api).tabs.sendToActive('download/verdict', DOWNLOAD_VERDICT),
    ).resolves.toBe(false)
  })

  it('says no without asking for a tab, on an engine that cannot message one', async () => {
    /**
     * Declared optional in `WebExtensionApi`, so this is the shape a test double
     * has — and it must answer "no page" rather than crashing the caller.
     *
     * The `query` assertion is the point, and it exists because a plant found the
     * first version proving nothing: without the early return the call reaches
     * `sendMessage(undefined)`, the inner `catch` turns the TypeError into `false`,
     * and the test passed either way. A guard whose removal changes nothing
     * observable is not a guard, so the observable thing is asserted — no tab is
     * looked up on an engine that could not be told anyway.
     */
    const query = vi.fn(async () => [{ url: 'https://example.test/', id: 7 }])
    const api = fakeApi({ tabs: { query } })
    delete (api.tabs as { sendMessage?: unknown }).sendMessage

    await expect(
      createPlatform('chrome', api).tabs.sendToActive('download/verdict', DOWNLOAD_VERDICT),
    ).resolves.toBe(false)
    expect(query).not.toHaveBeenCalled()
  })
})

describe('who a message came from', () => {
  /**
   * The adapter used to drop the sender, and that is why a finding inside an iframe
   * had nowhere to go: the background answered whoever asked without being able to
   * tell a frame from a page, name its tab, or say where it was. Nothing tested the
   * pass-through, so removing it again was invisible — found by planting exactly
   * that.
   */
  type Sender = { tab?: { id?: number }; frameId?: number; url?: string; origin?: string }

  function senderSeenBy(sender: Sender): Record<string, unknown> {
    const listeners: Array<(m: unknown, s: Sender, r: (x: unknown) => void) => void> = []
    const api = fakeApi({
      runtime: {
        onMessage: {
          addListener: (cb) => {
            listeners.push(cb)
          },
        },
      },
    })
    let seen: Record<string, unknown> = { notCalled: true }
    createPlatform('chrome', api).runtime.onMessage((_message, from) => {
      seen = from as unknown as Record<string, unknown>
      return Promise.resolve({ ok: true }) as never
    })
    listeners[0]?.({ v: 1, type: 'page/candidates', payload: {} }, sender, () => undefined)
    return seen
  }

  it('hands the handler the tab, the frame and the origin', () => {
    expect(
      senderSeenBy({ tab: { id: 12 }, frameId: 3, url: 'https://ads.example.test/tag?id=9#x' }),
    ).toEqual({ tabId: 12, frameId: 3, origin: 'https://ads.example.test' })
  })

  it('keeps the origin and not the address', () => {
    // The frame's path is not ours to hold, and naming where a finding was is the
    // entire reason the top frame is told at all.
    const seen = senderSeenBy({ tab: { id: 1 }, frameId: 1, url: 'https://x.test/deep/path?q=1' })
    expect(seen.origin).toBe('https://x.test')
    expect(JSON.stringify(seen)).not.toContain('deep')
  })

  it('marks the top frame as frame zero, which is what tells a subframe apart', () => {
    // The relay fires on `frameId > 0`. If zero arrived as absent, every top-frame
    // scan would look like a subframe and the page would be told about itself.
    expect(senderSeenBy({ tab: { id: 4 }, frameId: 0, url: 'https://top.test/' }).frameId).toBe(0)
  })

  it('omits what it was not given rather than passing undefined along', () => {
    // An extension page has no tab. `{ tabId: undefined }` and `{}` behave the same
    // in a `typeof` check and differently in `toEqual`, and the second is the one
    // that says what the adapter knows.
    expect(senderSeenBy({})).toEqual({})
  })

  it('survives a url it cannot parse, with no origin rather than a throw', () => {
    // A throw here happens inside the browser's own listener, where nobody catches
    // it and the message is simply never answered.
    expect(senderSeenBy({ tab: { id: 2 }, frameId: 1, url: 'not a url' })).toEqual({
      tabId: 2,
      frameId: 1,
    })
  })
})

describe('marking the extension\'s own icon', () => {
  /**
   * The one surface a page cannot reach.
   *
   * Every other surface this product draws lives inside the page, so a page that
   * deletes our host from the document takes all of them at once — measured, and the
   * last open item in ADR-0001 until B-68. This is the escalation channel.
   */
  function icon() {
    return {
      setBadgeText: vi.fn(async () => undefined),
      setBadgeBackgroundColor: vi.fn(async () => undefined),
      setTitle: vi.fn(async () => undefined),
    }
  }

  it('marks the tab the finding is about, not the browser', async () => {
    // A global badge would still be there on the next site, saying something wrong
    // about a page that has nothing wrong with it.
    const action = icon()
    const platform = createPlatform('chrome', fakeApi({ action }))

    await expect(platform.tabs.mark(7, '!', 'something on this page')).resolves.toBe(true)
    expect(action.setBadgeText).toHaveBeenCalledWith({ text: '!', tabId: 7 })
    expect(action.setTitle).toHaveBeenCalledWith({ title: 'something on this page', tabId: 7 })
  })

  it('answers "nothing to mark" rather than throwing when there is no icon', async () => {
    // A browser without the API, or a test double that has no reason to carry it.
    const platform = createPlatform('firefox', fakeApi())
    await expect(platform.tabs.mark(1, '!', 'x')).resolves.toBe(false)
  })

  it('still marks when the colour is unsupported', async () => {
    /**
     * `setBadgeBackgroundColor` is optional in this shape on purpose. A browser that
     * lacks it must still get the text: a red badge is nicer, a badge is the point.
     */
    const action = icon()
    const withoutColour = {
      setBadgeText: action.setBadgeText,
      setTitle: action.setTitle,
    }
    const platform = createPlatform('firefox', fakeApi({ action: withoutColour }))
    await expect(platform.tabs.mark(3, '!', 'x')).resolves.toBe(true)
    expect(action.setBadgeText).toHaveBeenCalled()
  })

  it('treats a closed tab as nobody to tell', async () => {
    // The tab can close between the finding and the mark, and a rejected badge must
    // not become an unhandled rejection inside a content-script give-up.
    const action = icon()
    action.setBadgeText.mockRejectedValue(new Error('No tab with id: 9'))
    const platform = createPlatform('chrome', fakeApi({ action }))
    await expect(platform.tabs.mark(9, '!', 'x')).resolves.toBe(false)
  })
})

describe('an error answer is a failure, not a result', () => {
  /**
   * The receiver answers `{ v: 1, error: 'failed', detail }` when a handler throws and
   * `{ v: 1, error: 'unsupported' }` for a type it does not know. Both were handed back
   * as if they were the response, and every caller then read the field it wanted off
   * them — so `response?.verdicts ?? []` in the page scan turned a **failed scan into
   * a clean page**, with nothing logged because nothing threw.
   *
   * Found by reading a CI trace: eight console entries, all extension-chunk preload
   * warnings, and not one line from this product (B-74).
   */
  it('rejects when the receiver says it failed, and says what it said', async () => {
    const platform = createPlatform(
      'chrome',
      fakeApi({
        runtime: {
          sendMessage: vi.fn(async () => ({ v: 1, error: 'failed', detail: 'openDb: closing' })),
        },
      }),
    )
    await expect(platform.runtime.send('page/candidates', {} as never)).rejects.toThrow(
      /refused "page\/candidates".*failed.*openDb/,
    )
  })

  it('rejects an unsupported type rather than answering nothing found', async () => {
    // A version skew is the case this shape exists for, and the caller must be able to
    // tell "this build does not know that message" from "there is nothing to report".
    const platform = createPlatform(
      'chrome',
      fakeApi({
        runtime: { sendMessage: vi.fn(async () => ({ v: 1, error: 'unsupported' })) },
      }),
    )
    await expect(platform.runtime.send('page/candidates', {} as never)).rejects.toThrow(
      /unsupported/,
    )
  })

  it('still returns an ordinary answer, including an empty one', async () => {
    /**
     * The other side of the same guard. An empty result is a real answer — most pages
     * have nothing hidden on them — and a check that could not tell an empty result
     * from an error would have replaced one silent failure with a loud false one.
     */
    const platform = createPlatform(
      'chrome',
      fakeApi({
        runtime: { sendMessage: vi.fn(async () => ({ verdicts: [] })) },
      }),
    )
    await expect(platform.runtime.send('page/candidates', {} as never)).resolves.toEqual({
      verdicts: [],
    })
  })

  it('does not mistake a result that happens to carry an error field of its own', async () => {
    // `error: string` is the envelope's shape. A payload whose own field is called
    // `error` and is not a string must not be read as a refusal.
    const platform = createPlatform(
      'chrome',
      fakeApi({
        runtime: { sendMessage: vi.fn(async () => ({ verdicts: [], error: { code: 7 } })) },
      }),
    )
    await expect(platform.runtime.send('page/candidates', {} as never)).resolves.toMatchObject({
      verdicts: [],
    })
  })
})

describe('the deadline helper, now that two callers share it', () => {
  /**
   * It existed twice — here for a message to a worker that may never answer, and in the
   * background's leak lookup for a source that may never reply — and the copies had already
   * drifted in how they tested the timer handle. Behaviour under failure is the worst place
   * for two answers to live, so these are the properties both callers depend on.
   */
  it('rejects with the caller’s own sentence when nothing settles', async () => {
    vi.useFakeTimers()
    try {
      const pending = withDeadline(new Promise<never>(() => {}), 1000, 'the source said nothing')
      const settled = expect(pending).rejects.toThrow('the source said nothing')
      await vi.advanceTimersByTimeAsync(1000)
      await settled
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaves no timer behind when the work answers, which is most of the time', async () => {
    vi.useFakeTimers()
    try {
      expect(await withDeadline(Promise.resolve('answered'), 60_000, 'never')).toBe('answered')
      // A pending timer per answered call keeps a page — or a service worker — awake for
      // nothing. This is the assertion the `finally` in the helper exists for.
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('lets the work’s own failure through rather than reporting a timeout', async () => {
    await expect(
      withDeadline(Promise.reject(new Error('the source refused')), 60_000, 'timed out'),
    ).rejects.toThrow('the source refused')
  })
})
