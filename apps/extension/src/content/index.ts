import { sha1Hex } from '@okolos/core-credential'
import { checkLookalike, DEFAULT_WATCHLIST } from '@okolos/core-lookalike'
import { planSanitisation } from '@okolos/core-sanitizer'
import { t, useResolver } from '@okolos/i18n'
import { detectPlatform } from '@okolos/platform'
import {
  mountGate,
  type BannerHandle,
  type BannerHandlers,
  type BannerProps,
  mountInspector,
  type GateHandle,
  type InspectorHandle,
} from '@okolos/ui'
import { worstOf } from '@okolos/contracts'
import type {
  AgentAction,
  FrameFinding,
  FrameLine,
  Severity,
  GateChoice,
  UnresolvedFinding,
  Verdict,
} from '@okolos/contracts'

import { AgentGate } from './agent-gate.js'
import { createPacer } from './pace.js'
import { reportToEmbeddingPage } from './report-frame.js'
import { collect, DEFAULT_BUDGET } from './collect.js'
import { injectionDetail } from './warn-words.js'
import { warnIfLookalike } from './lookalike.js'
import { credentialDetail } from './credential-words.js'
import { passwordDetail, passwordLines, passwordSourceKey } from './password-words.js'
import { watchCredentialFields } from './credential.js'
import { showDownloadVerdict } from './download.js'
import { lentShadowRoot, watchForTraps } from './traps.js'
import { Sanitiser } from './sanitize.js'
import { createSurfaceSlot } from './surface-slot.js'
import { claimWithReceipt } from './password-receipt.js'
import { failOpen } from './fail-open.js'
import { createJournalOnce } from './journal-once.js'

/**
 * The content script: collect, ask the background for a verdict, warn.
 *
 * Everything here is wrapped so that a failure is silent to the page. A
 * security extension that throws inside someone's checkout is worse than one
 * that misses a finding, so every path fails open.
 */



const platform = detectPlatform()

/**
 * Before anything mounts.
 *
 * The three in-page surfaces ask the catalogue for every word they show. This
 * line is the whole reason they get words rather than `[bannerActionInjection]`
 * — and it was missing for one commit, which the browser caught and no unit
 * test could: the unit tests install a resolver themselves, so the surfaces
 * spoke Russian in the suite and identifiers on a real page.
 *
 * `tools/entry-resolver.test.ts` now fails the build when an entry point that
 * reaches `t()` does not install one.
 */
useResolver((key, substitutions) => platform.message(key, substitutions))

/**
 * Only the top frame shows a warning.
 *
 * The script runs in every frame because injections hide in iframes too, but a
 * banner mounted inside a subframe can be invisible, clipped, or duplicated
 * across a dozen ad frames. Subframes still collect and report; the top frame
 * is the one that speaks.
 *
 * **The reporting half was missing until 2026-08-20**, and this comment described
 * it anyway: the subframe neutralised, armed the gate and returned on
 * `if (!isTopFrame)`, so a poisoned iframe was handled and never mentioned. The
 * report now goes frame → background → top frame, and through the background on
 * purpose — a subframe could reach the top with `window.top.postMessage`, and that
 * message travels through the page's own window, where the page can forge it and
 * the top frame cannot tell an extension's report from a claim by the thing being
 * reported. See SCN-031.
 */
const isTopFrame = window.top === window

const sanitiser = new Sanitiser(document)

/**
 * How long a held action waits for a person. Long enough to read the modal and
 * look at the evidence; short enough that a page left open does not hold an
 * action forever. Running out blocks — never allows.
 */
const GATE_TIMEOUT_MS = 30_000

/**
 * What the gate treats as "the page is still compromised".
 *
 * A finding stops gating when the user has said the page is fine: dismissing
 * the banner or disputing the finding. Choosing to keep the text neutralised is
 * agreement that the page is hostile, so the gate stays on — as does restoring
 * the text, which puts the instruction back.
 */
/**
 * Findings on this page the user has not handled — `null` until the page has been
 * read at all.
 *
 * `[]` and "not asked yet" used to be the same value, and the gate read the
 * second as the first: between `document_idle` and the verdict returning it
 * answered "nothing unresolved here", which is an unrun check reported as a
 * passed one. The window is short and it is the window a page controls — it can
 * fire its scripted click on the first line of its own body.
 */
let unresolved: UnresolvedFinding[] | null = null

/**
 * Sixteen random hex characters, from an API that exists on an insecure page.
 *
 * `crypto.randomUUID` is `[SecureContext]`; `crypto.getRandomValues` is not.
 * That difference was a total fail-open on every `http://` page, because the id
 * was taken before the action was held.
 */
function randomId(): string {
  const bytes = new Uint8Array(8)
  crypto.getRandomValues(bytes)
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}
/** Kept so the gate can open the evidence for the finding it is asking about. */
let lastVerdicts: Verdict[] = []

let inspector: InspectorHandle | null = null
let gate: GateHandle | null = null

/**
 * One in-page warning panel, and one place that decides which finding holds it.
 *
 * Six modules used to mount their own, and on a page that was both a lookalike and
 * poisoned two panels were drawn at identical coordinates — one exactly on top of the
 * other (B-69). The slot also owns the re-mount watch, which had been wired into two
 * of those six sites: both are rules about the surface, and a rule about the surface
 * applied per source is the defect, not the fix.
 */
/**
 * One record per distinct fact, for this frame.
 *
 * The journal has a retention period, so repeated identical lines evict what happened
 * once. Three writers here could produce them — the standing restore refusal (B-64),
 * the slot's refused claims, and the scan's give-up — and all three go through this.
 * The screen is unaffected: a person pressing a button is answered every time.
 */
const journal = createJournalOnce()

