import { t } from '@okolos/i18n'
import { classifyOutsideLink, detectClickFix, detectTechSupport, type OutsideLinkVerdict } from '@okolos/core-traps'
import { mountBanner, type BannerHandle, type BannerHandlers, type BannerProps } from '@okolos/ui'

/**
 * Watching for the traps that work on the person rather than the browser.
 *
 * Both warnings interrupt, which nothing else here does. That is deliberate:
 * the user is mid-way into the trap and one action from harm — a paste into a
 * run box, a phone call — and an advisory banner they can scroll past is not a
 * warning at that moment.
 *
 * Both are also honest about their reach. A copy made through
 * `navigator.clipboard` in the page's own world is invisible from here, and so
 * are the dialogs a tech-support page loops; what this sees is the `copy` event
 * the browser dispatches, the fullscreen it can leave, and the page's wording.
 * Where it cannot see, it says so instead of implying it handled it.
 */

/** What a raised warning is journalled as: `background/index.ts` maps each to a message. */
export type TrapKind = 'clickfix' | 'techsupport' | 'outside-link'

export interface TrapDeps {
  readonly doc: Document
  text(): string
  leave(): void
  recover(kind: 'clickfix' | 'techsupport'): void
  exitFullscreen(): void
  /**
   * Called when a warning is raised, with what it rests on: once per panel for ClickFix
   * and tech-support, and once per link per page for a link that leaves the browser,
   * however often it is clicked, so a page cannot fill the journal by clicking.
   */
  warned?: (kind: TrapKind, signals: readonly string[]) => void
  /**
   * How a warning reaches the screen.
   *
   * Injected rather than imported so every source passes through the same slot. Six
   * modules mounted their own banner, and on a page that was both a lookalike and
   * poisoned two of them drew panels at identical coordinates — one exactly on top of
   * the other, the lower one unreadable (B-69). "One in-page panel" is a rule about
   * the surface, not about the source, so it cannot live in any one source.
   *
   * Optional so a test can leave it out and get the real thing; the entry point always
   * supplies the slot.
   *
   * Null when another module's warning holds the panel and this one was not drawn (the
   * slot puts it on that panel as an "also here" line). The watcher must not keep that
   * panel as its own: it decides from its own panel what else may be raised.
   *
   * `onReleased` is called when the panel goes by another hand (the inspector's "This
   * is wrong" releases the whole slot): the watcher then forgets it held anything, or it
   * stopped every later outside link with no panel and left ClickFix silent (round 2 of
   * the B-165 certification).
   */
  mountWarning?: (
    props: BannerProps,
    handlers: BannerHandlers,
    onReleased?: () => void,
  ) => BannerHandle | null
  /**
   * The shadow root behind an element, closed ones included, where the browser lends it
   * to an extension (`chrome.dom.openOrClosedShadowRoot`, `Element.openOrClosedShadowRoot`
   * in Firefox). A click on a link inside a closed root reaches the document with the
   * host as its target and the link missing from the composed path too.
   */
  shadowRootOf?: (element: Element) => ShadowRoot | null
  /**
   * Whether this site is in Trusted sites, the person's own list the lookalike and
   * login-form warnings already obey. A trusted site's links go through unstopped
   * (round 2: an intranet serving Office documents over http met the warning on every
   * "open in the desktop app" link). Read at start and again after each stopped click,
   * because the click itself cannot wait for an answer; until the first answer, and
   * when it fails, the site counts as not trusted.
   */
  trusted?: () => Promise<boolean>
}

export interface TrapWatcher {
  stop(): void
}

const RECHECK_MS = 400

/** The injected mount, or the real one when a caller did not supply a slot. */
function mounting(deps: {
  readonly doc: Document
  mountWarning?: TrapDeps['mountWarning']
}) {
  return (props: BannerProps, handlers: BannerHandlers, onReleased: () => void): BannerHandle | null =>
    deps.mountWarning === undefined
      ? mountBanner(deps.doc, props, handlers)
      : deps.mountWarning(props, handlers, onReleased)
}

const LINK = 'a[href], area[href]'

/**
 * Different outside links journalled per page. Every click is still stopped; a page
 * clicking `search-ms:query=1`, `=2`, … wrote one "What changed" row per address
 * (product reading, round 2). Past this the journal stays quiet for the page, with no
 * summary row: SCN-049 says so.
 */
