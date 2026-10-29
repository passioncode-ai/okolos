
import { t } from '@okolos/i18n'
import type { AuditEntry } from '@okolos/contracts'

import { exactInstant } from '../when.js'

/**
 * The self-audit panel: what left this device, and why.
 *
 * This surface is the product's central claim made checkable. Everything here
 * is read from the same journal the network layer writes to before it sends,
 * so the panel cannot show a rosier picture than reality — and the export
 * exists so the user can diff it against a browser network trace rather than
 * taking our word for it.
 */

export type PanelState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'empty' }
  | { readonly kind: 'error'; readonly message: string }
  | {
      readonly kind: 'ready'
      readonly entries: readonly AuditEntry[]
      /**
       * The start of the window `since` puts into words.
       *
       * The panel used to be handed everything `outbound_log` holds — retention is ninety
       * days — under a sentence reading "the last seven". Passing the boundary as an
       * instant keeps the clock with the caller and the filter here, where it is
       * deterministic: you cannot hand this screen a quarter of history and get a
       * seven-day sentence out of it.
       */
      readonly windowStartIso: string
      readonly since: string
      /** Which period the control shows as chosen. */
      readonly window: AuditWindow
    }

/** How far back the panel is looking. The instant is computed by the caller. */
export type AuditWindow = 'week' | 'all'

export interface PanelHandlers {
  readonly onExport: () => void
  readonly onRepair: () => void
  /**
   * The reader asked for a different period.
   *
   * SCR-10 promised "filters by period and feature" from the start. The feature filter is
   * deliberately not built — over six purposes at a handful of rows a day it is a control
   * that costs a line and answers nothing — but the period is real: retention is ninety days
   * and the default view is seven, so without this the other eighty-three are reachable only
   * by exporting the file.
   */
  readonly onWindow: (next: AuditWindow) => void
}

export function renderSelfAudit(
  doc: Document,
  state: PanelState,
  handlers: PanelHandlers,
): HTMLElement {
  const section = doc.createElement('section')
  section.setAttribute('data-role', 'self-audit')
  section.setAttribute('data-state', state.kind)

  const heading = doc.createElement('h1')
  heading.textContent = t('auditHeading')
  section.append(heading)

  switch (state.kind) {
    case 'loading':
      section.append(text(doc, 'status', t('auditReading')))
      return section

    case 'empty':
      // An empty table is a claim the reader has to interpret. A sentence is
      // the claim itself, and it is the one people install this product for.
      section.append(text(doc, 'empty', t('auditEmpty')))
      return section

    case 'error': {
      // Never an empty list on failure: silence would read as "nothing was
      // sent", which is precisely the lie this panel exists to prevent.
      section.append(
        text(doc, 'error', t('auditUnread', state.message)),
        text(doc, 'error-note', t('auditUnreadNote')),
        action(doc, 'repair', t('auditRepair'), handlers.onRepair),
      )
      return section
    }

    case 'ready': {
      const shown = [...state.entries].filter((e) => within(e, state.windowStartIso)).sort(newestFirst)
      section.append(
        text(doc, 'summary', summarise(shown, state.since)),
        windowControl(doc, state.window, handlers),
      )
      const list = doc.createElement('ol')
      list.setAttribute('data-role', 'entries')
      for (const entry of shown) list.append(row(doc, entry))
      section.append(list, action(doc, 'export', t('auditExport'), handlers.onExport))
      return section
    }
  }
}

/**
 * A value the store actually holds.
 *
 * Every row here is read straight out of IndexedDB, where the type is a promise rather
 * than a guarantee: a row written by an older build, or one a migration left half-done,
 * arrives with fields missing. The screen printed `источник: undefined` and three blank
 * lines for such a row — on the surface that carries the product's central claim.
 */
const said = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value : undefined

/**
 * Inside the window the sentence names.
 *
 * A row whose time is unreadable stays: this screen's failure direction is *understating*
 * what left, so a row it cannot place is one it must still show.
 */
function within(entry: AuditEntry, startIso: string): boolean {
  const at = said(entry.createdAt)
  return at === undefined || at >= startIso
}

/** Newest first, as the screen record says — and rows with no time first, not last. */
function newestFirst(a: AuditEntry, b: AuditEntry): number {
  const x = said(a.createdAt)
  const y = said(b.createdAt)
  if (x === undefined || y === undefined) return x === y ? 0 : x === undefined ? -1 : 1
  return x < y ? 1 : x > y ? -1 : 0
}

/**
 * The summary states what is absent as well as what is present. "12 requests" invites the
 * reader to wonder what was in them; naming that none carried a page address or the page's
 * content answers the question they actually have.
 *
 * It names no absence it cannot prove. Until 2026-08-21 the sentence ended "…no page
 * address, **email** or page content" unconditionally — while `docs/brand/facts.md` says in
 * its own table that `leak-lookup` sends the email address and `domain-status` sends the
 * domain. A list containing such a request, under a sentence denying it exists, is a false
 * privacy claim on the one screen built to be checked against a network trace.
 */
