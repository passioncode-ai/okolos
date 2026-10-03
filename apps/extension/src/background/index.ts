import { standingFindings } from '@okolos/core-extensions'
import { classifyUndecided, detectHidden } from '@okolos/core-injection'
import { detectPlatform, type RpcSender } from '@okolos/platform'
import { buildRules, matchUrl, type FeedSnapshot,
} from '@okolos/core-feeds'
import { createOnnxRuntime, MODEL } from '@okolos/model'
import {
  INVENTORY_INTERVAL_MS,
  LAST_FEED_KEY,
  LAST_INVENTORY_KEY,
  LAST_SWEEP_KEY,
  createModelCache,
  dueForFeed,
  dueForSweep,
  openDb,
  pruneExpired,
} from '@okolos/storage'
import type {
  Envelope,
  FrameFinding,
  GateDecision,
  PasswordAnswer,
  PageCandidates,
  RpcMap,
  RpcType,
  Verdict,
} from '@okolos/contracts'

import { handleDownload } from './downloads.js'
import {
  acceptInventoryChange,
  compareInventory,
  journalChanges,
  type InventoryDeps,
} from './extensions.js'
import { CAVALIER, hibp, lookupLeaks } from './leaks.js'
import { checkSubmittedPassword } from './password.js'
import { createInferenceHost } from './inference.js'
import { ensureRules, runIfDue, WAKE_ALARMS, type DueStore } from './wake.js'

/**
 * The background context holds no state between wake-ups.
 *
 * Chrome tears its service worker down after about thirty seconds of quiet, so
 * anything kept in a module variable is gone by the next message. Everything
 * that must survive goes to IndexedDB, and every schedule goes through alarms.
 */

const platform = detectPlatform()

/**
 * The worker shows copy too — a download verdict reaches a banner within the
 * same second — so it resolves like every other entry point. What it must not
 * do is resolve anything it *stores*: the journal takes keys and the reader
 * resolves them, so a record keeps meaning the same thing next month.
 */
useResolver((key, substitutions) => platform.message(key, substitutions))
import { spaceAwareWrite } from './audit-space.js'
import { feedArg } from './feed-words.js'
import { gateExplain } from './gate-words.js'
import { holdVerdict, releaseVerdict, takeVerdict } from './pending-password.js'
import { canVerify, createVerifier, FEED_PUBLIC_KEY, updateFeed } from './feeds.js'
import { syncFeed } from './feed-sync.js'
import { explained, t, useResolver } from '@okolos/i18n'
import { changePasswordUrl, reuseOf } from '@okolos/core-credential'

import { recordPageRequest } from './page-requests.js'
import { optionsPageFor } from '../options/views.js'

/**
 * What the worker did with a verdict request, in the worker's own timeline.
 *
 * The page side has said for a while whether it scanned (`okolos:collect`), gave up
 * (`okolos:scan-failed`) or stopped short (`okolos:scan-blinded`). When a banner does
 * not arrive and the page says "the scan asked", one link was still unreadable from
 * outside: whether this worker ever *received* the question. Three cases looked
 * identical — the message never reached the worker, the handler took it and never
 * answered, or it answered and the answer was lost on the way back — and B-78 has
 * spent four CI reds and two local repros inside that ambiguity.
 *
 * So the request is marked on arrival and the answer is measured on return. A worker
 * with no `okolos:verdict:start` never heard the question; a start with no
 * `okolos:verdict` measure is a handler that took it and stalled, which is ours to
 * fix; a measure with a duration says the background did its part in N ms and moves
 * the search to the reply path. Marks rather than a journal entry, for the reason
 * B-78 already settled on the page side: reading a journal means opening another
 * page, which changes the thing being diagnosed.
 */
export const MARK_VERDICT_IN = 'okolos:verdict:start'
export const MARK_VERDICT_OUT = 'okolos:verdict:end'
export const MEASURE_VERDICT = 'okolos:verdict'

// One list of alarms, shared with the wake budget test (wake.ts, wake.test.ts).
const [FEED, RETENTION, INVENTORY] = WAKE_ALARMS
const FEED_ALARM = FEED.name
const RETENTION_ALARM = RETENTION.name
const INVENTORY_ALARM = INVENTORY.name

platform.runtime.onMessage(<T extends RpcType>(message: Envelope<T>, from: RpcSender) => {
  switch (message.type) {
    case 'page/candidates':
      return handleCandidates(message.payload as PageCandidates) as Promise<RpcMap[T]['res']>
    case 'frame/report':
      // The sender travels with it: a frame cannot address the page that embeds it,
      // and it must not try — a `window.top.postMessage` hop goes through the page's
      // own window, where the page can forge it and the top frame cannot tell an
      // extension's report from a claim by the thing being reported.
      return relayFrameFinding(message.payload as FrameFinding, from) as Promise<
        RpcMap[T]['res']
      >
    case 'rules/refresh':
      return refreshBlockRules() as Promise<RpcMap[T]['res']>
    case 'block/context':
      return blockContext() as Promise<RpcMap[T]['res']>
    case 'block/allow':
      return allowBlocked(message.payload as { url: string }) as Promise<RpcMap[T]['res']>
    case 'password/check':
      return handlePasswordCheck(
        message.payload as { sha1: string; host: string },
        from,
      ) as Promise<RpcMap[T]['res']>
    case 'password/shown':
      return forgetHeldVerdict(from) as Promise<RpcMap[T]['res']>
    case 'password/pending':
      return answerPendingVerdict(from) as Promise<RpcMap[T]['res']>
    case 'leaks/check':
      return handleLeakCheck(message.payload as { address: string }) as Promise<RpcMap[T]['res']>
    case 'extensions/state':
      return extensionsState() as Promise<RpcMap[T]['res']>
    case 'extensions/disable':
      return disableExtension(message.payload as { id: string }) as Promise<RpcMap[T]['res']>
    case 'extensions/trust':
      return trustExtensionChange(message.payload as { id: string }) as Promise<RpcMap[T]['res']>
    case 'finding/resolve':
      return resolveFinding(message.payload as { id: string }) as Promise<RpcMap[T]['res']>
    case 'finding/defer':
      return deferFinding(message.payload as { id: string; until: string }) as Promise<RpcMap[T]['res']>
    case 'site/facts':
      return siteFacts(message.payload as { host: string }) as Promise<RpcMap[T]['res']>
    case 'page/request':
      return journalPageRequest(
        message.payload as { method: string; host: string },
        from,
      ) as Promise<RpcMap[T]['res']>
    case 'trap/warned':
      return journalTrap(message.payload as { kind: string; signals: string }) as Promise<RpcMap[T]['res']>
    case 'recovery/open':
      return openRecovery(message.payload as { kind: string }) as Promise<RpcMap[T]['res']>
    case 'password/change':
      return openChangePassword(message.payload as { host: string }) as Promise<
        RpcMap[T]['res']
      >
    case 'trust/list':
      return listTrusted() as Promise<RpcMap[T]['res']>
    case 'trust/revoke':
      return revokeTrusted(message.payload as { domain: string }) as Promise<RpcMap[T]['res']>
    case 'trust/add':
      return addTrusted(message.payload as { domain: string }) as Promise<RpcMap[T]['res']>
    case 'page/note':
      // The sender travels with it for one of the seven kinds: `surface-removed` also
      // marks the icon, and the icon is per tab because "something is wrong here" is
      // a fact about this page and not about the browser.
      return notePageEvent(
        message.payload as {
          kind:
            | 'restore'
            | 'frame-unreported'
            | 'gate-unread'
            | 'password-unchecked'
            | 'surface-removed'
            | 'scan-failed'
            | 'scan-blinded'
          explain: string
        },
        from,
      ) as Promise<RpcMap[T]['res']>
    case 'gate/decision':
      return handleGateDecision(message.payload as GateDecision) as Promise<RpcMap[T]['res']>
    default:
      // Unknown types are answered by the adapter, not thrown here: a version
      // skew must not turn into a broken page.
      return undefined
  }
})