const JOURNAL_LINKS_MAX = 5

export function watchForTraps(deps: TrapDeps): TrapWatcher {
  const mount = mounting(deps)
  /** The panel this watcher drew and still holds; never another module's. */
  let banner: BannerHandle | null = null
  /** Which warning `banner` is. */
  let holding: TrapKind | null = null
  /** Where the person's focus was when the link warning opened, to give it back. */
  let returnFocus: HTMLElement | null = null
  /**
   * ClickFix or tech-support verdicts raised while another module's panel held the
   * slot: journalled once, not on every copy that re-runs the check.
   */
  const raisedAside = new Set<TrapKind>()
  /**
   * ClickFix and tech-support warnings the person answered "This is wrong" to, for the
   * life of this page. The next scripted copy raised the same warning again and wrote a
   * second journal line, while SCN-008 and SCN-009 said it closes for the page (round 2
   * of the B-165 certification).
   */
  const disputed = new Set<'clickfix' | 'techsupport'>()
  /** The last answer from Trusted sites; see `TrapDeps.trusted`. */
  let siteTrusted = false
  const readTrust = () => {
    if (deps.trusted === undefined) return
    deps
      .trusted()
      .then((answer) => {
        siteTrusted = answer === true
      })
      .catch(() => {
        siteTrusted = false
      })
  }
  let scriptedCopy = false
  let copied: string | null = null
  let forcedFullscreen = false
  let dialogLoop = false
  let lastGesture = 0
  let timer: ReturnType<typeof setTimeout> | null = null

  const gesture = () => {
    lastGesture = Date.now()
  }
  const recently = () => Date.now() - lastGesture < 1000

  /**
   * True while a held link click is being dispatched.
   *
   * `execCommand('copy')` in the page's own click handler fires a trusted copy event in
   * Chromium, so the FileFix page (one click opens `search-ms:` and copies the command)
   * read as the person's own copy and ended on the link warning (round 1 of the B-165
   * certification, e2e). The person clicked a link, not Copy; a copy inside that click
   * is the page's doing. Cleared after the dispatch, by a task rather than a microtask:
   * a browser runs microtasks between the listeners of a trusted event.
   */
  let insideHeldClick = false

  const onCopy = (event: Event) => {
    if (event.isTrusted && !insideHeldClick) return
    scriptedCopy = true
    try {
      // An execCommand copy carries no data of its own yet: empty is unreadable, and
      // the warning says so rather than showing an empty box.
      copied = (event as ClipboardEvent).clipboardData?.getData('text/plain') || null
    } catch {
      // Reading the clipboard through the event is best-effort. The warning
      // stands on the write itself; it just cannot show the payload.
      copied = null
    }
    schedule()
  }

  const onFullscreen = () => {
    if (!deps.doc.fullscreenElement) return
    if (recently()) return
    // Nobody asked for this. Leaving is the first thing to do, before any text
    // is read: the user has lost control of their window.
    forcedFullscreen = true
    deps.exitFullscreen()
    schedule()
  }

  const onBeforeUnload = () => {
    dialogLoop = true
  }

  /**
   * Addresses the person let through with "This is wrong", for the life of this page.
   * One link, not the scheme: agreeing to one saved search is not agreeing to the next.
   */
  const allowedLinks = new Set<string>()
  /**
   * Addresses already journalled on this page. Every click on them is still stopped;
   * only the journal line is once, because a page looping `element.click()` wrote one
   * "What changed" row per click (round 1 of the B-165 certification).
   */
  const journalledLinks = new Set<string>()

  /**
   * A click on a link that hands its address to a program outside the browser (B-165).
   *
   * Held on the click rather than reported on arrival: a page that carries such a link
   * has done nothing yet, and the click is the moment the browser passes the address to
   * Windows. Untrusted clicks are held too, because `element.click()` from a page or an
   * agent has the same default action as a person's. The browser may ask its own
   * question about opening the program next; a person can tick "always allow" there
   * once and never see it again, which is why this does not rely on it.
   */
  const onLinkClick = (event: Event) => {
    if (event.defaultPrevented) return
    // The left button and the middle one open a link. A right click opens a menu, and
    // Chromium fires auxclick with button 2 for it: holding that put a blocking
    // warning and a false journal line on a person copying the address.
    const button = 'button' in event ? (event as MouseEvent).button : 0
    if (button !== 0 && button !== 1) return
    const anchor = linkOf(event, deps.shadowRootOf)
    if (anchor === null) return
    const href = linkAddress(anchor)
    if (href === null || allowedLinks.has(href)) return
    const verdict = classifyOutsideLink(href)
    if (verdict === null) return
    if (siteTrusted) return

    event.preventDefault()
    // Asked again after each stopped click: a person may have trusted the site since.
    readTrust()
    if (!insideHeldClick) {
      insideHeldClick = true
      setTimeout(() => {
        insideHeldClick = false
      }, 0)
    }
    if (!journalledLinks.has(href) && journalledLinks.size < JOURNAL_LINKS_MAX) {
      journalledLinks.add(href)
      deps.warned?.('outside-link', verdict.signals)
    }
    // One panel: a ClickFix or tech-support warning already up is the more urgent
    // sentence, and the click is stopped either way.
    if (banner) return
    showOutsideLink(href, verdict)
  }

  function schedule(): void {
    if (timer) return
    timer = setTimeout(() => {
      timer = null
      check()
    }, RECHECK_MS)
  }

  function check(): void {
    // A link warning gives way: ClickFix and tech-support are the more urgent sentence
    // (the FileFix page opens search-ms: and copies the command with one click), so the
    // check runs under it and its verdict takes the panel.
    if (banner && holding !== 'outside-link') return
    const text = deps.text()

    const clickfix = disputed.has('clickfix') ? null : detectClickFix({ text, scriptedCopy, copied })
    if (clickfix) {
      raise(
        'clickfix',
        {
          variant: 'clickfix',
          severity: 'critical',
          // Two different claims, and the difference is not cosmetic: before
          // anything is on the clipboard, saying it was copied is untrue.
          headline:
            clickfix.confidence === 'high'
              ? t('warnClickfixCopied')
              : t('warnClickfixWants'),
          detail: [
            t('warnClickfixNever'),
            clickfix.confidence === 'high'
              ? clickfix.copyUnreadable
                ? t('warnClickfixUnreadable')
                : t('warnClickfixCopiedWhat', clickfix.copied ?? '')
              : t('warnClickfixNothingYet'),
          ].join(' '),
          sourceLine: t('warnFoundBy', clickfix.signals.join(', ')),
        },
        () => deps.recover('clickfix'),
        clickfix.signals,
      )
      return
    }

    const techsupport = disputed.has('techsupport')
      ? null
      : detectTechSupport({ text, forcedFullscreen, dialogLoop })
    if (techsupport) {
      raise(
        'techsupport',
        {
          variant: 'techsupport',
          severity: 'critical',
          headline: t('warnTechsupportHeadline'),
          detail: [
            t('warnTechsupportNoOne'),
            techsupport.phone ? t('warnTechsupportPhone', techsupport.phone) : '',
            techsupport.dialogsUnsuppressed
              ? t('warnTechsupportDialogs')
              : '',
          ]
            .filter(Boolean)
            .join(' '),
          sourceLine: t('warnFoundBy', techsupport.signals.join(', ')),
        },
        () => deps.recover('techsupport'),
        techsupport.signals,
      )
    }
  }

  /** Raises a ClickFix or tech-support warning, taking the panel from a link warning. */
  function raise(
    kind: 'clickfix' | 'techsupport',
    props: BannerProps,
    onRetry: () => void,
    signals: readonly string[],
  ): void {
    // The link warning's click stays stopped; its panel gives way. Focus is not handed
    // back to the page, because the page is covered again at once.
    if (holding === 'outside-link') close(banner, false)
    let mine: BannerHandle | null = null
    mine = mount(
      props,
      {
        onPrimary: deps.leave,
        onRetry,
        onDispute: () => {
          disputed.add(kind)
          close(mine, false)
        },
        onDismiss: () => close(mine, false),
      },
      () => forget(mine),
    )
    if (mine === null) {
      // Another module's panel holds the slot, which has put this on it as an "also
      // here" line. Journalled once, not on every copy that runs the check again.
      if (!raisedAside.has(kind)) {
        raisedAside.add(kind)
        deps.warned?.(kind, signals)
      }
      return
    }
    banner = mine
    holding = kind
    deps.warned?.(kind, signals)
  }

  function showOutsideLink(href: string, verdict: OutsideLinkVerdict): void {
    const focused = deepActive(deps.doc, deps.shadowRootOf)
    let mine: BannerHandle | null = null
    mine = mount(
      {
        // The ClickFix variant on purpose: the same trap by another road. The page wants
        // something run outside the browser, and the panel interrupts for the same reason.
        variant: 'clickfix',
        severity: 'critical',
        headline: t('warnOutsideLinkHeadline'),
        detail: [
          t('warnOutsideLinkProgram', verdict.scheme),
          verdict.host === null ? '' : t('warnOutsideLinkWhere', verdict.host),
          t('warnOutsideLinkStopped'),
        ]
          .filter(Boolean)
          .join(' '),
        sourceLine: t('warnFoundBy', t('warnOutsideLinkSource')),
      },
      {
        onPrimary: deps.leave,
        onRetry: deps.leave,
        onDispute: () => {
          allowedLinks.add(href)
          close(mine, true)
        },
        onDismiss: () => close(mine, true),
      },
      () => forget(mine),
    )
    // Another module's warning holds the panel: the click is stopped and journalled,
    // and the fact is a line on that panel. Nothing here is this watcher's to hold.
    if (mine === null) return
    banner = mine
    holding = 'outside-link'
    returnFocus = isFocusable(focused) ? focused : null
    // The panel covers the page, so the person's focus must not stay on the link under
    // it: a keyboard user otherwise tabbed through every covered link first, and Enter
    // on one of them acted on the page behind the warning (design review, step 1).
    ;(mine.root.querySelector('[data-role=primary]') as HTMLElement | null)?.focus()
  }

  /**
   * Takes down the panel this watcher holds, when `handle` is still it.
   *
   * Through the handle the slot gave, so the slot is released and its watch does not
   * read the close as the page removing the warning. `giveFocusBack` returns the person
   * to where they were when the link warning opened.
   */
  /**
   * The slot took `handle`'s panel down by another hand. Nothing to destroy; the watcher
   * only stops believing it holds a panel, so the next link is drawn and the next copy
   * checked. Focus is not moved: whoever released the slot owns that moment.
   */
  function forget(handle: BannerHandle | null): void {
    if (handle === null || handle !== banner) return
    banner = null
    holding = null
    returnFocus = null
  }

  function close(handle: BannerHandle | null, giveFocusBack: boolean): void {
    if (handle === null || handle !== banner) return
    const back = returnFocus
    banner = null
    holding = null
    returnFocus = null
    handle.destroy()
    if (giveFocusBack && back !== null && back.isConnected) back.focus({ preventScroll: true })
  }

  for (const type of ['pointerdown', 'keydown']) {
    deps.doc.addEventListener(type, gesture, true)
  }
  deps.doc.addEventListener('copy', onCopy, true)
  deps.doc.addEventListener('fullscreenchange', onFullscreen, true)
  deps.doc.addEventListener('click', onLinkClick, true)
  deps.doc.addEventListener('auxclick', onLinkClick, true)
  deps.doc.defaultView?.addEventListener('beforeunload', onBeforeUnload)

  // The page's wording is enough on its own for the tech-support case, so one
  // pass runs without waiting for an event that may never come.
  schedule()
  readTrust()

  return {
    stop() {
      if (timer) clearTimeout(timer)
      for (const type of ['pointerdown', 'keydown']) {
        deps.doc.removeEventListener(type, gesture, true)
      }
      deps.doc.removeEventListener('copy', onCopy, true)
      deps.doc.removeEventListener('fullscreenchange', onFullscreen, true)
      deps.doc.removeEventListener('click', onLinkClick, true)
      deps.doc.removeEventListener('auxclick', onLinkClick, true)
      deps.doc.defaultView?.removeEventListener('beforeunload', onBeforeUnload)
      close(banner, false)
    },
  }
}