const slot = createSurfaceSlot({
  doc: document,
  noteRefused: (kind, severity) => {
    // Not drawn is not lost: the popup and the journal hold every finding, and this
    // line is what makes the refusal readable afterwards rather than inferred. Once
    // per kind, because a page with several findings of one kind asks more than once.
    const explain = t('noteSecondWarning', kind, severity)
    void journal.record(`second:${kind}`, async () => {
      await platform.runtime.send('page/note', { kind: 'gate-unread', explain })
    })
  },
  alsoLine: (kinds) => t('warnAlsoHere', String(kinds.length)),
  mounted: () => {
    // From the navigation's time origin, which is what a person waited from. Wrapped
    // because a page can have taken the API away, and a missing measurement must not
    // be the reason a warning does not appear.
    try {
      performance.measure(MEASURE_TO_BANNER)
    } catch {
      // Nothing to report is better than a throw on the path to the surface.
    }
  },
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  escalate: async (removals) => {
    // The watch escalates once by construction, so this is belt and braces rather
    // than the flood guard the other two need.
    const explain = t('noteSurfaceRemoved', String(removals))
    await journal.record('surface-removed', async () => {
      await platform.runtime.send('page/note', { kind: 'surface-removed', explain })
    })
  },
})



/**
 * Performance marks are local to the page and never leave it. They exist so
 * the budget can be measured where it actually matters — in a real browser on
 * a real page — instead of being asserted against a synthetic DOM that has no
 * layout engine behind it.
 */
const MARK_START = 'okolos:collect:start'
const MARK_END = 'okolos:collect:end'
export const MEASURE_COLLECT = 'okolos:collect'

/**
 * The mark a scan leaves when it gave up rather than finished.
 *
 * The product already degrades honestly here — the RPC deadline fires, `failOpen`
 * journals "the check did not finish", and no banner appears. What was missing is a fact
 * an observer can read *in the page*: from outside, "no banner" looks the same whether
 * the relay is broken or the worker was too slow to answer (B-78).
 *
 * A mark rather than a journal line, because the journal lives in the extension's
 * database and reading it means opening another page — which changes what is being
 * diagnosed. This sits beside `okolos:collect`, in the same place, readable by the e2e
 * diagnosis and by anyone with devtools open.
 */
export const MARK_SCAN_FAILED = 'okolos:scan-failed'

/**
 * The collector gave up before anything was asked.
 *
 * A third state that looked exactly like the other two from outside, and it cost four CI
 * runs to name: the traversal stops, zero candidates come back, the scan journals "could
 * not finish" and **no RPC is sent at all**. The e2e report said "the verdict is what did
 * not arrive", which was false — nothing had been asked for. A report that names the wrong
 * link is worse than one that names none, because it sends the next reader down a corridor
 * that does not exist.
 */
export const MARK_BLINDED = 'okolos:scan-blinded'

/**
 * The walk was cut short — whatever it found.
 *
 * `MARK_BLINDED` is the narrower fact: cut short *and* nothing to ask about. This one is
 * marked whenever the traversal stopped at a ceiling, because "was this page read in full?"
 * is a question about every scan, and the answer was observable only when the answer was
 * also "and nothing was found". The banner says it in words when there is a finding, but
 * that text lives inside a closed shadow root in the shipping build, so no test outside the
 * extension could read it (measured 2026-08-21).
 */
export const MARK_PARTIAL = 'okolos:scan-partial'

/**
 * From the navigation to the warning being on screen — the number SCN-003 promises in
 * words and nothing measured.
 *
 * "Before the page settles" is a promise, not a figure, and the only thing anywhere
 * that said anything about this delay was a test's ten-second wait, written into
 * thirteen files and measured nowhere (B-65). Twice a CI run failed a spec that was
 * not about mounting because the banner had not arrived: `scn-010` on a cold runner and
 * `hostile-page` on a colour token.
 *
 * Measured from the navigation's own start rather than from when the content script
 * happened to run: what a person waits is from pressing enter, and the script's start
 * is part of that wait. `performance.measure` with no start mark uses the time origin,
 * which for a document *is* the navigation start.
 */
export const MEASURE_TO_BANNER = 'okolos:banner'

/**
 * The bridge to the MAIN-world watcher.
 *
 * It is armed only while this page carries a finding nobody has dealt with, so
 * an ordinary page pays nothing and no request anywhere is recorded without a
 * reason. The channel is `window.postMessage`, which the page can post on too:
 * a hostile page can therefore add entries that never happened. It cannot
 * remove the real ones, and a forged journal line costs noise rather than
 * silence — which is the right way round for a record.
 */
/**
 * Arms the watcher, and has no way to disarm it.
 *
 * There used to be a `disarm` on the same channel, and the watcher accepted it
 * from `event.source === window` — which the page's own `postMessage` satisfies.
 * One line of page script bought silence for the rest of the page's life, in the
 * one mechanism whose whole value is that a record exists. Arming stayed
 * forgeable and that is fine: ADR-0009 says the cost of a forged line is noise.
 *
 * Turning the watch off is now the background's business, where the page has no
 * vote: a report for an origin with no unresolved finding is dropped before
 * anything is written.
 */
function armPageWatch(on: boolean): void {
  if (!on) return
  try {
    window.postMessage({ source: 'okolos:page-watch:arm' }, '*')
  } catch {
    // The watcher stays as it was. It observes; nothing depends on it.
  }
}

window.addEventListener('message', (event) => {
  if (event.source !== window) return
  const data = event.data as { source?: unknown; method?: unknown; host?: unknown } | null
  if (data?.source !== 'okolos:page-watch:report') return
  if (typeof data.method !== 'string' || typeof data.host !== 'string') return
  void safely(async () => {
    await platform.runtime.send('page/request', { method: data.method as string, host: data.host as string })
  })
})

