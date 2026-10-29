/**
 * Data controls: export everything, or delete everything.
 *
 * The product's claim is that the user owns what it stores, and a claim whose
 * only implementation is an exported function nobody can call is not a claim —
 * that gap was REQ-32. Export needs no confirmation because nothing is lost;
 * wiping asks once, and the question names exactly what is about to go, since
 * "are you sure?" tells the reader nothing they did not already know.
 */

import { t } from '@okolos/i18n'

export interface WipeOutcome {
  readonly ok: boolean
  readonly failed: readonly string[]
}

/**
 * The Have I Been Pwned key (B-125): whether one is saved, and what to do with a new one.
 *
 * `saved` is a boolean and not the key, on purpose. A renderer that is never handed the
 * value cannot put it back on screen, and nothing a person does here needs it: replacing
 * pastes a new key over the old one, removing needs none.
 */
export interface LeakKeyPanel {
  readonly saved: boolean
  /** Called with a key that passed the shape check, already trimmed. */
  readonly onSave: (key: string) => void
  readonly onRemove: () => void
}

/**
 * Why a pasted key is refused before it is stored, or null when it may be.
 *
 * Deliberately loose: the provider's key format is theirs to change, so this refuses only
 * what can never be a header value: an empty field, a space or control character inside one
 * (what a careless paste brings), and a character outside printable ASCII (what retyping in
 * another keyboard layout brings). The last two are told apart because the remedy differs:
 * a person told to look for a space will not find a Cyrillic letter.
 */
export function leakKeyProblem(key: string): 'empty' | 'shape' | 'latin' | null {
  if (key === '') return 'empty'
  // A space, a control character or any other blank: code points up to U+0020, DEL, and \s.
  if (/\s/.test(key) || [...key].some((ch) => ch.charCodeAt(0) <= 0x20 || ch.charCodeAt(0) === 0x7f)) {
    return 'shape'
  }
  return /^[\x21-\x7e]+$/.test(key) ? null : 'latin'
}

export interface DataControlsHandlers {
  readonly onExport: () => Promise<void>
  readonly onWipe: () => Promise<WipeOutcome>
  /** Called only when everything really went, so the caller can repaint. */
  readonly onWiped: () => void
}

export function renderDataControls(
  doc: Document,
  handlers: DataControlsHandlers,
  /**
   * Catalogue keys for every kind of data the wipe clears, in the user's words
   * rather than store names.
   *
   * Passed in rather than written here, and the reason is not tidiness: this list
   * held five entries while the wipe cleared nine stores, so the confirmation
   * named findings, journal, audit, exceptions and settings while `models`,
   * `feeds`, `snapshots` and the password-reuse index went unmentioned. A
   * renderer cannot tell whether a list it was given is all of them; the storage
   * schema can, and `Record<StoreName, string>` there makes a new store fail the
   * build until it has words.
   */
  dataKinds: readonly string[],
  /** The key block, drawn under the data actions. Absent, the screen has no key block. */
  leakKey?: LeakKeyPanel,
): HTMLElement {
  // An empty list would render a confirmation that names nothing, which reads as
  // "nothing will be deleted" over a button that deletes everything. Refused
  // loudly at the seam rather than shown quietly.
  if (dataKinds.length === 0) {
    // i18n-exempt: a programming mistake at a seam, thrown before anything renders and
    // caught by nobody — the caller is a page in this repository, and the audience is
    // whoever is holding the debugger when it fires
    throw new Error('renderDataControls: the wipe confirmation must name what it deletes')
  }

  const section = doc.createElement('section')
  section.setAttribute('data-role', 'data-controls')

  // `h1`, like every other area of this page. It was the only `h2` of the nine, which put
  // the settings area's title a size smaller than its neighbours' and left the area with
  // no first-level heading at all — a difference the eye reads before any check does
  // (measured 2026-08-21 by rendering all nine).
  const heading = doc.createElement('h1')
  heading.textContent = t('dataHeading')
  section.append(
    heading,
    text(
      doc,
      'blurb',
      t('dataIntro'),
    ),
  )

  const actions = doc.createElement('div')
  actions.setAttribute('data-role', 'actions')
  actions.append(
    button(doc, 'export', t('dataExport'), () => void exportNow(), true),
    button(doc, 'wipe', t('dataWipe'), () => askFirst()),
  )
  section.append(actions)

  /**
   * The key block, last. What the export and wipe add later (the confirmation, a failure,
   * a retry) goes above it through `place`, so an answer stays next to the button it
   * answers rather than under an unrelated block.
   */
  const keyBlock = leakKey === undefined ? null : renderLeakKey(doc, leakKey)
  if (keyBlock !== null) section.append(keyBlock)
  const place = (el: HTMLElement): void => {
    if (keyBlock !== null) section.insertBefore(el, keyBlock)
    else section.append(el)
  }

  function askFirst(): void {
    if (section.querySelector('[data-role=confirm]')) return

    const confirm = doc.createElement('div')
    confirm.setAttribute('data-role', 'confirm')
    confirm.setAttribute('role', 'alertdialog')

    const list = doc.createElement('ul')
    for (const key of dataKinds) {
      const item = doc.createElement('li')
      item.textContent = t(key)
      list.append(item)
    }

    confirm.append(
      text(doc, 'confirm-title', t('dataConfirmTitle')),
      list,
      text(doc, 'confirm-note', t('dataConfirmNote')),
      button(doc, 'confirm-yes', t('dataConfirmYes'), () => void run()),
      button(doc, 'confirm-no', t('dataConfirmNo'), () => confirm.remove()),
    )
    place(confirm)
  }

  /**
   * Exporting, with the refusal on screen.
   *
   * It was `() => void handlers.onExport()`, so a rejected export was a click
   * that did nothing and said nothing. Whatever went wrong — the database, the
   * download — the user is owed the sentence.
   */
  async function exportNow(): Promise<void> {
    try {
      await handlers.onExport()
      note('export-failed', null)
    } catch (cause) {
      note('export-failed', t('dataExportFailed'), String(cause))
    }
  }

  /**
   * One slot per kind of note: set its words, or take it away.
   *
   * The rule is not "reuse the element" — a plant proved that branch made no
   * observable difference and it is gone. The rule is **where** this is called:
   * removing the old note before an `await` and appending after it is what
   * produced three identical failure lines from three clicks on a failing export,
   * because all three removed nothing, all three waited, and all three appended.
   * Both halves happen here, after the answer is known, and the clicks are the
   * user's — they will double-click, and the screen must hold one answer.
   */
  /**
   * One slot per role, replaced rather than appended — and the exception's own words under the
   * sentence rather than inside it.
   *
   * Both failures here used to read `t('dataExportFailed', String(cause))`, so a reader got a
   * Russian sentence with an English exception in the middle (B-117). The sentence is the
   * reader's; the diagnostic is what a bug report needs.
   */
  function note(role: string, content: string | null, diagnostic?: string): void {
    section.querySelector<HTMLElement>(`[data-role=${role}]`)?.remove()
    if (content === null) return
    const slot = text(doc, role, content)
    if (diagnostic !== undefined && diagnostic !== '') {
      const detail = doc.createElement('span')
      detail.setAttribute('data-role', `${role}-diagnostic`)
      detail.textContent = diagnostic
      slot.append(detail)
    }
    place(slot)
  }

  /** The retry button, created once however many failures pass through. */
  function offerRetry(): void {
    if (section.querySelector('[data-role=wipe-retry]')) return
    place(button(doc, 'wipe-retry', t('dataWipeRetry'), () => void run()))
  }

  async function run(): Promise<void> {
    section.querySelector('[data-role=confirm]')?.remove()

    /**
     * Three outcomes, and the third one used to be silence.
     *
     * `void run()` swallowed a rejection, and the confirmation had already been
     * removed by then: the user clicked "yes, delete it", the dialog vanished,
     * nothing was deleted, and a dialog vanishing is what success looks like. The
     * handler here opens the database first, so "could not start" is the ordinary
     * failure and not an exotic one.
     *
     * It is reported separately from a partial wipe because it is a different
     * fact. A partial wipe leaves some of the user's data gone and names which;
     * a wipe that never began leaves everything, and naming stores that were
     * never touched would be inventing a state.
     */
    let outcome: WipeOutcome
    try {
      outcome = await handlers.onWipe()
    } catch (cause) {
      note('wipe-failed', t('dataWipeUnavailable'), String(cause))
      offerRetry()
      return
    }

    if (outcome.ok) {
      // Nothing left to say about a failure that is over.
      note('wipe-failed', null)
      section.querySelector('[data-role=wipe-retry]')?.remove()
      handlers.onWiped()
      return
    }

    // A partial wipe reported as success is the one outcome that makes someone
    // stop checking, so the failure is named store by store.
    note('wipe-failed', t('dataWipePartial', outcome.failed.join(', ')))
    offerRetry()
  }

  return section
}