/**
 * The link a click landed on, wherever it sits.
 *
 * A listener on the document sees a click from inside a shadow root retargeted to the
 * root's host, so `target.closest` found nothing for a link in any web component, open
 * or closed (round 1 of the B-165 certification, measured in WebKit and Chromium). An
 * open root still lists the link in the composed path. A closed one hides it there too,
 * so the root is borrowed from the browser where it lends it to an extension, and the
 * link is the one under the pointer or, for a click the keyboard made, the focused one.
 * A script calling `click()` on a link inside a closed root is still not seen: no
 * pointer, no focus, and nothing else names the element.
 */
function linkOf(event: Event, shadowRootOf: TrapDeps['shadowRootOf']): Element | null {
  const path = event.composedPath()
  for (const node of path) {
    if (isElement(node) && node.matches(LINK)) return node
  }
  const target = event.target
  if (!isElement(target)) return null
  const outer = target.closest(LINK)
  if (outer !== null) return outer
  if (shadowRootOf === undefined) return null

  // Down through closed roots, one host at a time.
  let host: Element = target
  for (let depth = 0; depth < 8; depth += 1) {
    const root = shadowRootOf(host)
    if (root === null) return null
    const inner = pointed(event, root) ?? root.activeElement
    if (inner === null) return null
    const link = inner.closest(LINK)
    if (link !== null) return link
    host = inner
  }
  return null
}