async function scan(): Promise<void> {
  const started = performance.now()
  performance.mark(MARK_START)
  const page = collect(document, {
    url: location.href,
    frameId: isTopFrame ? 0 : 1,
    budget: DEFAULT_BUDGET,
    elapsed: () => performance.now() - started,
  })
  performance.mark(MARK_END)
  performance.measure(MEASURE_COLLECT, MARK_START, MARK_END)

  // Before the branch, so it is true of every scan rather than only of the empty ones.
  if (page.truncated) performance.mark(MARK_PARTIAL)

  if (page.candidates.length === 0) {
    /**
     * Nothing found is not the same fact as nothing to find.
     *
     * A page can spend the whole traversal allowance on markup that carries nothing —
     * six thousand comments in `<head>` did exactly that — and the scan then returned
     * zero candidates and exited without a word: no banner, no record, and a person
     * believing the page had been checked (B-40).
     *
     * Journalled, not bannered. A banner on every large page would cry wolf, and the
     * journal is the surface this product already uses for "we looked and could not
     * finish" — `scan-failed` from B-74 is the same shape. Once per page, through the
     * same `journal.record` that keeps a mutating page from writing the same line all
     * afternoon.
     */
    if (page.truncated) {
      // In the page, beside `okolos:collect`, for the same reason `okolos:scan-failed`
      // is: from outside, "no banner" looks identical whether nothing was found, the
      // answer never came, or the walk stopped before asking.
      performance.mark(MARK_BLINDED)
      void journal.record('scan-blinded', async () => {
        await platform.runtime.send('page/note', {
          kind: 'scan-blinded',
          explain: t('noteScanBlinded'),
        })
      })
    }
    return
  }

  // Through the platform adapter, not chrome.runtime directly: Firefox's
  // `chrome` namespace is callback-based, so awaiting it there returns
  // undefined and the verdict is silently lost. The bug would have been
  // invisible in Chrome and total in Firefox.
  const response = await platform.runtime.send('page/candidates', page)

  const verdicts: Verdict[] = response?.verdicts ?? []
  if (verdicts.length === 0) return

  // Neutralise in every frame, including the ones that never show a banner: an
  // injection inside an iframe is read by an assistant just as readily as one
  // in the top document.
  const neutralised = sanitiser.apply(planSanitisation(verdicts))

  // The gate arms in every frame too. An agent acting on an instruction it read
  // in an iframe submits that iframe's form, and the top frame never sees it.
  lastVerdicts = verdicts
  // Assigned even when empty: this is the moment "not asked yet" becomes "asked,
  // and there is nothing", and those are different answers to the gate.
  unresolved = verdicts.map((verdict) => ({ id: verdict.id, summary: summarise(verdict) }))
  armPageWatch(unresolved.length > 0)

  if (!isTopFrame) {
    void tellEmbeddingPage(verdicts)
    return
  }
  show(worst(verdicts), verdicts.length, page.truncated, neutralised)
}

/**
 * The frame's obligation, wired to the policy that lives in `report-frame.ts`.
 *
 * The policy is a separate module for the reason the pacer is: how many times and how
 * far apart is a decision, and one nobody can call in a test is one nobody has checked.
 */
async function tellEmbeddingPage(verdicts: readonly Verdict[]): Promise<void> {
  await reportToEmbeddingPage(
    {
      kind: 'injection',
      origin: '',
      summary: summarise(worst(verdicts)).slice(0, 160),
      count: verdicts.length,
    },
    {
      relay: (report) => platform.runtime.send('frame/report', report),
      giveUp: async ({ attempts, seconds }) => {
        // Worded here, counted there: the note is dumped verbatim into the export
        // the user downloads, so it goes through the catalogue like any other
        // sentence they will read.
        await platform.runtime.send('page/note', {
          kind: 'frame-unreported',
          explain: t('frameUnreported', String(attempts), String(seconds)),
        })
      },
      wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    },
  )
}

/**
 * The one line the agent gate quotes as its evidence.
 *
 * It was an English template literal, and the gate is the surface a person meets
 * mid-decision: the whole panel was Russian around one English sentence, in a product whose
 * `default_locale` is `ru`. Found 2026-08-21 by rendering the gate and reading it — the
 * i18n sweep had called this file clean, because its anchor could not carry a sentence in
 * backticks with a nested double quote in it (fixed in the same change, and the anchor now
 * finds seven more).
 *
 * The snippet itself is not translated and must not be: it is the attacker's own text, and a
 * reader checking the page has to find the same characters.
 */
function summarise(verdict: Verdict): string {
  const snippet = verdict.evidence.find((item) => item.snippet)?.snippet
  return snippet ? t('contentHiddenTextQuoted', snippet.slice(0, 120)) : t('contentHiddenText')
}

function worst(verdicts: readonly Verdict[]): Verdict {
  // `worstOf` from the contract, not a local copy of the order: the background
  // needs the same ranking to name the worst finding in an embedded frame, and two
  // copies of four numbers agree with each other rather than with anything else.
  return worstOf(verdicts) as Verdict
}

/**
 * The warning for a finding the top frame never saw.
 *
 * Named by origin, because "something on this page" and "something in the frame
 * from ads.example" are different warnings and only the second one tells the reader
 * where to look. An empty origin — a `srcdoc` or `about:blank` frame, whose address
 * is not the frame's own — says "an embedded frame" instead of pretending to a name.
 */
function showFrameFinding(finding: FrameFinding): void {
  const where = finding.origin === '' ? t('warnFrameUnnamed') : finding.origin
  if (finding.kind === 'credential') {
    showFrameCredential(finding, where)
    return
  }
  if (finding.kind === 'password') {
    showFramePassword(finding, where)
    return
  }

  const more = finding.count > 1 ? t('warnFrameMore', String(finding.count - 1)) : ''

  slot.claim({
    kind: 'frame',
    severity: 'major',
    props: {
      variant: 'injection',
      severity: 'major',
      headline: t('warnFrameHeadline', where),
      detail: t('warnFramePlain', finding.summary, more),
      sourceLine: t('warnFrameSource'),
      primaryLabel: t('warnFrameJournal'),
    },
    handlers: {
      onPrimary: openFrameJournal,
      onRetry: openFrameJournal,
      onDispute: resolveEverything,
      onDismiss: resolveEverything,
    },
  })
}