function summarise(entries: readonly AuditEntry[], since: string): string {
  const withOutcome = (outcome: string): number =>
    entries.filter((e) => said(e.outcome) === outcome).length
  const sent = withOutcome('sent')
  const blocked = withOutcome('blocked-by-redactor')
  const failed = withOutcome('failed')
  // Not `length - sent - blocked - failed` for its own sake: a row whose outcome the store
  // never recorded is a row this screen must count, because the alternative is a total
  // smaller than the list under it.
  const unrecorded = entries.length - sent - blocked - failed

  const parts = [t('auditSummarySent', String(sent), since)]
  if (failed > 0) parts.push(t('auditSummaryFailed', String(failed)))
  if (blocked > 0) parts.push(t('auditSummaryBlocked', String(blocked)))
  if (unrecorded > 0) parts.push(t('auditSummaryUnknownOutcome', String(unrecorded)))

  for (const [key, count] of carried(entries)) parts.push(t(key, String(count)))
  // The person's Have I Been Pwned key, counted on its own: the address count says a lookup
  // happened and would hide that a credential went with some of them (B-125). Read from the
  // shape the choke point recorded, which names the header and never its value.
  const keys = entries.filter((e) => (said(e.payloadShape) ?? '').includes(KEY_HEADER_SHAPE)).length
  if (keys > 0) parts.push(t('auditSummaryCarriedKey', String(keys)))

  const unreadable = entries.filter((e) => purposeKey(said(e.purpose) ?? '') === undefined).length
  // A purpose this build cannot read is a request whose payload it cannot vouch for, so it
  // does not: the absence claim is dropped and the reason is named in its place.
  if (unreadable > 0) parts.push(t('auditSummaryUnknownPurpose', String(unreadable)))
  else parts.push(t('auditSummaryNoContent'))

  return `${parts.join(' · ')}.`
}

/** What the rows shown did carry, counted by purpose — the facts table, in code. */
function carried(entries: readonly AuditEntry[]): ReadonlyArray<readonly [string, number]> {
  const counts = new Map<string, number>()
  for (const entry of entries) {
    const key = CARRIED_KEY[said(entry.purpose) ?? '']
    if (key !== undefined) counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts]
}

/**
 * The period control, and why there are two positions rather than a date picker.
 *
 * Retention is ninety days; the sentence above says seven. Two named periods answer the
 * question a reader of this screen actually has — "and before that?" — without inventing a
 * range nobody asked to specify. The chosen one is `aria-pressed`, so the state is available
 * to a screen reader and not only to the eye.
 */
function windowControl(doc: Document, chosen: AuditWindow, handlers: PanelHandlers): HTMLElement {
  const bar = doc.createElement('div')
  bar.setAttribute('data-role', 'window')

  /**
   * Both positions written out, rather than a loop over a pair.
   *
   * The loop built its role as `` `window-${which}` `` and read its message key out of a
   * tuple array, and **both were invisible to every static reader in this project**: the
   * wireframe generator reports roles it can see as literals, and the locale gate reads keys
   * out of `t('…')` calls and `*_KEY` tables. Two gates went red at once, and both were
   * right — a name assembled at runtime cannot be checked by anything that reads the source.
   */
  const week = action(doc, 'window-week', t('auditWindowWeek'), () => handlers.onWindow('week'))
  week.setAttribute('aria-pressed', String(chosen === 'week'))
  const all = action(doc, 'window-all', t('auditWindowAll'), () => handlers.onWindow('all'))
  all.setAttribute('aria-pressed', String(chosen === 'all'))

  bar.append(week, all)
  return bar
}