/**
 * The shadow root an extension may read behind a host, closed ones included.
 *
 * Chromium lends it through `chrome.dom.openOrClosedShadowRoot` (Chrome 88 and Edge, to
 * content scripts, no permission); Firefox through `Element.openOrClosedShadowRoot` in a
 * content script. Anywhere else only an open root is readable.
 */
export function lentShadowRoot(element: Element): ShadowRoot | null {
  const lend = (globalThis as unknown as { chrome?: { dom?: { openOrClosedShadowRoot?: (e: Element) => ShadowRoot | null } } })
    .chrome?.dom?.openOrClosedShadowRoot
  if (typeof lend === 'function') {
    try {
      return lend(element) ?? null
    } catch {
      return null
    }
  }
  const firefox = (element as Element & { openOrClosedShadowRoot?: ShadowRoot | null }).openOrClosedShadowRoot
  return firefox ?? element.shadowRoot ?? null
}

/** What is under the pointer inside a root, for a click a pointer made. */
function pointed(event: Event, root: ShadowRoot): Element | null {
  if (!('clientX' in event)) return null
  const { clientX, clientY, detail } = event as MouseEvent
  // A click the keyboard made (or a script) carries no position.
  if (detail === 0 && clientX === 0 && clientY === 0) return null
  try {
    return root.elementFromPoint(clientX, clientY)
  } catch {
    return null
  }
}