/**
 * A password warning about a form that is not on this page, drawn on the page a person
 * is looking at.
 *
 * The three actions are the same three the in-page warning offers, and each is
 * expressible from here: "leave" goes back in the top frame, which is what leaving the
 * page carrying that form means; "this is wrong" trusts the frame's site, which is the
 * site the warning is about; "hide" resolves.
 *
 * The host is derived from the origin the **background** stamped, never from a field the
 * frame filled in. The frame is the thing being reported on, so a host it supplied would
 * let a poisoned frame nominate what gets trusted (`FrameFinding` in the contract says
 * the same thing from the other end). An origin with no host — `about:blank`, a `data:`
 * document — leaves nothing to trust, and the button then only hides the warning rather
 * than pretending to record a decision.
 */
function showFrameCredential(
  finding: Extract<FrameFinding, { kind: 'credential' }>,
  where: string,
): void {
  const host = hostOf(finding.origin)

  slot.claim({
    kind: 'frame-credential',
    severity: finding.severity,
    props: {
      variant: 'credential',
      severity: finding.severity,
      headline: t('warnCredentialFrameHeadline', where),
      detail: credentialDetail(finding.lines),
      sourceLine: t('warnFoundBy', t('warnCredentialFrameSource')),
    },
    handlers: {
      onPrimary: () => history.back(),
      onRetry: () => history.back(),
      onDispute: () => {
        if (host !== null) {
          void platform.runtime.send('trust/add', { domain: host }).catch(() => undefined)
        }
        resolveEverything()
      },
      onDismiss: resolveEverything,
    },
  })
}

/**
 * A leak verdict about a password submitted from a frame, drawn on the page a person is
 * looking at.
 *
 * The primary action is the one this banner promised and did not perform for two
 * releases: it opens the site's change-password page. `/.well-known/change-password` is a
 * published standard — a site that supports it redirects to its real page, and one that
 * does not shows its own 404, which is still the site's answer rather than ours. The
 * options page has always done this (`options/index.ts`); the in-page banner had four
 * handlers that all returned `undefined`, so "Сменить пароль" was a label with nothing
 * behind it (found while closing B-80).
 *
 * The host comes from the origin the **background** stamped, never from the frame: the
 * password was sent to the site in the frame, so that is the site whose change-password
 * page this opens, and a frame that could name itself could send somebody to a page of
 * its choosing.
 */
function showFramePassword(
  finding: Extract<FrameFinding, { kind: 'password' }>,
  where: string,
): void {
  const host = hostOf(finding.origin)
  claimPasswordBanner({
    detail: passwordDetail(finding.lines),
    offline: finding.offline,
    host,
    // The host, not the whole origin: "the password sent to sso.partner.test" reads as a
    // sentence, "the password sent to https://sso.partner.test" reads as a log line. The
    // caller's `where` is the fallback for a frame with no address of its own.
    headline: t('warnPasswordFrameHeadline', host ?? where),
  })
}

/**
 * The one place the leak banner is built, for both the page's own form and a frame's.
 *
 * Shared rather than duplicated because the actions are the shared part: the surface
 * differs only in whose host it is about and which headline says so.
 */
function claimPasswordBanner(finding: {
  detail: string
  offline: boolean
  host: string | null
  headline: string
}): void {
  /**
   * The receipt, and **when** it is sent is the whole design.
   *
   * The background holds a compromised verdict until a surface says it drew it, because
   * the navigation a submission itself causes takes the asking document with it (B-82).
   * A first version sent this the instant the banner was claimed — and that receipt was a
   * lie: the answer came back to the document that was already navigating away, which
   * drew a banner nobody could read and then reported success. Measured, not reasoned: the
   * verdict was in the journal and the held copy was gone, so the next page showed
   * nothing.
   *
   * So the receipt waits for the panel to still be there after a moment. A document being
   * replaced does not survive `RECEIPT_DWELL_MS`; one a person is looking at does. Pressing
   * any control sends it at once — that is a person having read it, which is what the
   * receipt is actually about.
   *
   * And it is sent only for a panel that was drawn, which `claimWithReceipt` holds and
   * `password-receipt.test.ts` pins through the real slot (round 2 of the B-165
   * certification: a refused claim sent it too, and the held copy was lost).
   */
  claimWithReceipt(
    {
      mount: slot.mountFor('password', 'major'),
      send: () => {
        void platform.runtime.send('password/shown', {}).catch(() => undefined)
      },
      dwellMs: RECEIPT_DWELL_MS,
      /**
       * The document saying it is going away, which is the one signal that settles this
       * without a race. A timer alone cannot tell a navigation that commits in 200 ms from
       * one that commits in three seconds, and the second kind sent the receipt from a
       * document about to disappear — measured, and it is why the landing page showed
       * nothing.
       *
       * `pagehide` rather than `beforeunload`: the latter is ignored without user
       * interaction in Chrome and blocks the back-forward cache.
       */
      onPageHide: (stop) => addEventListener('pagehide', stop, { once: true }),
    },
    {
      variant: 'password',
      severity: 'major',
      headline: finding.headline,
      detail: finding.detail,
      sourceLine: t('warnFoundBy', t(passwordSourceKey(finding.offline))),
      /**
       * A control that cannot do what it says must not say it.
       *
       * With no host — a `srcdoc` or `about:blank` frame — there is no change-password
       * page to open, so the panel offers the journal instead of a button that would
       * navigate to `https:///.well-known/change-password` and fail silently. Not the
       * dismiss control, which the banner already draws: a second button labelled
       * "Скрыть" is not an action, it is the same one twice.
       */
      ...(finding.host === null ? { primaryLabel: t('warnFrameJournal') } : {}),
    },
    {
      onPrimary: () => {
        if (finding.host === null) {
          openFrameJournal()
          return
        }
        // Asked of the background, not done here: `chrome.tabs` is not in a content
        // script's API surface, so `platform.tabs.create` would reject and this control
        // would go back to doing nothing — quietly, which is how it got here.
        void platform.runtime
          .send('password/change', { host: finding.host })
          .catch(() => undefined)
      },
      onRetry: () => undefined,
      onDispute: resolveEverything,
      onDismiss: resolveEverything,
    },
  )
}

