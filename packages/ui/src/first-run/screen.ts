/**
 * The first-run screen: a real, local result within seconds of installing.
 *
 * The hardest requirement here is not speed, it is honesty. This version does
 * not hold the permissions needed to inventory tabs or extensions — they arrive
 * with the features that justify them — so the screen names the checks that did
 * not run and why, rather than showing a tidy green list that implies a scan
 * nobody performed. A first impression built on an overstatement is the same
 * mistake the incumbents make with "203 threats blocked".
 */

import { t } from '@okolos/i18n'

export type CheckState = 'running' | 'ok' | 'unavailable' | 'failed'

export interface CheckRow {
  readonly id: string
  readonly label: string
  readonly state: CheckState
  /** For ok: what it means. For unavailable or failed: why. */
  readonly note: string
}

export interface FirstRunProps {
  readonly checks: readonly CheckRow[]
  readonly findings: number
  /**
   * Whether usage and error data is being sent (B-199, SCN-050). The notice is shown only for
   * `on`: off, a Firefox that did not grant it and a Firefox with no built-in consent send
   * nothing, and a sentence saying something is sent would be untrue there.
   */
  readonly usage?: 'on' | 'off' | 'unsupported'
}

export interface FirstRunHandlers {
  readonly onContinue: () => void
  readonly onSkip: () => void
  readonly onOpenAudit: () => void
  /** Opens settings at the usage and error data switch. */
  readonly onUsageSettings?: () => void
}

/**
 * Read through the catalogue at call time, not built once at module load: a
 * frozen table would resolve before `useResolver` had run and freeze the
 * fallback into every screen.
 */
const STATE_KEY: Record<CheckState, string> = {
  running: 'firstRunStateRunning',
  ok: 'firstRunStateOk',
  unavailable: 'firstRunStateUnavailable',
  failed: 'firstRunStateFailed',
}

export function renderFirstRun(
  doc: Document,
  props: FirstRunProps,
  handlers: FirstRunHandlers,
): HTMLElement {
  const section = doc.createElement('section')
  section.setAttribute('data-role', 'first-run')

  const heading = doc.createElement('h1')
  heading.textContent = t('firstRunHeading')
  section.append(heading, intro(doc))

  const list = doc.createElement('ul')
  list.setAttribute('data-role', 'checks')
  for (const check of props.checks) list.append(row(doc, check))
  section.append(list, result(doc, props))

  const actions = doc.createElement('div')
  actions.setAttribute('data-role', 'actions')
  const cta = button(doc, 'continue', t('firstRunContinue'), handlers.onContinue, true)
  // A primary action with nothing behind it teaches people to ignore it.
  cta.disabled = props.findings === 0
  actions.append(
    cta,
    button(doc, 'skip', t('firstRunSkip'), handlers.onSkip),
    button(doc, 'what-this-sends', t('firstRunWhatSends'), handlers.onOpenAudit),
  )
  if (props.checks.some((c) => c.state === 'failed')) {
    actions.append(button(doc, 'retry', t('firstRunRetry'), handlers.onContinue))
  }
  section.append(actions)
  if (props.usage === 'on') section.append(usageNotice(doc, handlers.onUsageSettings))

  return section
}

function usageNotice(doc: Document, onSettings: (() => void) | undefined): HTMLElement {
  const block = doc.createElement('div')
  block.setAttribute('data-role', 'usage')
  const notice = doc.createElement('p')
  notice.setAttribute('data-role', 'usage-notice')
  notice.textContent = t('firstRunUsageNotice')
  block.append(notice, button(doc, 'usage-off', t('firstRunUsageOff'), () => onSettings?.()))
  return block
}

function intro(doc: Document): HTMLParagraphElement {
  const el = doc.createElement('p')
  el.setAttribute('data-role', 'intro')
  el.textContent = t('firstRunIntro')
  return el
}

function row(doc: Document, check: CheckRow): HTMLLIElement {
  const item = doc.createElement('li')
  item.setAttribute('data-role', 'check')
  item.setAttribute('data-state', check.state)

  const label = doc.createElement('span')
  label.setAttribute('data-role', 'check-label')
  label.textContent = check.label

  // The state is a word, not a colour or a spinner: a bare spinner tells the
  // reader that something is happening and nothing about what.
  const state = doc.createElement('span')
  state.setAttribute('data-role', 'check-state')
  state.textContent = t(STATE_KEY[check.state])

  const note = doc.createElement('span')
  note.setAttribute('data-role', 'check-note')
  note.textContent = check.note

  item.append(label, state, note)
  return item
}

function result(doc: Document, props: FirstRunProps): HTMLParagraphElement {
  const el = doc.createElement('p')
  el.setAttribute('data-role', 'result')

  const ran = props.checks.filter((c) => c.state === 'ok').length
  const incomplete = props.checks.some((c) => c.state === 'failed' || c.state === 'unavailable')

  const parts: string[] = []
  parts.push(
    props.findings === 0
      ? t('firstRunNothingFound', String(ran))
      : t('firstRunFound', String(props.findings)),
  )
  if (incomplete) {
    parts.push(t('firstRunPartial'))
  }

  el.textContent = parts.join(' ')
  return el
}

function button(
  doc: Document,
  role: string,
  label: string,
  onClick: () => void,
  primary = false,
): HTMLButtonElement {
  const el = doc.createElement('button')
  el.setAttribute('data-role', role)
  if (primary) el.setAttribute('data-primary', 'true')
  el.type = 'button'
  el.textContent = label
  el.addEventListener('click', onClick)
  return el
}
