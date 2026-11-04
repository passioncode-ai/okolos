import { t } from '@okolos/i18n'
import { detectClickFix, detectTechSupport } from '@okolos/core-traps'
import { mountBanner, type BannerHandle, type BannerHandlers, type BannerProps } from '@okolos/ui'

/**
 * Watching for the two traps that work on the person rather than the browser.
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

export interface TrapDeps {
  readonly doc: Document
  text(): string
  leave(): void
  recover(kind: 'clickfix' | 'techsupport'): void
  exitFullscreen(): void
  /** Called once when a warning is raised, with what it rests on. */
  warned?: (kind: 'clickfix' | 'techsupport', signals: readonly string[]) => void
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
  /**
   * Told when the page has been looked at: after every check, once the warning (if any)
   * is drawn, and for a copy the user made themselves, which is judged by being ignored.
   *
   * It exists for the end-to-end tests, which used to assert "no warning" after a fixed
   * wait and passed under load on a check that had not run yet (B-169). The entry point
   * wires it to a mark only in the build with test hooks.
   */
  judged?: () => void
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
    if (event.isTrusted) {
      deps.judged?.()
      return
    }
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

  function schedule(): void {
    if (timer) return
    timer = setTimeout(() => {
      timer = null
      check()
    }, RECHECK_MS)
  }

  function check(): void {
    look()
    deps.judged?.()
  }

  function look(): void {
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

  function dismiss(): void {
    banner?.destroy()
    banner = null
  }

  for (const type of ['pointerdown', 'keydown']) {
    deps.doc.addEventListener(type, gesture, true)
  }
  deps.doc.addEventListener('copy', onCopy, true)
  deps.doc.addEventListener('fullscreenchange', onFullscreen, true)
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
      deps.doc.defaultView?.removeEventListener('beforeunload', onBeforeUnload)
      dismiss()
    },
  }
}