/**
 * How long a leak banner has to stand before the product calls it delivered.
 *
 * The correctness does not rest on this number — `pagehide` cancels the receipt whenever
 * the document is actually leaving, whether that happens in 200 ms or three seconds. What
 * the number decides is the remaining case: a navigation so slow that the banner has been
 * readable on the old page for longer than this, which counts as having been shown. A
 * second and a half is long enough to read one sentence and short enough that nobody sees
 * the same verdict twice for the sake of it.
 */
const RECEIPT_DWELL_MS = 1_500

/** The verdict this document is already showing, so a repeat push changes nothing. */
let shownVerdict: string | null = null

/**
 * Draws a leak verdict and tells the background it was drawn.
 *
 * The confirmation is what stops the held copy from arriving twice: the background keeps
 * the verdict until a surface says it showed it, because the alternative — a timeout —
 * cannot tell "nobody drew it" from "somebody drew it slowly". If this document is torn
 * down before the confirmation lands, the verdict is still waiting for the next one,
 * which is exactly the case B-82 is about.
 */
function showPasswordVerdict(
  host: string,
  verdict: Parameters<typeof passwordLines>[0],
  offline: boolean,
): void {
  /**
   * A repeat of the verdict this document is already showing is ignored.
   *
   * The background pushes until a surface confirms, and its gap is shorter than the
   * confirmation's dwell — so without this, every push would restart the dwell and the
   * confirmation would never be sent. Not a coincidence to be tuned around: the two
   * numbers belong to different sides and should be free to move.
   */
  const mark = `${host}\u0000${verdict.explain.code}`
  if (mark === shownVerdict) return
  shownVerdict = mark

  claimPasswordBanner({
    detail: passwordDetail(passwordLines(verdict)),
    offline,
    host: host === '' ? null : host,
    headline: t('warnPasswordFrameHeadline', host === '' ? t('warnFrameUnnamed') : host),
  })
}

/** The host inside an origin, or null when the origin names no host. */
function hostOf(origin: string): string | null {
  try {
    const host = new URL(origin).hostname
    return host === '' ? null : host
  } catch {
    return null
  }
}

function openFrameJournal(): void {
  void platform.runtime.send('recovery/open', { kind: 'journal' }).catch(() => undefined)
}

function show(verdict: Verdict, total: number, partialScan: boolean, neutralised: number): void {

  slot.claim({
    kind: 'injection',
    severity: verdict.severity,
    props: {
      variant: 'injection',
      severity: verdict.severity,
      headline: t('warnInjectionHeadline'),
      // Assembled in `warn-words.ts`, where a test can read it: three facts go into this
      // line and one of them — whether the page was read in full — had none.
      detail: injectionDetail(total, partialScan, neutralised),
      sourceLine: t('warnFoundBy', verdict.sources.map((s) => s.name).join(', ')),
    },
    handlers: {
      onPrimary: () => openInspector(verdict),
      onRetry: () => openInspector(verdict),
      onDispute: resolveEverything,
      onDismiss: () => {
        closeInspector()
        resolveEverything()
      },
    },
  })
}

/** The user has said this page is fine. The gate stands down with the banner. */
/**
 * The mount every other content module is given, so none of them can draw beside the
 * panel that is up. `kind` is the variant, which is what a reader would call it.
 */
function warningMount(kind: string, severity: Severity) {
  return (props: BannerProps, handlers: BannerHandlers): BannerHandle =>
    slot.claim({ kind, severity, props, handlers })
}

function resolveEverything(): void {
  unresolved = []
  armPageWatch(false)
  slot.release()
}

/**
 * Turns a restore's outcome into a sentence, or null when it finished.
 *
 * Two ways the page moves underneath one, and they read differently to the
 * person holding the button: the element left the page, or the page wrote its
 * own content into it. Neither is a failure of the product, and both are worth
 * saying out loud.
 */
/**
 * What a restore managed, in the reader's language.
 *
 * **It was English, with English pluralisation, on a ru-default interface.**
 * `1 passage was / 2 passages were`, `it / them`, `1 was / 2 were` — three grammatical
 * choices no Russian sentence can borrow, and the sweep could not see any of them
 * because the literal begins with `${outcome.gone}` (B-51).
 *
 * **Worded to need no agreement at all, which is a decision and not a shortcut.**
 * Russian needs three plural forms where English needs two, `chrome.i18n` has no
 * plural support, and picking the form in code means either hardcoding one language's
 * grammar or trusting `Intl.PluralRules` to agree with the locale `chrome.i18n`
 * actually resolved. Both are machinery around a problem the copy can simply not have:
 * "не вернулось фрагментов: 3" reads correctly for every count, and so does "left
 * alone: 1". The brand pack prefers the form that needs no grammar games.
 */
function explainRestore(outcome: { restored: number; gone: number; changed: number }): string {
  const parts: string[] = []
  if (outcome.gone > 0) parts.push(t('contentRestoreGone', String(outcome.gone)))
  if (outcome.changed > 0) parts.push(t('contentRestoreChanged', String(outcome.changed)))
  const restored =
    outcome.restored > 0
      ? t('contentRestoreDone', String(outcome.restored))
      : t('contentNothingRestored')
  return `${restored}${parts.join('; ')}.`
}

function openInspector(verdict: Verdict, restoreNote?: string): void {
  inspector?.destroy()
  inspector = mountInspector(
    document,
    {
      evidence: verdict.evidence,
      confidence: verdict.confidence,
      ...(restoreNote ? { restoreNote } : {}),
    },
    {
      onKeep: closeInspector,
      onRestore: () => {
        const outcome = sanitiser.restore()
        const unfinished = outcome.gone + outcome.changed
        if (unfinished === 0) {
          closeInspector()
          return
        }

        // Not a dismissal. The panel stays with a sentence saying what could
        // not be put back, because closing on a restore that did not happen is
        // how the user learns the button does nothing.
        const note = explainRestore(outcome)
        // The sentence, every press. That is the screen's contract and B-36's whole
        // point: a refusal is a standing fact about the page, and every press must say
        // the same thing rather than the second one retracting the first.
        openInspector(verdict, note)
        // The record, once. Ten presses on one node used to be ten identical journal
        // lines, evicting what happened once from a store with a retention period.
        void journal.record(`restore:${note}`, async () => {
          await platform.runtime.send('page/note', { kind: 'restore', explain: note })
        })
          .catch(() => undefined)
      },
      onDispute: () => {
        closeInspector()
        resolveEverything()
      },
      onClose: closeInspector,
    },
  )
}

