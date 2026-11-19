import { t, useResolver } from '@okolos/i18n'
import { detectPlatform } from '@okolos/platform'
import { renderAgentRequests, renderInterstitial } from '@okolos/ui'
import '../pages.css'

import { REQUESTS_KEY, waitingRequests, type LiftRequest } from '../background/agent-request-state.js'
import { appealLinkFor } from './appeal-link.js'
import { isFramed } from './framed.js'
import { settleContext, type BlockContext } from './context.js'
import { countUncaughtErrors } from '../ui-errors.js'

/**
 * The page shown in place of a blocked one.
 *
 * It asks the background what was blocked rather than reading it from its own
 * query string. A URL in the address bar of an extension page is a URL in the
 * user's history, their session restore and their screenshots — and this
 * particular URL is one they were warned about.
 */

const platform = detectPlatform()
countUncaughtErrors(window, () => platform.runtime.send('usage/uiError', {}))

// Before anything paints. A renderer that asks for a message before this line
// runs gets `[key]` — visible, which is the point, but not on a real page.
useResolver((key, substitutions) => platform.message(key, substitutions))
const root = document.getElementById('root')

/**
 * Set by the first thing the user does.
 *
 * The retry below repaints, and a repaint under someone's hand is worse than a
 * vague source line — the same reasoning that put the leaks address field in a
 * long-lived node rather than one the repaint rebuilds.
 */
let acted = false
for (const event of ['pointerdown', 'keydown'] as const) {
  document.addEventListener(event, () => {
    acted = true
  })
}

let countedShown = false

function paint(context: BlockContext | null): void {
  if (!root) return
  // Once per page: the block page is a warning on screen (B-206).
  if (!countedShown) {
    countedShown = true
    void platform.runtime.send('warning/shown', { kind: 'blocked-page' }).catch(() => undefined)
  }

  root.replaceChildren(
    renderInterstitial(
      document,
      {
        url: context?.url ?? t('blockThisSite'),
        feed: context?.feed ?? null,
        entryDate: context?.entryDate ?? null,
        feedAgeDays: context?.feedAgeDays ?? null,
      },
      {
        onBack: () => history.back(),
        onContinue: () => {
          void (async () => {
            const allowed = await platform.runtime
              .send('block/allow', { url: context?.url ?? '' })
              .catch(() => null)
            if (allowed?.url) location.replace(allowed.url)
          })()
        },
        onOwner: () => {
          // The public status page, with the domain already in it — the appeal
          // is filed with the service, not with this copy of the extension,
          // and the link still works from a phone or in someone else's hands.
          //
          // This is the one URL this page deliberately puts in the address bar:
          // the domain is the owner's own, and they asked for it by clicking.
          const link = appealLinkFor(context?.url)
          if (link !== null) void platform.tabs.create(link)
        },
      },
    ),
  )
  void showAgentRequests(context)
}

/**
 * An agent's request to lift this very block (B-218 wave (d)), answered here as in the popup. Only
 * on an unframed copy: `paint` never runs in a frame, so a site that embeds this page cannot put
 * «Разрешить» under someone's cursor.
 */
async function showAgentRequests(context: BlockContext | null): Promise<void> {
  if (!root || context?.url === undefined) return
  let host: string
  try {
    host = new URL(context.url).hostname
  } catch {
    return
  }
  const stored = (await platform.storage.get<LiftRequest[]>(REQUESTS_KEY).catch(() => undefined)) ?? []
  const lines = waitingRequests(stored, Date.now())
    .filter((request) => request.gate === 'block' && request.host === host)
    .map((request) => ({ id: request.id, line: t('agentRequestBlock', request.agentName, request.host) }))
  root.querySelector("[data-role='agent-requests']")?.remove()
  const section = renderAgentRequests(document, lines, (requestId, allow) => {
    void (async () => {
      await platform.runtime.send('agent/decide', { requestId, allow }).catch(() => undefined)
      if (allow) location.replace(context.url as string)
      else root?.querySelector("[data-role='agent-requests']")?.remove()
    })()
  })
  if (section !== null) root.append(section)
}

/**
 * Framed: say what this is and draw nothing else.
 *
 * `framed.ts` carries the reasoning. In short: this file is the one web-accessible page the
 * extension has, so any site can embed it, and a framed copy would offer a real "continue
 * anyway" control inside a layout the attacker controls. A stolen click there turns off a
 * block the product had made.
 *
 * Checked before the context is asked for, so a framed copy makes no request at all.
 */
if (isFramed({ win: window })) {
  if (root) root.textContent = t('blockFramed')
} else {
  void settleContext(
    () => platform.runtime.send('block/context', {}).catch(() => null),
    paint,
    (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    { abandoned: () => acted },
  )
}