/**
 * The classifier host.
 *
 * It prepares itself once per wake-up and reports honestly why it is
 * unavailable when it is: no place to run a model, no weights the user agreed
 * to fetch, or no runtime bundled. Today the last of those is the real answer —
 * the weights carry a licence question that is the operator's to settle — so
 * stage 3 never fires and nothing above it claims otherwise.
 */
const inference = createInferenceHost({
  ensureHost: () => platform.inference.ensureHost(),
  weights: async () => {
    try {
      const db = await openDb()
      const cache = createModelCache({ db, now: () => new Date().toISOString() })
      return await cache.read(MODEL.id, MODEL.version)
    } catch {
      return null
    }
  },
  runtime: createOnnxRuntime,
  remoteScore: async (text) => {
    const response = await platform.runtime.send('inference/score', { text })
    return response?.score ?? null
  },
  log: (message) => console.warn(message),
})

/**
 * Prepared per wake-up, not per page. Chrome tears the worker down after about
 * thirty seconds of quiet, so this runs again on the next message — which is
 * also what makes a model installed mid-session take effect without a restart.
 */
const prepared = inference.prepare().catch(() => 'no-host' as const)


async function handleCandidates(page: PageCandidates): Promise<{ verdicts: Verdict[] }> {
  // Before anything that can throw or await: the fact being recorded is "this worker
  // heard the question", and a mark placed after the first await would be missing in
  // exactly the case it exists to describe.
  performance.mark(MARK_VERDICT_IN)
  const now = new Date().toISOString()
  const ctx = { now, newId: () => crypto.randomUUID() }
  const verdicts = detectHidden(page, ctx)
  await prepared

  // Stage 3 sees only what the rules left undecided.
  const decidedLocators = verdicts.flatMap((v) => v.evidence.map((e) => e.locator ?? ''))
  verdicts.push(...(await classifyUndecided(page, decidedLocators, inference, ctx)))

  if (verdicts.length > 0) {
    try {
      const db = await openDb()
      for (const verdict of verdicts) {
        await db.put('findings', {
          id: verdict.id,
          createdAt: verdict.createdAt,
          subject: `${verdict.subject.kind}:${verdict.subject.ref}`,
          resolvedAt: null,
          verdict,
        })
      }
    } catch (cause) {
      // Storing the finding is best-effort; warning the user is not. If the
      // database is unavailable the verdict still goes back to the page.
      console.warn('okolos: could not persist findings', cause)
    }
  }

  // Deliberately not in a `finally`: a handler that threw did not answer, and a measure
  // written anyway would say it did. The absent measure beside a present start mark is
  // the reading that matters.
  performance.mark(MARK_VERDICT_OUT)
  performance.measure(MEASURE_VERDICT, MARK_VERDICT_IN, MARK_VERDICT_OUT)
  return { verdicts }
}

/**
 * Forwards a frame's finding to the page that embeds it, and says whether anyone
 * was there to hear it.
 *
 * The frame retries on `delivered: false`, because the receiver is not failing — it
 * does not exist yet. An embedded document can reach `document_idle` and finish its
 * whole scan before the embedding page's content script has started, so a report
 * sent once arrives at a frame zero with no listener and `sendMessage` rejects into
 * silence. That is why this returns a fact instead of nothing.
 */
async function relayFrameFinding(
  finding: FrameFinding,
  from: RpcSender,
): Promise<{ delivered: boolean }> {
  if (typeof from.tabId !== 'number' || (from.frameId ?? 0) === 0) return { delivered: false }
  const delivered = await platform.tabs
    .sendToFrame('frame/finding', { ...finding, origin: from.origin ?? finding.origin }, {
      tabId: from.tabId,
      frameId: 0,
    })
    .catch(() => false)
  return { delivered }
}

/**
 * A held action is journalled here rather than in the page, because the page is
 * the thing under suspicion. Whether the user allowed it or blocked it, the
 * record survives the tab that produced it.
 */
async function handleGateDecision(decision: GateDecision): Promise<{ ok: true }> {
  try {
    const db = await openDb()
    await db.put('journal', {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      kind: 'action',
      detail: {
        actionId: decision.actionId,
        outcome: decision.outcome,
        reason: decision.reason,
        findings: decision.findingIds.join(','),
        ...gateExplain(decision),
      },
    })
  } catch (cause) {
    // The decision was already enforced in the page; losing the record is bad
    // but not dangerous, and saying so beats pretending it was written.
    console.warn('okolos: could not journal a gate decision', cause)
  }
  return { ok: true }
}

