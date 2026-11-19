import { t } from '@okolos/i18n'

/**
 * «Помощь» in «Ваши данные» (SCR-12, B-232; operator decisions D59 and D60, 2026-11-19): where to
 * write and what leaves the device. Only what exists: there is no terms page and no store listing
 * to rate yet, and a link to either would go nowhere (B-232 names both, and a support chatbot,
 * as waiting).
 */
export interface HelpHandlers {
  readonly onSupport: () => void
  readonly onPrivacy: () => void
}

export function renderHelp(doc: Document, handlers: HelpHandlers): HTMLElement {
  const section = doc.createElement('section')
  section.setAttribute('data-role', 'help')
  const heading = doc.createElement('h2')
  heading.setAttribute('data-role', 'help-title')
  heading.textContent = t('helpTitle')
  // In a row of their own: `[data-role$='actions']` in pages.css spaces them, and two buttons
  // side by side without it rendered as one run of text (e2e/no-flush-text.spec.ts).
  const actions = doc.createElement('div')
  actions.setAttribute('data-role', 'help-actions')
  actions.append(button(doc, 'help-support', t('helpSupport'), handlers.onSupport), button(doc, 'help-privacy', t('helpPrivacy'), handlers.onPrivacy))
  section.append(heading, actions)
  return section
}

function button(doc: Document, role: string, label: string, onClick: () => void): HTMLButtonElement {
  const el = doc.createElement('button')
  el.type = 'button'
  el.setAttribute('data-role', role)
  el.textContent = label
  el.addEventListener('click', onClick)
  return el
}
