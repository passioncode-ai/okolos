import { t } from '@okolos/i18n'
import {
  guardCredentialEntry,
  type CredentialContext,
  type CredentialWarning,
} from '@okolos/core-credential'
import type { FrameLine } from '@okolos/contracts'
import { mountBanner, type BannerHandle, type BannerHandlers, type BannerProps } from '@okolos/ui'

import { credentialDetail, credentialLines } from './credential-words.js'

/**
 * The pause before a password.
 *
 * It appears when the field is focused, not when the page loads: before that
 * moment there is nothing to warn about, and a banner shown to everyone who
 * lands on a login page is a banner nobody reads by the second week.
 *
 * It never blocks typing. Someone mid-login on a site they know is better
 * served by an explanation they can ignore than by a modal they have to fight.
 */

export interface CredentialDeps {
  readonly doc: Document
  facts(host: string): Promise<Omit<CredentialContext, 'host' | 'now'>>
  now(): string
  trust(host: string): Promise<void>
  leave(): void
  host(): string
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
   * Where a warning goes when this frame is not the one a person is looking at.
   *
   * Present in a subframe, absent in the top frame, and never both: a frame that both
   * draws and reports shows the warning twice. The facts travel, not the sentence —
   * the surface that draws it owns the words (`credential-words.ts`).
   *
   * Why a separate dep rather than a `mountWarning` that relays: that one must return a
   * `BannerHandle`, so a relaying implementation would have to fabricate a host element
   * and a shadow root for something it never mounts. A seam that has to lie about its
   * return value is the wrong seam.
   */
  report?: (finding: {
    severity: CredentialWarning['severity']
    lines: FrameLine[]
  }) => void | Promise<unknown>
  /**
   * Told when a focus has been judged: at once for a field that asks for nothing
   * sensitive, and after the warning is drawn (or handed to the embedding page, or decided
   * against) for one that does. Not told when the facts could not be read, because that is
   * a judgement that was not made.
   *
   * It exists for the end-to-end tests, which used to assert "no warning" after a fixed
   * wait and passed under load on a check that had not run yet (B-169). The entry point
   * wires it to a mark only in the build with test hooks.
   */
  judged?: () => void
}

export interface CredentialWatcher {
  stop(): void
}

const SENSITIVE = 'input[type=password], input[autocomplete*="cc-number"]'

/**
 * Card fields are matched by name in code rather than by selector: the
 * case-insensitive attribute form (`[name*=card i]`) is not supported
 * everywhere this runs, and a selector that throws takes the whole listener
 * with it.
 */
function isSensitive(element: Element): boolean {
  if (element.matches(SENSITIVE)) return true
  const name = `${element.getAttribute('name') ?? ''} ${element.getAttribute('id') ?? ''}`
  return /card(number|num)?|cardnumber/i.test(name)
}

/** The injected mount, or the real one when a caller did not supply a slot. */
function mounting(deps: { readonly doc: Document; mountWarning?: (p: BannerProps, h: BannerHandlers) => BannerHandle }) {
  return (props: BannerProps, handlers: BannerHandlers): BannerHandle =>
    (deps.mountWarning ?? ((p, h) => mountBanner(deps.doc, p, h)))(props, handlers)
}

export function watchCredentialFields(deps: CredentialDeps): CredentialWatcher {
  const mount = mounting(deps)
  let banner: BannerHandle | null = null
  let asked = false
  /** The first decision, so a later focus is called judged only once it is made. */
  let decided: Promise<boolean> = Promise.resolve(false)

  const onFocus = (event: Event) => {
    const target = event.target
    if (!(target instanceof Element) || !isSensitive(target)) {
      deps.judged?.()
      return
    }
    // Once per page: focus moves in and out of a password field constantly
    // while someone types, and a warning that reappears is a warning that gets
    // clicked away without reading.
    if (asked) {
      // Not before the first decision: a second focus while the facts are still being
      // read has not been judged yet, it is waiting on the same answer.
      void decided.then((made) => {
        if (made) deps.judged?.()
      })
      return
    }
    asked = true
    decided = warn(target)
    void decided.then((made) => {
      if (made) deps.judged?.()
    })
  }

  /** Resolves to whether a decision was reached, which a failed read of the facts is not. */
  async function warn(field: Element): Promise<boolean> {
    const host = deps.host()
    let context: CredentialContext
    try {
      context = { ...(await deps.facts(host)), host, now: deps.now() }
    } catch {
      // Unable to read what we know about this site. Staying silent is right:
      // a warning built from nothing would say nothing useful.
      return false
    }

    const warning = guardCredentialEntry({ ...context, postsTo: postsTo(field, host) })
    if (!warning) return true

    const lines = credentialLines(warning)

    // A frame reports rather than draws, and it is the same decision the injection
    // side already made: a banner inside a small frame is clipped, invisible, or
    // drawn a dozen times across ad frames. The relay is the surface here, and it
    // gets facts — the page that embeds this one words them.
    if (deps.report) {
      // Judged once the embedding page has it (or the report was given up), not when it
      // left: until then the warning is on nobody's screen.
      await Promise.resolve(deps.report({ severity: warning.severity, lines })).catch(() => undefined)
      return true
    }

    banner = mount(
      {
        variant: 'credential',
        severity: warning.severity,
        headline: t('warnCredentialHeadline'),
        detail: credentialDetail(lines),
        sourceLine: t('warnFoundBy', t('warnCredentialSource')),
      },
      {
        onPrimary: deps.leave,
        onRetry: deps.leave,
        onDispute: () => {
          void deps.trust(host)
          dismiss()
        },
        onDismiss: dismiss,
      },
    )
    return true
  }

  function dismiss(): void {
    banner?.destroy()
    banner = null
  }

  deps.doc.addEventListener('focusin', onFocus, true)

  return {
    stop() {
      deps.doc.removeEventListener('focusin', onFocus, true)
      dismiss()
    },
  }
}

/** The origin a form sends to, when it is not the page's own. */
function postsTo(field: Element, host: string): string | null {
  const form = field.closest('form')
  const action = form?.getAttribute('action')
  if (!action) return null
  try {
    const url = new URL(action, `https://${host}`)
    return url.hostname === host ? null : url.origin
  } catch {
    return null
  }
}