// Through the adapter, like everything else. Reaching for chrome.* directly
// here is the same mistake that silently broke the content script in Firefox,
// and it is easiest to make in exactly this kind of one-line wiring.
platform.runtime.onInstalled(() => {
  void platform.tabs.create(platform.runtime.getUrl('first-run.html'))
})

/**
 * Blocking happens in the network layer, not after the page has rendered — a
 * page stopped after render has already run its scripts and started its timer.
 * That means declarativeNetRequest rules, rebuilt whenever the feed or the
 * user's exceptions change.
 */
const PHISHING_FEED = 'phishing'
const INTERSTITIAL = '/interstitial.html'

/**
 * The last top-level web navigation — the one the interstitial asks about. Lost on
 * worker teardown, which is fine: the page asks again on load, and a missing answer
 * is shown as unknown rather than guessed.
 *
 * Only the URL is kept here. Matching it against the feed used to happen on every
 * navigation, reading the whole feed from IndexedDB for pages that were never
 * blocked; it now happens when the interstitial asks (LC-08).
 */
let lastNavigation: string | null = null

async function currentFeed(): Promise<FeedSnapshot | null> {
  try {
    const db = await openDb()
    const row = await db.get('feeds', PHISHING_FEED)
    return row
      ? { name: row.name, version: row.version, updatedAt: row.updatedAt, entries: row.entries }
      : null
  } catch {
    return null
  }
}

/** The rules the stored feed and the user's exceptions call for, or null without a feed. */
async function expectedRuleSet(): Promise<{ feed: FeedSnapshot; set: ReturnType<typeof buildRules> } | null> {
  const feed = await currentFeed()
  if (!feed) return null

  const db = await openDb()
  const exceptions = (await db.getAll('exceptions'))
    .filter((row) => row.scope === 'domain')
    .map((row) => row.ref)

  return { feed, set: buildRules(feed, exceptions, INTERSTITIAL) }
}

export async function refreshBlockRules(): Promise<{ installed: number; dropped: number }> {
  const expected = await expectedRuleSet()
  if (!expected) return { installed: 0, dropped: 0 }
  const { feed, set } = expected
  const db = await openDb()

  await platform.blocking.replaceRules(set.rules)

  if (set.dropped > 0) {
    // A silently enforced subset reads as full protection. It is not.
    await db.put('journal', {
      id: `feed:truncated:${new Date().toISOString()}`,
      createdAt: new Date().toISOString(),
      kind: 'error',
      detail: {
        // The feed's name is a message of ours where we publish the list, so it travels
        // as a key and is resolved again for whoever reads the row (B-77).
        ...explained('logRulesTruncated', [feedArg(feed.name), String(set.dropped)]),
        feed: feed.name,
      },
    })
  }

  return { installed: set.rules.length, dropped: set.dropped }
}

async function blockContext(): Promise<{
  url: string
  feed: string | null
  entryDate: string | null
  feedAgeDays: number | null
} | null> {
  if (!lastNavigation) return null
  const url = lastNavigation
  const feed = await currentFeed()
  const match = feed ? matchUrl(url, feed) : null
  const ageDays = feed
    ? Math.floor((Date.now() - Date.parse(feed.updatedAt)) / 86_400_000)
    : null
  return {
    url,
    feed: match?.feed ?? null,
    entryDate: match?.updatedAt?.slice(0, 10) ?? null,
    feedAgeDays: Number.isFinite(ageDays) ? ageDays : null,
  }
}

async function allowBlocked(payload: { url: string }): Promise<{ url: string } | null> {
  const target = payload.url
  if (!target) return null

  let host: string
  try {
    host = new URL(target).hostname
  } catch {
    return null
  }

  try {
    const db = await openDb()
    await db.put('exceptions', {
      scope: 'domain',
      ref: host,
      createdAt: new Date().toISOString(),
      reasonKey: 'trustContinuedPastBlock',
    })
    await db.put('journal', {
      id: `exception:${host}:${new Date().toISOString()}`,
      createdAt: new Date().toISOString(),
      kind: 'action',
      detail: { explainKey: 'logKeptVisiting', explainArgs: [host], reason: 'user-allowed' },
    })
    await refreshBlockRules()
  } catch (cause) {
    // Without a recorded exception the next visit is blocked again. Saying so
    // beats sending the user back into a loop they cannot escape.
    console.warn('okolos: could not record the exception', cause)
    return null
  }

  return { url: target }
}

/**
 * What this device knows about a host, and nothing more.
 *
 * The first visit is recorded here rather than read from browsing history: the
 * history permission would give this extension every page the user has ever
 * opened, to answer a question that only needs one date per domain.
 */
/**
 * Writes something the content script observed into the journal.
 *
 * The page cannot reach storage, and a surface that fails silently is the
 * defect this exists to close — a restore that could not finish now leaves a
 * record as well as a sentence on screen.
 */
async function notePageEvent(
  payload: {
    kind:
      | 'restore'
      | 'frame-unreported'
      | 'gate-unread'
      | 'password-unchecked'
      | 'surface-removed'
      | 'scan-failed'
      | 'scan-blinded'
    explain: string
    /** Verbatim failure text, when the sender has one. Never folded into `explain` (B-115). */
    diagnostic?: string
  },
  from?: { tabId?: number },
): Promise<{ ok: true }> {
  /**
   * One kind also leaves the page: `surface-removed` means every in-page surface has
   * been deleted from the document by the page itself, so a journal line is the only
   * record and the journal is a screen the user has to go and open. The icon is the
   * one channel the page does not own (ADR-0001), and it is marked first — before the
   * write that may fail — because the badge is what the person will actually see.
   */
  if (payload.kind === 'surface-removed' && typeof from?.tabId === 'number') {
    await platform.tabs
      // `t`, not `platform.message`: the resolver is installed with the second and
      // every key in this codebase is read with the first, which is also the shape the
      // locale gate recognises. Two call shapes would make live keys read as dead.
      .mark(from.tabId, '!', t('badgeSurfaceRemoved'))
      .catch(() => false)
  }

  try {
    const db = await openDb()
    await db.put('journal', {
      id: `page:${payload.kind}:${new Date().toISOString()}`,
      createdAt: new Date().toISOString(),
      kind: 'action',
      detail: {
        reason: `page-${payload.kind}`,
        explain: payload.explain,
        ...(payload.diagnostic === undefined ? {} : { diagnostic: payload.diagnostic }),
      },
    })
  } catch (cause) {
    // The note is the least important thing on the page at that moment.
    console.warn('okolos: could not journal a page note', cause)
  }
  return { ok: true }
}