/** `instanceof Element` is not safe across the content world's wrappers in Firefox. */
function isElement(node: unknown): node is Element {
  return typeof node === 'object' && node !== null && (node as Node).nodeType === 1
}

/**
 * The focused element, inside shadow roots too: the document reports only the host, and
 * focus handed back to a host that cannot take it goes nowhere.
 */
function deepActive(doc: Document, shadowRootOf: TrapDeps['shadowRootOf']): Element | null {
  let active = doc.activeElement
  for (let depth = 0; active !== null && depth < 8; depth += 1) {
    const root = shadowRootOf?.(active) ?? active.shadowRoot
    const inner = root?.activeElement ?? null
    if (inner === null) break
    active = inner
  }
  return active
}

function isFocusable(node: Element | null): node is HTMLElement {
  return node !== null && typeof (node as HTMLElement).focus === 'function' && node !== node.ownerDocument.body
}

/**
 * The address a link would open, resolved the way the browser resolves it.
 *
 * `HTMLAnchorElement.href` and `HTMLAreaElement.href` are already absolute; an SVG `<a>`
 * carries an animated string instead, so its attribute is read and resolved against the
 * document.
 */
function linkAddress(element: Element): string | null {
  if (element instanceof HTMLAnchorElement || element instanceof HTMLAreaElement) return element.href
  const raw = element.getAttribute('href')
  if (raw === null) return null
  try {
    return new URL(raw, element.ownerDocument.baseURI).href
  } catch {
    return raw
  }
}
