/**
 * The trusted-domain list, and the reason it has to exist.
 *
 * Trust is granted from the page: a comparison of two addresses offers "This is
 * legitimate", an interstitial offers "Continue anyway", and both are one click
 * in a moment of mild annoyance. The comparison view even promises, in those
 * words, that the decision "can be undone in settings".
 *
 * Until this surface existed that sentence was false. A domain trusted by
 * mistake — or trusted a year ago, before it changed hands — could not be taken
 * back through the interface at all. A security product that can only ever
 * lower its own guard is one whose guard eventually reaches zero.
 *
 * Each row says when the trust was granted and why, because "why" here is the
 * user's own past action and it is often the thing they have forgotten.
 */

import { t } from '@okolos/i18n'
import { shortDate } from '../when.js'

export interface TrustedDomain {
  readonly domain: string
  readonly grantedAt: string
  /** A catalogue key, resolved here so the reader's language decides. */
  readonly reasonKey?: string
  /** A sentence stored before the move to keys. Shown as recorded. */
  readonly reason?: string
}

export interface TrustedHandlers {
  readonly onRevoke: (domain: string) => void
}

/**
 * What this screen has to show, including the case where it has nothing to show *from*.
 *
 * It took a plain array, so "the store could not be read" had no way to travel and the
 * options page rendered that sentence itself, beside this renderer rather than through it
 * (B-59). The behaviour was right; the arrangement meant SCR-16's record named this file
 * as its coverage while its error state lived somewhere else — and no test of this
 * renderer, nor the axe sweep that walks its markup, could ever reach that state.
 *
 * Every other screen with an error state expresses it here: `extensions.ts` and
 * `overview.ts` both take a `kind`. This one was the exception.
 */
export type TrustedState =
  | { readonly kind: 'ready'; readonly domains: readonly TrustedDomain[] }
  | {
      readonly kind: 'error'
      readonly message: string
      /** The exception's own words, drawn under the sentence rather than inside it (B-117). */
      readonly diagnostic?: string
    }

export function renderTrusted(
  doc: Document,
  state: TrustedState,
  handlers: TrustedHandlers,
): HTMLElement {
  const root = doc.createElement('section')
  root.setAttribute('data-role', 'trusted')

  const heading = doc.createElement('h1')
  heading.textContent = t('trustedTitle')
  root.append(heading)

  if (state.kind === 'error') {
    // Never an empty list in place of a failure: it would read as "you trust nothing",
    // which is the reassuring answer and possibly the wrong one.
    root.append(text(doc, 'trusted-error', state.message))
    // The exception under the sentence, never inside it (B-117).
    if (state.diagnostic !== undefined && state.diagnostic !== '') {
      root.append(text(doc, 'trusted-diagnostic', state.diagnostic))
    }
    return root
  }

  const domains = state.domains
  if (domains.length === 0) {
    root.append(
      text(
        doc,
        'trusted-empty',
        t('trustedEmpty'),
      ),
    )
    return root
  }

  root.append(
    text(
      doc,
      'trusted-note',
      t('trustedNote'),
    ),
  )

  for (const entry of domains) {
    const row = doc.createElement('article')
    row.setAttribute('data-role', 'trusted-row')
    row.setAttribute('data-domain', entry.domain)

    row.append(
      text(doc, 'domain', entry.domain),
      text(
        doc,
        'granted',
        // Key first, stored sentence second, date alone when there is neither
        // — the same order the journal reads in, for the same reason.
        entry.reasonKey ?? entry.reason
          ? `${shortDate(entry.grantedAt)} · ${entry.reasonKey ? t(entry.reasonKey) : entry.reason}`
          : t('trustedGrantedOn', shortDate(entry.grantedAt)),
      ),
      button(doc, 'revoke', t('trustedRevoke'), () => handlers.onRevoke(entry.domain)),
    )
    root.append(row)
  }

  return root
}


function text(doc: Document, role: string, content: string): HTMLParagraphElement {
  const el = doc.createElement('p')
  el.setAttribute('data-role', role)
  el.textContent = content
  return el
}

function button(doc: Document, role: string, label: string, onClick: () => void): HTMLButtonElement {
  const el = doc.createElement('button')
  el.type = 'button'
  el.setAttribute('data-role', role)
  el.textContent = label
  el.addEventListener('click', onClick)
  return el
}