/** Everything that may leave the device goes through this, and is logged first. */
async function auditDeps() {
  const db = await openDb()
  const write = spaceAwareWrite({
    write: async (entry) => {
      await db.put('outbound_log', entry as never)
    },
    // The sweep the extension already runs on a schedule. Discovering the
    // device is full is exactly the moment to run it: without this, a full
    // database stops every network feature at once and reports it feature by
    // feature as "that source was unavailable".
    freeSpace: async () => {
      try {
        await pruneExpired(db, Date.now())
      } catch (cause) {
        console.warn('okolos: could not free space for the audit log', cause)
      }
    },
    report: (what) => {
      // Written straight to the journal rather than through the audit log,
      // which is the thing that just failed.
      void db
        .put('journal', {
          id: `storage:${what}:${new Date().toISOString()}`,
          createdAt: new Date().toISOString(),
          kind: 'error',
          detail: {
            reason: what,
            explainKey: STORAGE_KEY[what] ?? 'logStorageFull',
          },
        })
        .catch(() => {
          // If even this cannot be written there is nowhere left to say it.
        })
    },
  })

  return {
    writeAudit: async (entry: Parameters<typeof db.put>[1]) => {
      await write(entry)
    },
    now: () => new Date().toISOString(),
    newId: () => crypto.randomUUID(),
  }
}

const REUSE_KEY_SETTING = 'reuse:key'

/**
 * The device key the reuse index is tagged with.
 *
 * Random, generated once, never synchronised, and wiped with everything else on
 * the data screen. Its whole job is to make the stored tags meaningless to
 * anyone who has the file and not the device: without it a tag is an HMAC over
 * an unknown digest, and a dictionary of common passwords tells them nothing.
 */
async function reuseKey(): Promise<CryptoKey | null> {
  try {
    const db = await openDb()
    const stored = (await db.get('settings', REUSE_KEY_SETTING))?.value
    let raw: Uint8Array
    if (typeof stored === 'string' && stored.length > 0) {
      raw = Uint8Array.from(atob(stored), (c) => c.charCodeAt(0))
    } else {
      raw = crypto.getRandomValues(new Uint8Array(32))
      await db.put('settings', {
        key: REUSE_KEY_SETTING,
        value: btoa(String.fromCharCode(...raw)),
      })
    }
    // `.buffer` rather than the view: a Uint8Array over a SharedArrayBuffer is
    // not a BufferSource, and the DOM types are right to say so.
    return await crypto.subtle.importKey(
      'raw',
      raw.slice().buffer,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    )
  } catch {
    // No key means no index. The check still answers; the reuse half reports
    // itself unknown, which is true and is the safe direction.
    return null
  }
}

/**
 * The tag for one password on this device.
 *
 * Taken over the digest the content script already computed, not over the
 * password: the password never crossed into the worker and this does not make
 * it start. Same password, same digest, same tag — which is all reuse needs.
 */
async function reuseTag(sha1: string): Promise<string | null> {
  const key = await reuseKey()
  if (key === null) return null
  try {
    const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(sha1.toUpperCase()))
    return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('')
  } catch {
    return null
  }
}

async function handlePasswordCheck(
  payload: { sha1: string; host: string },
  from: RpcSender,
): Promise<PasswordAnswer> {
  const verdict = await checkSubmittedPassword(payload.sha1, await auditDeps())

  let reusedOn: string[] = []
  let reuseUnknown = true
  const tag = await reuseTag(payload.sha1)
  if (tag !== null && payload.host) {
    try {
      const db = await openDb()
      const rows = await db.getAllFromIndex('reuse', 'by-tag', tag)
      const answer = reuseOf(rows, tag, payload.host)
      reusedOn = answer.elsewhere.map((row) => row.host)
      reuseUnknown = answer.unknown
      // Recorded after the answer, so a first submission reads as unknown
      // rather than as "seen here already".
      if (answer.unknown || !rows.some((row) => row.host === payload.host)) {
        await db.put('reuse', { tag, host: payload.host, seenAt: new Date().toISOString().slice(0, 10) })
      }
    } catch {
      // An unreadable index answers "unknown", never "nowhere else".
      reusedOn = []
      reuseUnknown = true
    }
  }

  const answer: PasswordAnswer = {
    compromised: verdict.compromised,
    count: verdict.count,
    offline: verdict.offline,
    explain: verdict.explain,
    reusedOn,
    reuseUnknown,
  }

  if (answer.compromised) {
    /**
     * Recorded here, not by whoever shows it, and that is the point.
     *
     * Until 2026-08-20 a compromised password produced a banner and **nothing else**:
     * no row anywhere. So a banner dismissed, or lost to the navigation the submission
     * itself caused, took the fact with it (B-82). The journal is written before any
     * delivery is attempted, because the fact is true whether or not anybody saw it.
     */
    await journalPasswordVerdict(payload.host, answer)

    // And held for the tab, so the next document there can show it. Released by the
    // surface that draws it — a receipt, not a timeout.
    if (typeof from.tabId === 'number') {
      await holdVerdict(platform.storage, from.tabId, {
        host: payload.host,
        verdict: answer,
        at: new Date().toISOString(),
      })

      /**
       * And offered once, right now, to whatever document the tab has. Not awaited: the
       * answer this function returns is what the asking document draws when it is still
       * alive, and making it wait on a delivery to its own replacement would hold up the
       * ordinary case for the rare one.
       *
       * One attempt, no retries. A loop would have to live in this worker, and the worker
       * is torn down when the browser decides — measured as a warning that arrived most of
       * the time. Whoever this misses asks for it themselves as they start.
       */
      void platform.tabs
        .sendToFrame(
          'password/verdict',
          { host: payload.host, verdict: answer },
          { tabId: from.tabId, frameId: 0 },
        )
        .catch(() => false)

    }
  }

  return answer
}