function closeInspector(): void {
  inspector?.destroy()
  inspector = null
}

/**
 * The pace at which a mutating page is re-read.
 *
 * The policy lives in `pace.ts` and is tested there. What it replaced held the
 * same three numbers in module variables and *dropped* an over-budget scan,
 * which meant a page that mutated hard and then went quiet was never examined
 * in its final state.
 */
const pacer = createPacer({
  now: () => Date.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (handle) => clearTimeout(handle),
  run: () => void safely(scan),
})

function rescanSoon(): void {
  pacer.request()
}

/** The project's fail-open wrapper, wired to this frame's console and journal. */
async function safely(work: () => Promise<void>): Promise<void> {
  await failOpen(work, {
    warn: (cause) => {
      // A fact in the page, next to `okolos:collect`, so "no banner" can be told from
      // "the check never finished" by anyone reading from outside (B-78).
      performance.mark(MARK_SCAN_FAILED)
      console.warn('okolos: scan failed', cause)
    },
    note: async (cause) => {
      /**
       * The journal, not the badge: a worker restart is ordinary, and an icon that
       * cries wolf on every one of them is how a badge stops meaning anything.
       *
       * Once per distinct cause: a page that mutates while the worker is unavailable
       * fails its rescan over and over, and the same sentence repeated is the flood
       * this store cannot afford. A *different* cause is new information and is written.
       */
      const explain = t('noteScanFailed')
      const diagnostic = String(cause)
      // Keyed on the *cause*, not on the sentence: the sentence is the same every time now
      // that the cause is not inside it, so keying on it would journal the first failure of
      // a page and silence every different one after it.
      await journal.record(`scan:${diagnostic}`, async () => {
        await platform.runtime.send('page/note', { kind: 'scan-failed', explain, diagnostic })
      })
    },
  })
}

/**
 * The gate is installed once, on every frame, and costs nothing until a finding
 * appears: with `unresolved` empty it returns on the first line of every click.
 */
new AgentGate({
  doc: document,
  unresolved: () => unresolved,
  /**
   * An action that went through before this page had been read.
   *
   * Not held: holding every click on every page for the length of a scan is how
   * an extension becomes the thing that broke the web. Recorded, because the
   * third option — passing silently, as though the page had been read and found
   * clean — is the one ADR-0004 forbids.
   */
  noteUnread: (action) => {
    void platform.runtime
      .send('page/note', {
        kind: 'gate-unread',
        explain: t('logGateUnread', action.description),
      })
      .catch(() => undefined)
  },
  // Read at the moment of the action, not once at load: a page cannot change
  // this, but reading it late costs nothing and keeps the fact current.
  automated: () => navigator.webdriver === true,
  ask: askTheUser,
  expiry: () =>
    new Promise((resolve) =>
      setTimeout(() => {
        // Take the surface down with the deadline. A modal left standing after
        // the action was already blocked is a page the user cannot use.
        closeGate()
        resolve()
      }, GATE_TIMEOUT_MS),
    ),
  journal: (decision) => {
    void platform.runtime.send('gate/decision', decision).catch(() => {
      // The journal is best-effort; the decision has already been enforced.
    })
  },
  /**
   * An id that exists on an insecure page too.
   *
   * `crypto.randomUUID` is `[SecureContext]` and the manifest matches
   * plain-HTTP pages, so this used to throw `TypeError` on every plain-HTTP page —
   * inside `#describe`, before `preventDefault`, which meant the gate let the
   * action through on exactly the pages a poisoned document is cheapest to serve
   * from. `getRandomValues` carries no such restriction.
   */
  newId: () => randomId(),
}).install()

function askTheUser(
  action: AgentAction,
  findings: readonly UnresolvedFinding[],
): Promise<GateChoice> {
  // One gate, one action. A second interception arriving while a question stands
  // used to overwrite `gate` and mount a second panel in the same coordinates: two
  // dialogs stacked, the first host leaked out of reach of `closeGate`, and whichever
  // button the reader pressed answered the question on top about an action the panel
  // underneath had named. The slot is claimed, not stacked — the second action is
  // refused, and the journal records that a question was already open (B-123).
  if (gate !== null) return Promise.resolve('already-asking')
  return new Promise((resolve) => {
    gate = mountGate(
      document,
      {
        action: action.description,
        ...(action.target === undefined ? {} : { target: action.target }),
        findings: findings.map((finding) => finding.summary),
        timeoutSeconds: GATE_TIMEOUT_MS / 1000,
      },
      {
        onBlock: () => {
          closeGate()
          resolve('block')
        },
        onAllowOnce: () => {
          closeGate()
          resolve('allow-once')
        },
        onShowInjection: () => {
          // The gate stays up behind the evidence: looking is not deciding.
          const verdict = lastVerdicts.find((item) => item.id === findings[0]?.id)
          if (verdict) openInspector(verdict)
        },
      },
    )
  })
}

function closeGate(): void {
  gate?.destroy()
  gate = null
}

/**
 * The address check runs once, before anything else and only in the top frame:
 * it is about the page the user believes they are on, and a subframe is not
 * that page.
 */
if (isTopFrame) {
  void warnIfLookalike({
    mountWarning: warningMount('lookalike', 'major'),
    doc: document,
    hostname: () => location.hostname,
    trusted: async () => (await platform.runtime.send('trust/list', {}))?.domains ?? [],
    trust: async (host) => {
      await platform.runtime.send('trust/add', { domain: host })
    },
    leave: () => history.back(),
  }).catch(() => {
    // An address that could not be checked is not an address declared safe;
    // nothing is shown either way, and the page is left alone.
  })
}

