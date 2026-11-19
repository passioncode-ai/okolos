import { t } from '@okolos/i18n'

import { renderAgentRequests } from '../agent-requests.js'
import { shortTime } from '../when.js'

import type { Queue } from '@okolos/core-queue'

import { renderQueue } from '../queue/queue.js'

/**
 * SCR-02 — the popup.
 *
 * It answers one question in about three seconds: is this page fine, and is
 * anything waiting for me. Everything else is a link.
 *
 * Two rules it never bends. It does not show a clean verdict it could not
 * compute — while checking it says it is checking, and on a storage failure it
 * says that, because "nothing needs you" is the most damaging sentence in the
 * product to say wrongly. And the queue shows only what the ranker handed it,
 * with the remainder counted out loud: a hidden remainder is how an inbox of
 * 203 alerts starts.
 */

export type PageVerdict = 'clean' | 'finding' | 'unknown'

export type PopupState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly message: string }
  | {
      readonly kind: 'ready'
      readonly page: { readonly verdict: PageVerdict; readonly reason: string }
      readonly queue: Queue
      readonly changed: number
      readonly lastCheck: string | null
      /** Agents' requests to lift a gate, each a sentence the caller built with no word of the agent's (B-218 wave (d)). */
      readonly requests?: readonly { readonly id: string; readonly line: string }[]
    }

export interface PopupHandlers {
  readonly onAct: (itemId: string) => void
  readonly onShowAll: () => void
  readonly onResolve: (itemId: string) => void
  readonly onDefer: (itemId: string) => void
  readonly onWhatChanged: () => void
  readonly onOpen: (target: 'self-audit' | 'journal' | 'settings' | 'recovery') => void
  readonly onRepair: () => void
  /** The person's answer to an agent's request (B-218 wave (d)). */
  readonly onRequest?: (requestId: string, allow: boolean) => void
}

export function renderPopup(
  doc: Document,
  state: PopupState,
  handlers: PopupHandlers,
): HTMLElement {
  const root = doc.createElement('section')
  root.setAttribute('data-role', 'popup')
  root.setAttribute('data-state', state.kind)

  if (state.kind === 'loading') {
    root.append(text(doc, 'status', t('popupChecking')))
    return root
  }

  if (state.kind === 'error') {
    root.append(
      text(doc, 'error', t('popupLocalUnread', state.message)),
      text(
        doc,
        'error-note',
        t('popupStorageNote'),
      ),
      button(doc, 'repair', t('popupRepair'), handlers.onRepair),
    )
    root.append(footer(doc, handlers))
    return root
  }

  root.setAttribute('data-verdict', state.page.verdict)
  root.append(text(doc, 'verdict', state.page.reason))
  // First after the verdict: an agent waits on the answer, and it expires in ten minutes.
  if (handlers.onRequest !== undefined) {
    const requests = renderAgentRequests(doc, state.requests ?? [], handlers.onRequest)
    if (requests !== null) root.append(requests)
  }
  root.append(changedLine(doc, state.changed, state.lastCheck, handlers))
  root.append(
    renderQueue(doc, state.queue, {
      onAct: handlers.onAct,
      onShowAll: handlers.onShowAll,
      onResolve: handlers.onResolve,
      onDefer: handlers.onDefer,
    }),
  )
  root.append(footer(doc, handlers))
  return root
}

function changedLine(
  doc: Document,
  changed: number,
  lastCheck: string | null,
  handlers: PopupHandlers,
): HTMLElement {
  const el = doc.createElement('button')
  el.type = 'button'
  el.setAttribute('data-role', 'changed')
  el.textContent =
    changed > 0
      ? t('popupChangedCount', String(changed))
      : t('popupChangedSince', lastCheck ? shortTime(lastCheck) : t('popupFirstRun'))
  el.addEventListener('click', handlers.onWhatChanged)
  return el
}

function footer(doc: Document, handlers: PopupHandlers): HTMLElement {
  const el = doc.createElement('nav')
  el.setAttribute('data-role', 'footer')
  el.append(
    button(doc, 'self-audit', t('popupSelfAudit'), () => handlers.onOpen('self-audit')),
    button(doc, 'journal', t('popupJournal'), () => handlers.onOpen('journal')),
    /**
     * The way in for someone the product did not warn in time.
     *
     * SCN-025's entry point has read "the recovery entry in the popup" since it was
     * written, and there was none: every checklist opened because a detector fired, so a
     * person who ran the pasted command and realised afterwards had nowhere to go. It sits
     * in the footer rather than in the verdict area on purpose — it is not about this
     * page, and putting it where verdicts go would make every clean page look like an
     * invitation to worry (B-59).
     */
    button(doc, 'recovery', t('popupRecovery'), () => handlers.onOpen('recovery')),
    button(doc, 'settings', t('popupSettings'), () => handlers.onOpen('settings')),
  )
  return el
}


function text(doc: Document, role: string, content: string): HTMLParagraphElement {
  const el = doc.createElement('p')
  el.setAttribute('data-role', role)
  el.textContent = content
  return el
}

function button(
  doc: Document,
  role: string,
  label: string,
  onClick: () => void,
): HTMLButtonElement {
  const el = doc.createElement('button')
  el.type = 'button'
  el.setAttribute('data-role', role)
  el.textContent = label
  el.addEventListener('click', onClick)
  return el
}