/** One row, one sentence: the verdict, naming the site the password was sent to. */
async function journalPasswordVerdict(host: string, answer: PasswordAnswer): Promise<void> {
  try {
    const db = await openDb()
    await db.put('journal', {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      kind: 'verdict',
      detail: {
        host,
        // Facts beside the sentence, for the export and for anything that wants to
        // count rather than read: which source answered, and what it said.
        offline: answer.offline,
        code: answer.explain.code,
        reusedOn: answer.reusedOn.join(','),
        reuseUnknown: answer.reuseUnknown,
        ...explained('journalPasswordCompromised', [host]),
      },
    })
  } catch {
    // An unwritable journal must not swallow the verdict: the answer still returns and
    // the surface still draws. Nothing is claimed about the record that was not made.
  }
}

/** The surface confirmed it drew the verdict, so the held copy is forgotten. */
async function forgetHeldVerdict(from: RpcSender): Promise<{ ok: true }> {
  if (typeof from.tabId === 'number') await releaseVerdict(platform.storage, from.tabId)
  return { ok: true }
}

/**
 * The verdict this tab is still holding, or null.
 *
 * Answering does not consume it — `password/shown` does. A document that asks and is
 * destroyed before it can draw has changed nothing, and the next one asks again. That is
 * the whole reason this is a question rather than a push: nothing here depends on a
 * service worker staying alive between the answer and the drawing.
 */
async function answerPendingVerdict(
  from: RpcSender,
): Promise<{ host: string; verdict: PasswordAnswer } | null> {
  if (typeof from.tabId !== 'number') return null
  const held = await takeVerdict(platform.storage, from.tabId, Date.now())
  return held === null ? null : { host: held.host, verdict: held.verdict }
}

async function handleLeakCheck(payload: { address: string }) {
  const key = await readSetting('hibp:apiKey')
  const inventory = await lookupLeaks(
    payload.address,
    [hibp(typeof key === 'string' && key ? key : null), CAVALIER],
    await auditDeps(),
  )
  return {
    leaks: inventory.leaks.map((leak) => ({ ...leak, classes: [...leak.classes] })),
    sources: inventory.sources.map((source) => ({ ...source })),
    complete: inventory.complete,
  }
}

async function readSetting(key: string): Promise<unknown> {
  try {
    const db = await openDb()
    return (await db.get('settings', key))?.value ?? null
  } catch {
    return null
  }
}

async function extensionsState() {
  if (!platform.extensions.available()) {
    return { supported: false, changes: [], installed: [] }
  }

  /**
   * The comparison is run here rather than read from a cache: opening the screen
   * is exactly the moment the user wants the current answer, and it is cheap next
   * to the wait they would otherwise not understand.
   *
   * It does not record anything, which is the point. This handler serves both the
   * extensions screen and the area counter on the overview, and while it recorded
   * the new state the first of the two consumed the difference — the counter said
   * "3 changes" and the screen said nothing had changed.
   */
  const changes = await compareInventory(inventoryDeps(await openDb())).catch(() => [])

  const installed = (await platform.extensions.list()).filter(
    (entry) => entry.id !== platform.extensions.selfId(),
  )

  return {
    supported: true,
    changes: changes.map((change) => ({ ...change })),
    installed: installed.map((entry) => ({
      id: entry.id,
      name: entry.name,
      version: entry.version,
      permissions: [...entry.permissions],
      enabled: entry.enabled,
      /**
       * What is true of it as it stands, not what changed about it (B-56).
       *
       * Computed here rather than on the page because the page never sees `installType`
       * or the host permissions — the wire shape carries what a person is shown, and
       * these two facts are the reason some of them are worth showing.
       */
      // Mapped onto the wire shape rather than sent as-is: `pair` is a readonly tuple
      // here and a plain array there, and the wire is deliberately the looser of the two.
      standing: standingFindings({
        id: entry.id,
        name: entry.name,
        version: entry.version,
        permissions: entry.permissions,
        hostPermissions: entry.hostPermissions,
        publisher: entry.publisher,
        enabled: entry.enabled,
        ...(entry.installType === undefined ? {} : { installType: entry.installType }),
      }).map((finding) => ({
        kind: finding.kind,
        id: finding.id,
        name: finding.name,
        severity: finding.severity,
        ...(finding.installType === undefined ? {} : { installType: finding.installType }),
        ...(finding.pair === undefined ? {} : { pair: [...finding.pair] }),
        ...(finding.everywhere === undefined ? {} : { everywhere: finding.everywhere }),
      })),
    })),
  }
}

async function disableExtension(payload: { id: string }): Promise<{ ok: boolean; why?: string }> {
  try {
    await platform.extensions.disable(payload.id)
  } catch (cause) {
    // The browser refuses for policy-installed extensions, among others. Saying
    // so beats a button that silently does nothing.
    return { ok: false, why: cause instanceof Error ? cause.message : String(cause) }
  }

  try {
    const db = await openDb()
    const now = new Date().toISOString()
    await db.put('journal', {
      id: `extension-disabled:${payload.id}:${now}`,
      createdAt: now,
      kind: 'action',
      detail: { explainKey: 'logExtensionDisabled', explainArgs: [payload.id], reason: 'user-blocked' },
    })
  } catch {
    // The extension is off either way; the record is the lesser of the two.
  }
  return { ok: true }
}

/** One shape for the three callers, so none of them can differ by accident. */
function inventoryDeps(db: Awaited<ReturnType<typeof openDb>>): InventoryDeps {
  return {
    db,
    list: () => platform.extensions.list(),
    now: () => new Date().toISOString(),
    selfId: platform.extensions.selfId(),
  }
}

/**
 * Accepting a change, which means the stored state becomes the current one.
 *
 * It used to write an `exceptions` row with `scope: 'extension'` and nothing in
 * the repository ever read it — both readers filter for `scope === 'domain'`, and
 * correctly, since they build blocking rules and the trusted-domain list. So the
 * change came back on the next screen open and the button was decoration. The
 * record of the decision is the journal entry below; the mechanism is the
 * baseline, and there is no row nobody reads.
 */
