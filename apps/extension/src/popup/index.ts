import { useResolver } from '@okolos/i18n'
import { detectPlatform } from '@okolos/platform'
import { openDb } from '@okolos/storage'
import { renderPopup, type PopupState } from '@okolos/ui'

import { REQUESTS_KEY, type LiftRequest } from '../background/agent-requests.js'
import { buildPopupState } from './state.js'
import '../pages.css'
import { optionsPageFor, type ViewId } from '../options/views.js'
import { countUncaughtErrors } from '../ui-errors.js'

/**
 * The popup footer's three links, and the area each one opens.
 *
 * A table rather than a conditional, because the conditional is what broke:
 * one target was handled and the rest fell through to a fragment-less URL.
 */
const FOOTER_VIEW: Readonly<Record<'self-audit' | 'journal' | 'settings' | 'recovery', ViewId>> = {
  'self-audit': 'audit',
  journal: 'journal',
  settings: 'data',
  // With no kind: the picker, which is how a person names what happened themselves.
  recovery: 'recovery',
}

/**
 * The popup: is this page fine, and is anything waiting for me.
 *
 * Every read is wrapped, and a failed read becomes a stated failure rather than
 * a clean verdict. The one thing this surface must never do is answer "nothing
 * needs you" when it does not know.
 */

const LAST_CHECK_KEY = 'popup:lastCheck'

const platform = detectPlatform()
countUncaughtErrors(window, () => platform.runtime.send('usage/uiError', {}))

/**
 * Before anything paints.
 *
 * This page's own strings are still literals — the catalogue reaches it through
 * `@okolos/ui`, whose overlays are localised. Installing the resolver here is
 * one line and makes the invariant true now rather than at the moment someone
 * translates this screen and cannot see why it renders `[key]`.
 */
useResolver((key, substitutions) => platform.message(key, substitutions))

const root = document.getElementById('root')

let expanded = false

async function load(): Promise<PopupState> {
  try {
    const db = await openDb()
    const [findings, journal, setting, settings, activeUrl] = await Promise.all([
      db.getAll('findings'),
      db.getAll('journal'),
      db.get('settings', LAST_CHECK_KEY),
      db.getAll('settings'),
      platform.tabs.activeUrl().catch(() => null),
    ])
    const requests = await platform.storage.get<LiftRequest[]>(REQUESTS_KEY).catch(() => undefined)

    const deferrals = new Map(
      settings
        .filter((row) => row.key.startsWith('defer:') && typeof row.value === 'string')
        .map((row) => [row.key.slice('defer:'.length), row.value as string]),
    )

    return buildPopupState({
      findings,
      journal,
      activeUrl,
      lastCheck: typeof setting?.value === 'string' ? setting.value : null,
      expanded,
      deferrals,
      now: new Date().toISOString(),
      ...(requests === undefined ? {} : { requests }),
    })
  } catch (cause) {
    return { kind: 'error', message: String(cause) }
  }
}

function paint(state: PopupState): void {
  if (!root) return
  root.replaceChildren(
    renderPopup(document, state, {
      onAct: (itemId) => void openFinding(itemId),
      onResolve: (itemId) => {
        void (async () => {
          await platform.runtime.send('finding/resolve', { id: itemId })
          await reload()
        })()
      },
      onDefer: (itemId) => {
        void (async () => {
          // Tomorrow, not forever: "not now" that never comes back is the same
          // as dismissing, and the user did not say that.
          const until = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
          await platform.runtime.send('finding/defer', { id: itemId, until })
          await reload()
        })()
      },
      onShowAll: () => {
        expanded = true
        void reload()
      },
      onWhatChanged: () => void openPage(optionsPageFor('journal')),
      // Every footer link names its area. The old shape sent 'journal' to its
      // address and dropped every other target into a fragment-less URL, so
      // "Настройки" opened the self-audit panel — a link that did not go where
      // it said, for as long as the page was one scrolling stack.
      onOpen: (target) => void openPage(optionsPageFor(FOOTER_VIEW[target])),
      onRepair: () => void reload(),
      onRequest: (requestId, allow) => {
        void platform.runtime.send('agent/decide', { requestId, allow }).finally(() => void reload())
      },
    }),
  )
}

async function reload(): Promise<void> {
  paint({ kind: 'loading' })
  paint(await load())
}

async function openFinding(itemId: string): Promise<void> {
  try {
    const db = await openDb()
    const finding = await db.get('findings', itemId)
    const url = finding?.verdict?.subject.ref
    if (url) await platform.tabs.create(url)
  } catch {
    // The action failed and the popup is about to close, so there is nowhere
    // left to say so. Better than throwing inside a click handler.
  }
}

async function openPage(page: string): Promise<void> {
  await platform.tabs.create(platform.runtime.getUrl(page))
}

/**
 * The check time is written when the popup goes away, not when it opens —
 * otherwise "what changed since last time" would be empty the moment you looked
 * at it. `pagehide` is the event a closing popup actually fires.
 */
window.addEventListener('pagehide', () => {
  void (async () => {
    try {
      const db = await openDb()
      await db.put('settings', { key: LAST_CHECK_KEY, value: new Date().toISOString() })
    } catch {
      // Losing the baseline means the next diff is wider than it should be,
      // which errs towards showing too much — the safe direction.
    }
  })()
})

void reload()
