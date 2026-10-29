import { t } from '@okolos/i18n'

import { groupLeaks, type Leak, type LeakInventory } from '@okolos/core-leaks'

/**
 * SCR-08 — what is known to have leaked, and what was not checked.
 *
 * The coverage line is not a footnote here; it sits with the total, because a
 * number whose basis is unstated is the thing this screen exists to replace. A
 * list assembled from two of three sources says so in the same breath as its
 * count, and "nothing found" from a source that never answered is never shown
 * as reassurance.
 *
 * The attribution is not decoration either. Have I Been Pwned's breach data is
 * CC BY 4.0, which requires credit wherever the data appears — so it appears
 * here, on the screen that shows it, rather than only in a README a user will
 * never open. It is rendered in every state, including the empty one: a result
 * of "nothing found" is still a result computed from someone else's work.
 */

/**
 * Required by CC BY 4.0 wherever the data is shown.
 *
 * A function, not a constant. It was a constant, and moving its words into the
 * catalogue turned it into a `t()` call evaluated at **import** time — before
 * any entry point installs a resolver — so the credit line rendered
 * `[leaksAttribution]` while every other string on the screen was fine. Only
 * the test that asserted the actual words noticed.
 */
export const hibpAttribution = (): string => t('leaksAttribution')

export type LeaksState =
  /** `needs` carries a refusal to state, so pressing the button is never silent. */
  | { readonly kind: 'idle'; readonly needs?: string }
  | { readonly kind: 'checking' }
  | { readonly kind: 'ready'; readonly inventory: LeakInventory; readonly now: string }
  | { readonly kind: 'error'; readonly message: string }

export interface LeaksHandlers {
  readonly onCheck: () => void
  readonly onResolve: (leakName: string) => void
  /** Opens the service's own password-change page, where it publishes one. */
  readonly onChangePassword: (leak: Leak) => void
  /**
   * Where the key field lives (SCR-12). Given by the page, which owns the addresses; when
   * absent the key line still says why, and offers no link.
   */
  readonly keyHref?: string
}

export function renderLeaks(doc: Document, state: LeaksState, handlers: LeaksHandlers): HTMLElement {
  const root = doc.createElement('section')
  root.setAttribute('data-role', 'leaks')
  root.setAttribute('data-state', state.kind)

  const heading = doc.createElement('h1')
  heading.textContent = t('leaksTitle')
  root.append(heading)

  if (state.kind === 'idle') {
    root.append(
      // This said the address is hashed and never sent. It is not: Hudson
      // Rock's Cavalier and HIBP's breached-account endpoint both answer only
      // to a full address, and both receive one. The sentence a user reads
      // before choosing must be the one that is true — the hashed check is the
      // password one, and conflating the two was the whole error.
      text(
        doc,
        'idle',
        t('leaksIdle'),
      ),
      // A button that does nothing is worse than one that refuses. Pressing
      // "Check now" without a usable address used to return in silence, which
      // reads as a broken product — and hid a real defect for three days
      // because the page looked exactly as it had before the click.
      ...(state.needs ? [text(doc, 'needs', state.needs)] : []),
      // Where the address field goes.
      //
      // The field itself is not built here: it is a long-lived node the options
      // page moves between repaints rather than rebuilds, because rebuilding it
      // threw away whatever was being typed. The panel names the place; the
      // page puts the node in it, synchronously, in the same statement as the
      // swap.
      //
      // Naming the place matters because the alternative was ordering it from a
      // stylesheet, and from outside the panel a rule can only put the field
      // before the whole thing or after it — after being below the button that
      // reads it.
      addressSlot(doc),
      button(doc, 'check', t('leaksCheck'), handlers.onCheck, true),
      attribution(doc),
    )
    return root
  }

  if (state.kind === 'checking') {
    root.append(text(doc, 'status', t('leaksChecking')), addressSlot(doc), attribution(doc))
    return root
  }

  if (state.kind === 'error') {
    root.append(
      text(doc, 'error', t('leaksErrorPrefix', state.message)),
      text(doc, 'error-note', t('leaksErrorNote')),
      addressSlot(doc),
      button(doc, 'check', t('leaksRetry'), handlers.onCheck),
      attribution(doc),
    )
    return root
  }

  const { inventory } = state
  root.append(
    text(
      doc,
      'total',
      inventory.leaks.length === 0
        ? t('leaksNone')
        : t('leaksFound', String(inventory.leaks.length)),
    ),
    // Always, and next to the number rather than beneath the fold.
    text(doc, 'coverage', coverageLine(inventory)),
    ...keyLines(doc, inventory, handlers.keyHref),
    addressSlot(doc),
  )

  // Grouped, not date-sorted: an infection and a 2016 breach need different
  // responses, and one list makes the first look like a newer version of the
  // second.
  for (const group of groupLeaks(inventory.leaks, state.now)) {
    const section = doc.createElement('section')
    section.setAttribute('data-role', 'leak-group')
    section.setAttribute('data-urgency', group.urgency)

    const title = doc.createElement('h2')
    title.textContent = `${t(group.titleKey)} (${group.leaks.length})`
    section.append(title, text(doc, 'group-why', t(group.whyKey)))

    for (const leak of group.leaks) section.append(leakRow(doc, leak, handlers))
    root.append(section)
  }

  root.append(button(doc, 'check', t('leaksCheckAgain'), handlers.onCheck), attribution(doc))
  return root
}