async function trustExtensionChange(payload: { id: string }): Promise<{ ok: true }> {
  try {
    const db = await openDb()
    const now = new Date().toISOString()
    await acceptInventoryChange(inventoryDeps(db), payload.id)
    await db.put('journal', {
      id: `extension-trusted:${payload.id}:${now}`,
      createdAt: now,
      kind: 'action',
      detail: { explainKey: 'logExtensionAccepted', explainArgs: [payload.id], reason: 'user-allowed' },
    })
  } catch (cause) {
    console.warn('okolos: could not record the accepted change', cause)
  }
  return { ok: true }
}

async function resolveFinding(payload: { id: string }): Promise<{ ok: true }> {
  try {
    const db = await openDb()
    const finding = await db.get('findings', payload.id)
    if (finding) await db.put('findings', { ...finding, resolvedAt: new Date().toISOString() })
  } catch (cause) {
    console.warn('okolos: could not resolve a finding', cause)
  }
  return { ok: true }
}

/**
 * Deferral is kept beside the finding rather than inside it: the record is
 * what the detector saw, and "the user is not ready today" is not a fact about
 * the page. It also means a wipe of settings clears deferrals without touching
 * the findings themselves.
 */
async function deferFinding(payload: { id: string; until: string }): Promise<{ ok: true }> {
  try {
    const db = await openDb()
    await db.put('settings', { key: `defer:${payload.id}`, value: payload.until })
  } catch (cause) {
    console.warn('okolos: could not defer a finding', cause)
  }
  return { ok: true }
}

async function siteFacts(payload: { host: string }): Promise<{
  trusted: boolean
  firstSeen: string | null
}> {
  try {
    const db = await openDb()
    const trustedRow = await db.get('exceptions', ['domain', payload.host])
    const seen = await db.get('settings', `seen:${payload.host}`)
    const firstSeen = typeof seen?.value === 'string' ? seen.value : null

    if (!firstSeen) {
      // A date, not an instant. The hour at which someone signs in to a site is
      // no business of a note that only answers "have I met this host before" —
      // the reuse index made exactly this call one screen away, and this row was
      // the one still keeping seconds.
      await db.put('settings', {
        key: `seen:${payload.host}`,
        value: new Date().toISOString().slice(0, 10),
      })
    }

    return { trusted: Boolean(trustedRow), firstSeen }
  } catch {
    // Unknown is not the same as new: the guard is told nothing is known and
    // says so, rather than being told the site is brand new.
    return { trusted: false, firstSeen: null }
  }
}

/** What a full-storage sweep is recorded as. `full` is the fallback, so the
 * lookup always resolves and the type stays a string. */
const STORAGE_KEY: Record<string, string> = {
  'swept-to-make-room': 'logSweptToMakeRoom',
  full: 'logStorageFull',
}

/** What each page trap is recorded as. `generic` covers one we cannot name. */
const TRAP_KEY: Record<string, string> = {
  clickfix: 'logTrapClickfix',
  techsupport: 'logTrapTechsupport',
  generic: 'logTrapGeneric',
}

/**
 * A state-changing request the page made while a finding was unresolved.
 *
 * Recorded and never stopped — the wording says so, because a journal line that
 * reads like an interception would be the product claiming a reach it does not
 * have. Host and method only: a query string carries the very thing this
 * product exists to keep on the device.
 */
async function journalPageRequest(
  payload: { method: string; host: string },
  from: RpcSender,
): Promise<{ ok: true }> {
  try {
    // The rule lives in `page-requests.ts`, where a test can reach it: this is
    // the decision the page must not own, and it used to be a boolean inside the
    // page's own world.
    await recordPageRequest({ db: await openDb(), now: () => new Date().toISOString() }, payload, from.origin)
  } catch (cause) {
    console.warn('okolos: could not journal a page request', cause)
  }
  return { ok: true }
}

async function journalTrap(payload: { kind: string; signals: string }): Promise<{ ok: true }> {
  // Table, not a ternary, because `tools/locales.test.ts` finds the keys a
  // build asks for by reading `t('…')`, `*_KEY` tables and `…Key:` fields — and
  // deliberately nothing looser, since a looser reader keeps dead messages
  // alive. Written any other way these five keys read as translated-and-unused.
  try {
    const db = await openDb()
    const now = new Date().toISOString()
    await db.put('journal', {
      id: `trap:${payload.kind}:${now}`,
      createdAt: now,
      kind: 'verdict',
      detail: { explainKey: TRAP_KEY[payload.kind] ?? 'logTrapGeneric', signals: payload.signals },
    })
  } catch (cause) {
    console.warn('okolos: could not journal a page trap', cause)
  }
  return { ok: true }
}

async function openRecovery(payload: { kind: string }): Promise<{ ok: true }> {
  // The checklist itself lands with REQ-22; until then the entry point exists
  // and goes somewhere real rather than being a control that does nothing.
  await platform.tabs.create(platform.runtime.getUrl(optionsPageFor('recovery', payload.kind)))
  return { ok: true }
}

/**
 * Opens a site's own change-password page, or says it would not.
 *
 * The host arrives from a content script, which cannot open a tab itself, and the
 * address is composed here rather than there: a caller that could pass a URL could pass
 * any URL, and the published path deserves one definition rather than one per caller.
 * `changePasswordUrl` refuses a host that would hand the authority to somebody else.
 */
async function openChangePassword(payload: { host: string }): Promise<{ opened: boolean }> {
  const url = changePasswordUrl(payload.host)
  if (url === null) return { opened: false }
  try {
    await platform.tabs.create(url)
    return { opened: true }
  } catch {
    // The browser refused to open a tab. The banner stays where it is, and nothing
    // claims the page was opened.
    return { opened: false }
  }
}

async function listTrusted(): Promise<{
  domains: string[]
  entries: Array<{ domain: string; grantedAt: string; reasonKey?: string; reason?: string }>
}> {
  try {
    const db = await openDb()
    const rows = (await db.getAll('exceptions')).filter((row) => row.scope === 'domain')
    return {
      domains: rows.map((row) => row.ref),
      entries: rows.map((row) => ({
        domain: row.ref,
        grantedAt: row.createdAt,
        // Both travel: the key for rows written since the move, the sentence
        // for those written before it. The screen decides which it has.
        ...(row.reasonKey ? { reasonKey: row.reasonKey } : {}),
        ...(row.reason ? { reason: row.reason } : {}),
      })),
    }
  } catch {
    // An unreadable exception list means warning about sites the user already
    // approved. Noisy, but never the other way round.
    return { domains: [], entries: [] }
  }
}