/**
 * Trap watching runs only in the top frame and only where a person is looking:
 * a ClickFix banner inside a hidden ad frame warns nobody, and the fullscreen it
 * would try to leave is not the fullscreen the user is trapped in.
 */
if (isTopFrame) {
  watchForTraps({
    // `mountFor`, not `warningMount`: the watcher must know when the panel is not its
    // own, or it keeps another module's panel and stops raising its own (B-165 round 1).
    mountWarning: slot.mountFor('trap', 'critical'),
    shadowRootOf: lentShadowRoot,
    // Trusted sites, the list the lookalike and login-form warnings obey: a link on a
    // trusted site is not stopped (SCN-049, round 2 of the B-165 certification).
    trusted: async () =>
      ((await platform.runtime.send('trust/list', {}))?.domains ?? []).includes(location.hostname),
    doc: document,
    text: () => document.body?.innerText ?? '',
    leave: () => history.back(),
    recover: (kind) => {
      void platform.runtime.send('recovery/open', { kind }).catch(() => undefined)
    },
    warned: (kind, signals) => {
      void platform.runtime
        .send('trap/warned', { kind, signals: signals.join(',') })
        .catch(() => undefined)
    },
    exitFullscreen: () => {
      void document.exitFullscreen?.().catch(() => {
        // The browser refused. The warning still stands and still says the way
        // out is to close the tab.
      })
    },
  })
}

/**
 * The password pause, in every frame — and only the top frame draws it.
 *
 * For two releases this stood under `if (isTopFrame)`, and the comment claimed a
 * subframe's form "is warned about by the frame it is in" — which that very condition
 * prevented: the content script runs in every frame, and in a subframe `isTopFrame` is
 * false, so the block was skipped there too. An OAuth or payment form in an iframe —
 * the ordinary shape, not the exotic one — was watched by nobody (B-79).
 *
 * The restriction was half right, and the half that was right is kept. A banner inside a
 * small frame is clipped, invisible, or drawn once per ad frame, so a frame must not
 * draw. It can report, which is what the injection side has done since B-34, and the
 * relay carries a kind now so a password warning keeps its facts on the way up.
 *
 * `trust` and `leave` are unreachable on the frame's path — `report` returns before the
 * mount — and are passed anyway rather than stubbed: a dependency that lies about what it
 * would do is worse than one nothing calls. The surface that does draw offers both, bound
 * to the frame's site rather than to the frame.
 */
watchCredentialFields({
  ...(isTopFrame
    ? { mountWarning: warningMount('credential', 'major') }
    : { report: tellEmbeddingPageOfPassword }),
  doc: document,
  host: () => location.hostname,
  now: () => new Date().toISOString(),
  facts: async (host) => {
    const known = await platform.runtime.send('site/facts', { host })
    const trusted = (await platform.runtime.send('trust/list', {}))?.domains ?? []
    return {
      trusted: known?.trusted ?? trusted.includes(host),
      firstSeen: known?.firstSeen ?? null,
      // The frame's own protocol and host, deliberately: the site asking for the
      // password is the one inside the frame, and a page served over https can embed a
      // login form that is not.
      secure: location.protocol === 'https:',
      postsTo: null,
      resembles: checkLookalike(host, [...DEFAULT_WATCHLIST, ...trusted])?.resembles ?? null,
    }
  },
  trust: async (host) => {
    await platform.runtime.send('trust/add', { domain: host })
  },
  leave: () => history.back(),
})

/**
 * A frame handing its password warning to the page that embeds it.
 *
 * Same policy as the injection report — twelve attempts, nine seconds — because the
 * receiver is absent rather than broken, and a warning delivered to nobody is the
 * silence this whole channel exists to end. What is different is the journal line when
 * the budget runs out: "a finding could not be relayed" and "a password warning could
 * not be relayed" are different losses, and a reader of the export must be able to tell
 * which one happened.
 */
function tellEmbeddingPageOfPassword(finding: {
  severity: 'critical' | 'major' | 'minor'
  lines: FrameLine[]
}): void {
  void reportToEmbeddingPage(
    { kind: 'credential', origin: '', severity: finding.severity, lines: finding.lines },
    {
      relay: (report) => platform.runtime.send('frame/report', report),
      giveUp: async ({ attempts, seconds }) => {
        await platform.runtime.send('page/note', {
          kind: 'credential-unreported',
          explain: t('credentialUnreported', String(attempts), String(seconds)),
        })
      },
      wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    },
  ).catch(() => undefined)
}

/**
 * A frame handing its leak verdict to the page that embeds it.
 *
 * Same policy as the other two reports — twelve attempts, nine seconds — because the
 * receiver is absent rather than broken. Its own journal kind: the pause before a
 * password and a verdict on a password already sent are different events with different
 * remedies, and the journal is queried by kind.
 */
function tellEmbeddingPageOfLeak(lines: FrameLine[], offline: boolean): void {
  void reportToEmbeddingPage(
    { kind: 'password', origin: '', lines, offline },
    {
      relay: (report) => platform.runtime.send('frame/report', report),
      giveUp: async ({ attempts, seconds }) => {
        await platform.runtime.send('page/note', {
          kind: 'password-unreported',
          explain: t('passwordUnreported', String(attempts), String(seconds)),
        })
      },
      wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    },
  ).catch(() => undefined)
}

/**
 * The password check runs on submit, on the digest, never on the password.
 *
 * SHA-1 is computed here in the page's own context; what crosses into the
 * extension is forty hex characters, and what leaves the device is the first
 * five of them. The check is deliberately after submission: warning someone
 * before they have finished typing interrupts a login they were going to
 * complete anyway.
 *
 * **In every frame, and only the top frame draws** (B-80). This stood under
 * `if (isTopFrame)` for two releases, so a password submitted from an iframe — an OAuth
 * or payment form, the ordinary shape — was never checked against a breach and never
 * counted towards reuse. The half of the restriction that was right is kept: a banner
 * inside a frame nobody can see is not a warning, so a frame reports and the top frame
 * draws, over the relay that carries a kind (`FrameFinding`).
 *
 * The digest is computed in the frame and `location.host` is the frame's own, which is
 * correct twice over: the frame's site is the one that received the password, and it is
 * the site "where else do I use this" has to be answered about.
 */
