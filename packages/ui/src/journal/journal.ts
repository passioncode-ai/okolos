import { t } from '@okolos/i18n'

import type { Diff, DiffGroup, JournalEntry } from '@okolos/core-queue'
import { shortTime } from '../when.js'

/**
 * SCR-11 — the journal, shown as a diff.
 *
 * The default view is "since your last check", not "everything". A security
 * product whose history page is an ever-growing red list teaches people to stop
 * opening it, and the entry they needed to see is then buried under fifty they
 * already handled.
 *
 * Two honesty rules. Every entry says whether the product acted or the user
 * did, because "it was handled" means different things in those two cases. And
 * a partially unreadable journal says so — a short list that quietly omits
 * records reads as "little happened".
 */

/** Which kind gets which heading is a product decision; the word is a translation. */
const KIND_TITLE_KEY: Record<JournalEntry['kind'], string> = {
  verdict: 'journalKindVerdict',
  action: 'journalKindAction',
  error: 'journalKindError',
}

export interface JournalMeta {
  readonly retentionDays: number
}

export interface JournalHandlers {
  readonly onToggleHistory: () => void
  readonly onOpenEntry: (entryId: string) => void
  /** Undoes what an agent did that lowered a protection (B-218 wave (c), WC-2). */
  readonly onUndo?: (entryId: string) => void
}

export function renderJournal(
  doc: Document,
  diff: Diff,
  meta: JournalMeta,
  handlers: JournalHandlers,
): HTMLElement {
  const root = doc.createElement('section')
  root.setAttribute('data-role', 'journal')

  const heading = doc.createElement('h1')
  heading.textContent = t('journalTitle')
  root.append(heading)

  if (diff.total === 0) {
    root.append(
      text(
        doc,
        'empty',
        diff.since === null
          ? t('journalEmpty')
          : t('journalNothingChanged', shortTime(diff.since)),
      ),
    )
  } else {
    for (const group of diff.groups) root.append(groupBlock(doc, group, handlers))
  }

  if (diff.incomplete) {
    root.append(
      text(
        doc,
        'incomplete',
        // English pluralisation on a ru-default surface, and invisible to the sweep
        // until its anchor learned to read a quote nested in a substitution (B-76).
        // Worded so no agreement by number is needed: Russian has three forms.
        t('journalIncomplete', String(diff.unreadable)),
      ),
    )
  }

  root.append(
    button(doc, 'history', t('journalShowHistory'), handlers.onToggleHistory),
    text(doc, 'retention', t('journalRetention', String(meta.retentionDays))),
  )

  return root
}

function groupBlock(doc: Document, group: DiffGroup, handlers: JournalHandlers): HTMLElement {
  const el = doc.createElement('section')
  el.setAttribute('data-role', 'group')
  el.setAttribute('data-kind', group.kind)

  const title = doc.createElement('h2')
  title.textContent = `${t(KIND_TITLE_KEY[group.kind])} (${group.entries.length})`
  el.append(title)

  for (const item of group.entries) {
    el.append(entryRow(doc, item, handlers))
    // Beside the row, not inside it: the row is itself a button.
    if (item.undo === 'available' && handlers.onUndo !== undefined) {
      const onUndo = handlers.onUndo
      const undo = button(doc, 'entry-undo', t('journalUndo'), () => onUndo(item.id))
      undo.setAttribute('data-entry', item.id)
      el.append(undo)
    } else if (item.undo === 'done') {
      el.append(text(doc, 'entry-undone', t('journalUndone')))
    }
  }
  return el
}

function entryRow(doc: Document, item: JournalEntry, handlers: JournalHandlers): HTMLElement {
  const row = doc.createElement('button')
  row.type = 'button'
  row.setAttribute('data-role', 'entry')
  row.setAttribute('data-entry', item.id)

  const line = doc.createElement('span')
  line.setAttribute('data-role', 'entry-line')
  line.textContent = `${shortTime(item.createdAt)} — ${item.summary} (${
    item.byAgent === true ? t('journalByAgent') : item.automatic ? t('journalAutomatic') : t('journalManual')
  })`
  row.append(line)

  /**
   * The underlying failure, under the sentence rather than inside it.
   *
   * Two writers used to interpolate `String(cause)` into a catalogue sentence, so the reader
   * got a Russian line with an English exception in the middle. The developer-facing text is
   * worth keeping and worth keeping out of the sentence — shown last and muted, the way
   * SCR-20 shows the storage detail: what a bug report needs, not what a reader meets first
   * (B-115).
   */
  if (item.diagnostic !== undefined && item.diagnostic !== '') {
    const detail = doc.createElement('span')
    detail.setAttribute('data-role', 'entry-diagnostic')
    detail.textContent = item.diagnostic
    row.append(detail)
  }

  row.addEventListener('click', () => handlers.onOpenEntry(item.id))
  return row
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