/**
 * The key block: what the key is for, where it goes, and whether one is saved.
 *
 * The field is `type=password` and is emptied the moment a key is accepted, before the
 * page has a chance to repaint: the key is on screen for as long as it takes to paste it.
 * A refusal is said in the block and leaves the text in the field, so a key pasted with a
 * stray space can be corrected rather than pasted again.
 */
function renderLeakKey(doc: Document, panel: LeakKeyPanel): HTMLElement {
  const block = doc.createElement('section')
  block.setAttribute('data-role', 'leak-key')

  const heading = doc.createElement('h2')
  heading.setAttribute('data-role', 'leak-key-title')
  heading.textContent = t('leakKeyTitle')

  const field = doc.createElement('input')
  field.type = 'password'
  field.setAttribute('data-role', 'leak-key-field')
  field.setAttribute('autocomplete', 'off')
  field.setAttribute('spellcheck', 'false')
  field.setAttribute('aria-label', t('leakKeyField'))
  field.placeholder = t('leakKeyField')

  const actions = doc.createElement('div')
  actions.setAttribute('data-role', 'leak-key-actions')

  function save(): void {
    const key = field.value.trim()
    const problem = leakKeyProblem(key)
    block.querySelector('[data-role=leak-key-needs]')?.remove()
    if (problem !== null) {
      actions.before(
        text(
          doc,
          'leak-key-needs',
          problem === 'empty'
            ? t('leakKeyEmpty')
            : problem === 'shape'
              ? t('leakKeyShape')
              : t('leakKeyLatin'),
        ),
      )
      return
    }
    field.value = ''
    panel.onSave(key)
  }

  field.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') save()
  })

  actions.append(
    button(doc, 'leak-key-save', panel.saved ? t('leakKeyReplace') : t('leakKeySave'), save, !panel.saved),
    ...(panel.saved ? [button(doc, 'leak-key-remove', t('leakKeyRemove'), () => panel.onRemove())] : []),
  )

  block.append(
    heading,
    text(doc, 'leak-key-blurb', t('leakKeyBlurb')),
    text(doc, 'leak-key-state', panel.saved ? t('leakKeySaved') : t('leakKeyNone')),
    field,
    actions,
  )
  return block
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