async function revokeTrusted(payload: { domain: string }): Promise<{ ok: true }> {
  try {
    const db = await openDb()
    await db.delete('exceptions', ['domain', payload.domain])
    // The blocking rules were built with this domain excused; rebuild them, or
    // the site stays reachable and the revocation is cosmetic.
    await refreshBlockRules()

    const now = new Date().toISOString()
    await db.put('journal', {
      id: `trust-revoked:${payload.domain}:${now}`,
      createdAt: now,
      kind: 'action',
      detail: {
        explainKey: 'logTrustRevoked',
        explainArgs: [payload.domain],
        reason: 'user-blocked',
      },
    })
  } catch (cause) {
    console.warn('okolos: could not revoke trust', cause)
  }
  return { ok: true }
}

async function addTrusted(payload: { domain: string }): Promise<{ ok: true }> {
  try {
    const db = await openDb()
    await db.put('exceptions', {
      scope: 'domain',
      ref: payload.domain,
      createdAt: new Date().toISOString(),
      reasonKey: 'trustMarkedLegitimate',
    })
    await refreshBlockRules()
  } catch (cause) {
    console.warn('okolos: could not record a trusted domain', cause)
  }
  return { ok: true }
}

platform.blocking.onBlocked((url) => {
  lastNavigation = url
})

/**
 * The rules persist in the browser across restarts and updates, and every change
 * this extension makes rebuilds them on the spot (a feed accepted, a site trusted or
 * revoked). So they are checked — counted, not rebuilt — only at the moments the
 * browser could have lost them: start, install, update. They used to be rebuilt,
 * remove-all and add-all, on every wake-up (LC-08).
 */
async function ensureBlockRules(): Promise<void> {
  try {
    await ensureRules({
      installed: () => platform.blocking.ruleCount(),
      expected: async () => (await expectedRuleSet())?.set.rules.length ?? null,
      rebuild: () => refreshBlockRules(),
    })
  } catch (cause) {
    console.warn('okolos: could not check the blocking rules', cause)
  }
}
platform.runtime.onBrowserStart(() => {
  void ensureBlockRules()
})

/**
 * Downloads are judged as they are created — the only moment the bytes have not
 * landed yet. Nothing here waits on the page: a direct link has no page.
 */
platform.downloads.onCreated((item) => {
  void handleDownload(item, {
    feed: currentFeed,
    cancel: (id) => platform.downloads.cancel(id),
    journal: async (entry) => {
      const db = await openDb()
      const now = new Date().toISOString()
      await db.put('journal', {
        id: `download:${item.id}:${now}`,
        createdAt: now,
        kind: entry.outcome === 'block' ? 'verdict' : 'action',
        detail: { explain: entry.explain, outcome: entry.outcome },
      })
    },
    announce: async (verdict) => {
      /**
       * `tabs.sendToActive`, not `runtime.send`, and the difference is the whole
       * defect this replaces.
       *
       * From a background context `runtime.sendMessage` reaches the extension's own
       * pages and never a content script. The listener for `download/verdict` lives
       * in `content/index.ts`, so nothing ever arrived: `content/download.ts` — 76
       * lines and nine tests — could not run in the product. REQ-19 promises a
       * warning before the file is saved, and what the user got was a journal entry
       * they had no reason to open.
       *
       * Still best-effort, and the misses are now named rather than implied: a
       * download begun from a bookmark has no page, one begun in a background tab
       * reaches the wrong page or none, and the journal remains the record in both
       * cases. `false` says so; it does not throw, because a handler deciding
       * whether to cancel a download has no use for an exception about a banner.
       */
      const told = await platform.tabs
        .sendToActive('download/verdict', {
          action: verdict.action,
          // Codes, not sentences: the words are the content script's, which has the
          // catalogue. This line used to carry English composed here (B-75).
          headline: verdict.headline,
          shape: verdict.shape,
          reasons: verdict.reasons.join(' '),
          skipped: verdict.skipped.map((entry) => `${entry.check}: ${entry.why}`).join('; '),
        })
        .catch(() => false)

      if (!told) {
        // Recorded, because "the banner did not show" and "the check did not run"
        // read identically in a journal that only holds the verdict. Written
        // through the same store the verdict went to, so the two sit together.
        try {
          const db = await openDb()
          const now = new Date().toISOString()
          await db.put('journal', {
            id: `download-unseen:${item.id}:${now}`,
            createdAt: now,
            kind: 'action',
            detail: { explain: verdict.headline, outcome: 'unseen' },
          })
        } catch (cause) {
          console.warn('okolos: could not journal an unseen download verdict', cause)
        }
      }
    },
  })
})

/**
 * The extension inventory is reviewed daily rather than on every wake-up: what
 * it looks for is an update that happened while nobody was watching, and that
 * does not need checking twice an hour.
 */
async function reviewExtensions(): Promise<void> {
  if (!platform.extensions.available()) return
  try {
    // Journals what it finds and records nothing else. Recording here would hide
    // the change from the screen the user has not opened yet, which is the same
    // defect on a twenty-four-hour clock.
    const deps = inventoryDeps(await openDb())
    await journalChanges(deps, await compareInventory(deps))
  } catch (cause) {
    console.warn('okolos: the extension review failed', cause)
  }
}

/** The `settings` store as a due-check's memory. */
async function settingsDueStore(): Promise<DueStore> {
  const db = await openDb()
  return {
    get: async (key) => {
      const row = await db.get('settings', key)
      return typeof row?.value === 'string' ? row.value : null
    },
    put: async (key, iso) => {
      await db.put('settings', { key, value: iso })
    },
  }
}

/**
 * The daily review, owed by a timestamp rather than by the alarm alone — the alarm
 * was reset by every wake-up before it could fire, and the review itself ran at the
 * top of this file on every wake (LC-08).
 */