function row(doc: Document, entry: AuditEntry): HTMLLIElement {
  const item = doc.createElement('li')
  item.setAttribute('data-role', 'entry')
  item.setAttribute('data-entry', said(entry.id) ?? 'unrecorded')
  item.setAttribute('data-outcome', said(entry.outcome) ?? 'unrecorded')
  const at = said(entry.createdAt)
  const purpose = said(entry.purpose)
  const key = purpose === undefined ? undefined : purposeKey(purpose)
  const payload = said(entry.payloadShape)
  /**
   * Every field says which field it is.
   *
   * The row was five bare lines — an instant, a host, a purpose, a shape, a source — and a
   * reader had to know the order to know what they were looking at. Worse when a field was
   * missing: two rows of five lines and three lines read as the same shape with parts
   * silently absent. One label per line, from the same words the missing case uses, so
   * "куда: не записано" and "куда: api.pwnedpasswords.com" are the same sentence with
   * different news in it.
   */
  const unknown = t('auditFieldUnknown')

  /**
   * The row opens, and what is behind it is what the log holds — not "the exact bytes".
   *
   * SCR-10 promised "per-row detail with the exact bytes sent and redaction applied" for two
   * weeks, and the exact bytes are **deliberately not stored**: a leak lookup writes
   * `email:s***@example.test`, redacted at the point of writing, because this log is
   * exportable and wipeable and a log full of plaintext addresses would be a new secret
   * store of its own. So the detail says what did leave for that purpose and what was held
   * back — which is the question a reader has, and a stronger answer than a byte dump.
   *
   * A native `<details>` rather than a button and a state flag: keyboard support, an
   * accessible disclosure role, and nothing to keep in sync.
   */
  const disclosure = doc.createElement('details')
  disclosure.setAttribute('data-role', 'entry-detail')
  const summary = doc.createElement('summary')
  summary.setAttribute('data-role', 'entry-summary')
  disclosure.append(summary)
  item.append(disclosure)

  summary.append(
    // The instant to the second, not the minute: this log exists to be lined up against a
    // browser's own network panel, and the second is what makes two records comparable.
    text(doc, 'entry-time', t('auditWhen', at === undefined ? unknown : exactInstant(at))),
    text(doc, 'entry-destination', t('auditWhere', said(entry.destination) ?? unknown)),
    // The purpose id is the fallback on purpose: a destination this build does not have
    // wording for is still shown, named as the contract names it, rather than vanishing
    // from the log that exists to be complete.
    text(doc, 'entry-purpose', t('auditWhy', key !== undefined ? t(key) : (purpose ?? unknown))),
    // Translated on read, never on write. `payloadShape` is stored in the audit log, and a
    // log written in whatever language was active that day stops being one record. Only the
    // bare "none" is prose; `email:…` and `hash-prefix:…` are shapes, and shapes are the
    // same in every language.
    text(
      doc,
      'entry-payload',
      t(
        'auditWhat',
        payload === undefined ? unknown : payload === 'none' ? t('auditPayloadNone') : payload,
      ),
    ),
    text(doc, 'entry-trigger', t('auditTriggeredBy', said(entry.triggeredBy) ?? unknown)),
  )

  const outcome = said(entry.outcome)
  // `t('auditKeptUnknown')` spelled out, not reached through a `??` inside another call: the
  // locale gate reads keys from `t('…')` and from `*_KEY` tables, and a key hiding in an
  // expression reads as translated-and-never-shown.
  const kept = purpose === undefined ? undefined : KEPT_KEY[purpose]
  disclosure.append(
    text(doc, 'entry-kept', kept === undefined ? t('auditKeptUnknown') : t(kept)),
    text(
      doc,
      'entry-outcome',
      t('auditOutcome', outcome === undefined ? unknown : t(OUTCOME_KEY[outcome] ?? 'auditFieldUnknown')),
    ),
  )
  return item
}

/**
 * What each purpose sends, and what it holds back — the facts table, in code.
 *
 * `docs/brand/facts.md` carries the same six rows under "Что уходит с устройства", and a
 * gate compares that document against the tree. Kept beside `PURPOSE_KEY` because they
 * answer different questions: that one names the request, this one is what a person opens
 * the row to read.
 */
const KEPT_KEY: Record<string, string> = {
  'feed-update': 'auditKeptFeedUpdate',
  'model-update': 'auditKeptModelUpdate',
  'password-range': 'auditKeptPasswordRange',
  'leak-lookup': 'auditKeptLeakLookup',
  'file-hash': 'auditKeptFileHash',
  'domain-status': 'auditKeptDomainStatus',
}

/** The three outcomes the contract has, in words. A row with none says so instead. */
const OUTCOME_KEY: Record<string, string> = {
  sent: 'auditOutcomeSent',
  'blocked-by-redactor': 'auditOutcomeBlocked',
  failed: 'auditOutcomeFailed',
}

/** Keys, not sentences: a table of words built at module load resolves before
 * `useResolver` runs and freezes the fallback into every screen. */
const PURPOSE_KEY: Record<string, string> = {
  'feed-update': 'auditPurposeFeedUpdate',
  'model-update': 'auditPurposeModelUpdate',
  'password-range': 'auditPurposePasswordRange',
  'leak-lookup': 'auditPurposeLeakLookup',
  'file-hash': 'auditPurposeFileHash',
  'domain-status': 'auditPurposeDomainStatus',
}

/**
 * The two purposes that carry something of the user's, and the sentence each earns.
 *
 * Kept beside `PURPOSE_KEY` because they answer different questions — that one names the
 * request, this one names what was in it — and because the pair is what
 * `docs/brand/facts.md` documents.
 */
const CARRIED_KEY: Record<string, string> = {
  'leak-lookup': 'auditSummaryCarriedAddress',
  'domain-status': 'auditSummaryCarriedDomain',
}

/** How a leak lookup records that the person's key went in its header (`background/leaks.ts`). */
const KEY_HEADER_SHAPE = 'header:hibp-api-key'

const purposeKey = (purpose: string): string | undefined => PURPOSE_KEY[purpose]

function text(doc: Document, role: string, content: string): HTMLParagraphElement {
  const el = doc.createElement('p')
  el.setAttribute('data-role', role)
  el.textContent = content
  return el
}

function action(
  doc: Document,
  role: string,
  label: string,
  onClick: () => void,
): HTMLButtonElement {
  const el = doc.createElement('button')
  el.setAttribute('data-role', role)
  el.type = 'button'
  el.textContent = label
  el.addEventListener('click', onClick)
  return el
}
