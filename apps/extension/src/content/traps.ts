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
  /** Called once when a warning is raised, with what it rests on. */
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
   */
  mountWarning?: (props: BannerProps, handlers: BannerHandlers) => BannerHandle
}

export interface TrapWatcher {
  stop(): void
}

const RECHECK_MS = 400

/** The injected mount, or the real one when a caller did not supply a slot. */
function mounting(deps: { readonly doc: Document; mountWarning?: (p: BannerProps, h: BannerHandlers) => BannerHandle }) {
  return (props: BannerProps, handlers: BannerHandlers): BannerHandle =>
    (deps.mountWarning ?? ((p, h) => mountBanner(deps.doc, p, h)))(props, handlers)
}

export function watchForTraps(deps: TrapDeps): TrapWatcher {
  const mount = mounting(deps)
  let banner: BannerHandle | null = null
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

  const onCopy = (event: Event) => {
    if (event.isTrusted) return
    scriptedCopy = true
    try {
      copied = (event as ClipboardEvent).clipboardData?.getData('text/plain') ?? null
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
    const target = event.target
    if (!(target instanceof Element)) return
    const anchor = target.closest('a[href], area[href]')
    if (anchor === null) return
    const href = linkAddress(anchor)
    if (href === null || allowedLinks.has(href)) return
    const verdict = classifyOutsideLink(href)
    if (verdict === null) return

    event.preventDefault()
    deps.warned?.('outside-link', verdict.signals)
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
    if (banner) return
    const text = deps.text()

    const clickfix = detectClickFix({ text, scriptedCopy, copied })
    if (clickfix) {
      banner = mount(
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
        {
          onPrimary: deps.leave,
          onRetry: () => deps.recover('clickfix'),
          onDispute: dismiss,
          onDismiss: dismiss,
        },
      )
      deps.warned?.('clickfix', clickfix.signals)
      return
    }

    const techsupport = detectTechSupport({ text, forcedFullscreen, dialogLoop })
    if (techsupport) {
      banner = mount(
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
        {
          onPrimary: deps.leave,
          onRetry: () => deps.recover('techsupport'),
          onDispute: dismiss,
          onDismiss: dismiss,
        },
      )
      deps.warned?.('techsupport', techsupport.signals)
    }
  }

  function showOutsideLink(href: string, verdict: OutsideLinkVerdict): void {
    banner = mount(
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
          dismiss()
        },
        onDismiss: dismiss,
      },
    )
  }

  function dismiss(): void {
    banner?.destroy()
    banner = null
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
      dismiss()
    },
  }
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