document.addEventListener(
  'submit',
  (event) => {
    const form = event.target
    if (!(form instanceof HTMLFormElement)) return
    const field = form.querySelector<HTMLInputElement>('input[type=password]')
    const value = field?.value
    if (!value) return

    void (async () => {
      try {
        /**
         * Our own SHA-1, not the platform's.
         *
         * `crypto.subtle` is `[SecureContext]` and the manifest matches
         * plain-HTTP pages, so on any of them this line used to throw and the
         * `catch` below swallowed it: **the breach and reuse check did not run
         * at all**, on exactly the pages where a password sent in the clear
         * matters most. Nobody learned, because the catch says nothing.
         * Measured 2026-08-20 by scanning the shipped bundle for
         * secure-context APIs, which is now a gate.
         *
         * `packages/core-credential/src/sha1.ts` is checked against the
         * standard vectors *and* against the platform's own digest, so
         * "identical answer, one fewer requirement" is a test rather than a
         * hope.
         */
        const sha1 = sha1Hex(value)

        // The host travels with the digest: it is what makes "where else do I use
        // this" answerable, and it is already the address of the page the user
        // is looking at.
        const verdict = await platform.runtime.send('password/check', {
          sha1,
          host: location.host,
        })
        if (!verdict?.compromised) return

        const lines = passwordLines(verdict)

        // A frame reports rather than draws, and the words are not decided here: keys
        // travel and the surface that draws them resolves them.
        if (!isTopFrame) {
          tellEmbeddingPageOfLeak(lines, verdict.offline)
          return
        }

        claimPasswordBanner({
          detail: passwordDetail(lines),
          offline: verdict.offline,
          // Normalised the way the frame's origin is: an empty host is "no host", not a
          // host that happens to be the empty string, and `https:///…` goes nowhere.
          host: location.host === '' ? null : location.host,
          headline: t('warnPasswordHeadline'),
        })
      } catch (cause) {
        /**
         * A failed check is not a clean password, and it is not a broken login
         * either: the submission has already gone through. What it must not be
         * is invisible — a check that did not run and a check that passed
         * looked identical from here, for every password on every http page.
         */
        void platform.runtime
          .send('page/note', {
            kind: 'password-unchecked',
            explain: t('logPasswordUnchecked'),
            // Beside the sentence, not inside it: the journal draws it as its own line (B-115).
            diagnostic: String(cause),
          })
          .catch(() => undefined)
      }
    })()
  },
  true,
)

/**
 * The worker judges a download and has nowhere to say so; this is where it is
 * said. Top frame only — a banner about a file belongs on the page the person
 * is looking at, not in whatever advertisement frame happens to be listening.
 */
if (isTopFrame) {
  platform.runtime.onMessage((message) => {
    if (message.type === 'download/verdict') {
      showDownloadVerdict(message.payload as never, {
        mountWarning: warningMount('download', 'major'),
        doc: document,
        openJournal: () => {
          void platform.runtime.send('recovery/open', { kind: 'journal' }).catch(() => undefined)
        },
        discard: (downloadId) =>
          platform.runtime
            .send('download/discard', { downloadId })
            .then((answer) => answer.ok)
            .catch(() => false),
      })
      return Promise.resolve({ ok: true }) as never
    }

    /**
     * A finding in an embedded frame, reported by the background because the frame
     * cannot report it itself without going through the page's own window — where
     * the page could forge it.
     *
     * **The rule this recorded is now the slot's, for every source.** It said: if the
     * page already has a banner up for its own finding, the frame's is left to the
     * journal rather than drawn as a second overlay. That was right and it was applied
     * here only — two other sources kept mounting a second panel, which is how a page
     * that was both a lookalike and poisoned ended up with one warning drawn exactly
     * on top of another (B-69). The claim below goes to the same slot as everything
     * else: a `major` finding does not displace a worse one, and it becomes a line on
     * the panel that is up instead of a panel beside it.
     */
    if (message.type === 'frame/finding') {
      showFrameFinding(message.payload as FrameFinding)
      return Promise.resolve({ ok: true }) as never
    }

    /**
     * A verdict pushed the moment it was reached, for the document that is here now.
     *
     * The pair to the question this document asks as it starts: a document that started
     * before the check answered is told nothing by that question, and this is what
     * reaches it (B-82). Drawing twice is prevented where the drawing happens, not here.
     */
    if (message.type === 'password/verdict') {
      const pushed = message.payload as {
        host: string
        verdict: Parameters<typeof passwordLines>[0] & { offline: boolean }
      }
      showPasswordVerdict(pushed.host, pushed.verdict, pushed.verdict.offline)
      return Promise.resolve({ ok: true }) as never
    }

    return undefined
  })
}

/**
 * Does this tab hold a leak verdict nobody has been shown?
 *
 * Asked once as this document starts, because the document that asked for the check may
 * not have survived to hear the answer: a form with an `action` navigates, and the check
 * runs after the submission by design (B-82). Asked rather than waited for — a push with
 * a retry budget lived in the service worker, and a service worker is torn down when the
 * browser decides, which made a security warning arrive most of the time and is the worst
 * property such a warning can have.
 *
 * Top frame only, because this draws and only the top frame draws.
 */
if (isTopFrame) {
  void platform.runtime
    .send('password/pending', {})
    .then((held) => {
      if (held) showPasswordVerdict(held.host, held.verdict, held.verdict.offline)
    })
    .catch(() => {
      // Nothing to show and nothing to say: the verdict, if there is one, is in the
      // journal either way, and a page is never told that a question of ours failed.
    })
}

void safely(scan)
new MutationObserver(rescanSoon).observe(document.documentElement, {
  childList: true,
  subtree: true,
  characterData: true,
})