async function reviewIfDue(): Promise<void> {
  try {
    await runIfDue(await settingsDueStore(), LAST_INVENTORY_KEY, INVENTORY_INTERVAL_MS, Date.now(), reviewExtensions)
  } catch (cause) {
    console.warn('okolos: could not decide whether the extension review is owed', cause)
  }
}

void reviewIfDue()
void platform.alarms.create(INVENTORY_ALARM, INVENTORY.periodInMinutes)
/**
 * Retention runs at start as well as on the alarm, and the start is the one
 * that can be relied on.
 *
 * `alarms.create` replaces an alarm of the same name, this line runs on every
 * service-worker start, and an MV3 worker starts many times a day — so the
 * twenty-four hour alarm on a browser in daily use is reset before it ever
 * fires. The journal screen promises that anything older than ninety days is
 * deleted; without this, that promise was enforced by an alarm that might
 * never arrive.
 *
 * A timestamp in storage does not care how often the worker restarts.
 */
async function sweepIfDue(): Promise<void> {
  try {
    const db = await openDb()
    const last = await db.get('settings', LAST_SWEEP_KEY)
    if (!dueForSweep(typeof last?.value === 'string' ? last.value : null, Date.now())) return
    await pruneExpired(db, Date.now())
    await db.put('settings', { key: LAST_SWEEP_KEY, value: new Date().toISOString() })
  } catch (cause) {
    // Retention failing must not stop the extension from starting. It is
    // reported rather than swallowed, and the next start tries again.
    console.warn('okolos: retention sweep at start failed', cause)
  }
}

/**
 * Pulls the blocking feed, applies it if it verifies, and installs the rules.
 *
 * Until this existed the `feeds` store was empty on every install: `updateFeed`
 * had no caller, `currentFeed()` returned null, and the number of blocking
 * rules was always zero. Everything below it — signature checking, replay
 * refusal, rollback, rule building — was built and tested and never reached.
 */
async function pullFeed(): Promise<void> {
  try {
    const db = await openDb()

    /**
     * Is a pull owed at all.
     *
     * This was missing, and the comment at the call site — "six hours, and once
     * at start: a worker that restarts often would otherwise keep resetting a
     * longer alarm, which is how retention came to never run" — names the exact
     * reason it had to be here. The retention sweep got the timestamp; the feed
     * got the "once at start" and nothing else. And the worker starts on nearly
     * every page, because a content script sends it a message.
     *
     * So instead of four requests a day the product made one per page, each
     * writing a row to `outbound_log` — the audit entry is mandatory *before* a
     * request leaves — and the self-audit panel, whose whole subject is what left
     * this device, filled with `feed-update`.
     *
     * The attempt is recorded **before** the sync rather than after it: a pull
     * that throws would otherwise leave no mark, and the next wake-up would try
     * again immediately. The flood, but only when something is already wrong.
     */
    const lastAttempt = await db.get('settings', LAST_FEED_KEY)
    if (!dueForFeed(typeof lastAttempt?.value === 'string' ? lastAttempt.value : null, Date.now())) {
      return
    }
    await db.put('settings', { key: LAST_FEED_KEY, value: new Date().toISOString() })

    /**
     * Asked before the request, not after it.
     *
     * There is no point downloading a list this engine cannot check, and there is
     * worse than no point in reporting the result as a signature failure — which
     * is what happened, because `Verifier` returns a boolean and an engine
     * without Ed25519 produces the same `false` as a forged signature. The
     * manifests now declare versions where the primitive exists, so this branch
     * should be unreachable in the field; it is here for the install that
     * ignores them, and because a guard whose only proof is a manifest is a
     * guard that stops holding the day someone loosens the manifest.
     */
    if (!(await canVerify(FEED_PUBLIC_KEY))) {
      await db.put('journal', {
        id: `feed:unverifiable:${new Date().toISOString()}`,
        createdAt: new Date().toISOString(),
        kind: 'error',
        detail: { reason: 'feed-sync', explainKey: 'feedNoVerifier', explainArgs: [] },
      })
      return
    }

    await syncFeed({
      audit: await auditDeps(),
      apply: async (signed) => {
        const result = await updateFeed(db, signed, createVerifier(FEED_PUBLIC_KEY), () =>
          new Date().toISOString(),
        )
        // The refusal's own key and arguments travel on, rather than a sentence
        // resolved here and substituted into another one (B-77).
        return result.accepted
          ? { accepted: true }
          : {
              accepted: false,
              explainKey: result.explainKey,
              explainArgs: result.explainArgs,
              explainArgKeys: result.explainArgKeys,
            }
      },
      refresh: () => refreshBlockRules(),
      note: async (note, diagnostic) => {
        await db.put('journal', {
          id: `feed:${new Date().toISOString()}`,
          createdAt: new Date().toISOString(),
          kind: 'error',
          // `diagnostic` beside the explanation, never inside it: the reader gets the
          // catalogue's sentence and, under it, the exception's own words (B-115).
          detail: {
            reason: 'feed-sync',
            ...note,
            ...(diagnostic === undefined ? {} : { diagnostic }),
          },
        })
      },
    })
  } catch (cause) {
    console.warn('okolos: feed sync failed', cause)
  }
}

/**
 * Six hours, and once at start — and "once at start" now means "if one is owed".
 *
 * The alarm alone cannot be trusted: `alarms.create` replaces an alarm of the
 * same name and this line runs on every worker start, so a six-hour alarm on a
 * browser in daily use is reset before it fires. That is why the start-time call
 * exists. What it lacked was the other half — the worker starts on nearly every
 * page, so an unconditional pull at start *is* a pull per page.
 */
void pullFeed()
void platform.alarms.create(FEED_ALARM, FEED.periodInMinutes)

void sweepIfDue()
void platform.alarms.create(RETENTION_ALARM, RETENTION.periodInMinutes)
platform.alarms.onFired((name) => {
  if (name === FEED_ALARM) {
    void pullFeed()
    return
  }
  if (name === INVENTORY_ALARM) {
    void reviewIfDue()
    return
  }
  if (name !== RETENTION_ALARM) return
  // The alarm still matters for a session that stays up for days, where no
  // restart would otherwise trigger the sweep.
  void sweepIfDue()
})