function attribution(doc: Document): HTMLElement {
  const el = doc.createElement('p')
  el.setAttribute('data-role', 'attribution')
  el.textContent = hibpAttribution()
  return el
}

function leakRow(doc: Document, leak: Leak, handlers: LeaksHandlers): HTMLElement {
  const row = doc.createElement('article')
  row.setAttribute('data-role', 'leak')
  row.setAttribute('data-leak', leak.name)
  row.append(
    text(doc, 'name', `${leak.name}${leak.occurredAt ? ` (${leak.occurredAt})` : ''}`),
    text(doc, 'classes', t('leaksExposed', leak.classes.join(', ') || t('leaksClassesUnknown'))),
  )

  const actions = doc.createElement('div')
  actions.setAttribute('data-role', 'leak-actions')

  if (leak.domain) {
    actions.append(
      button(doc, 'change-password', t('bannerActionPassword'), () => handlers.onChangePassword(leak), true),
    )
  } else {
    // No domain from the source means no page to send anyone to. A button that
    // guesses the address of a login page is worse than a sentence saying we
    // do not have it.
    row.append(
      text(doc, 'no-domain', t('leaksNoDomain')),
    )
  }

  // "Check reuse" stood here until 2026-08-08. It opened `options.html#reuse=`,
  // a hash nothing read, and behind it was supposed to be a local index of
  // which sites had seen which password hash. No such store was ever built —
  // `reuse` appeared in this repository exactly once outside this label, at the
  // line that produced the dead link. A control that cannot answer is worse
  // than none: an empty view reads as "no reuse found".
  actions.append(button(doc, 'resolve', t('leaksMarkResolved'), () => handlers.onResolve(leak.name)))
  row.append(actions)
  return row
}

/**
 * A source left unchecked for want of the person's key, said once, with the way to fix it.
 *
 * Only for that reason (B-125). Until 2026-10-29 nothing in the product could write the
 * key, so every check ended with Have I Been Pwned unchecked and the screen said only that
 * it "could not be reached". Other reasons stay in the coverage line: a timeout's remedy is
 * waiting, and a link to a setting that cannot help would be a wrong answer.
 */
function keyLines(doc: Document, inventory: LeakInventory, keyHref: string | undefined): HTMLElement[] {
  return inventory.sources.flatMap((source) => {
    if (source.answered || source.needsKey === undefined || !source.why) return []
    const line = text(doc, 'source-key', source.why)
    if (keyHref !== undefined) {
      const link = doc.createElement('a')
      link.setAttribute('data-role', 'add-key')
      link.href = keyHref
      link.textContent = source.needsKey === 'refused' ? t('leakKeyReplace') : t('leakKeyAdd')
      line.append(' ', link)
    }
    return [line]
  })
}

/**
 * The place the options page puts its live address field.
 *
 * Emitted in **every** state, not only the idle one. The page re-attaches the
 * field by replacing this slot after each paint; a state that omits it is a
 * state where the field simply vanishes — including the one right after a check
 * finishes, which is exactly when someone wants to try a second address.
 */
function addressSlot(doc: Document): HTMLElement {
  const slot = doc.createElement('span')
  slot.setAttribute('data-role', 'address-slot')
  return slot
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
  el.type = 'button'
  el.setAttribute('data-role', role)
  if (primary) el.setAttribute('data-primary', 'true')
  el.textContent = label
  el.addEventListener('click', onClick)
  return el
}

/**
 * What the total is a count of, composed here rather than in `core-leaks`.
 *
 * The sentence used to be built inside `mergeLeaks`, which meant a core package
 * held English prose and the screen could not be translated without translating
 * the package. The facts — which sources answered and which did not — are what a
 * core package should return; the sentence is presentation.
 */
function coverageLine(inventory: LeakInventory): string {
  const answered = inventory.sources.filter((source) => source.answered).map((s) => s.name)
  const silent = inventory.sources.filter((source) => !source.answered).map((s) => s.name)
  // Three cases, and the third is the one a test remembered: with nothing
  // answered, the two-branch version rendered "Checked against ." — a sentence
  // that says a check happened when none did.
  if (answered.length === 0) return t('leaksCoverageNone')
  return silent.length === 0
    ? t('leaksCoverage', answered.join(', '))
    : t('leaksCoverageIncomplete', answered.join(', '), silent.join(', '))
}
