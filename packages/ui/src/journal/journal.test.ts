/** @vitest-environment happy-dom */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { diffSince, type JournalEntry } from '@okolos/core-queue'

import { renderJournal, type JournalHandlers } from './journal.js'

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fromCatalogue, useResolver, type Catalogue } from '@okolos/i18n'

/** The shipped Russian catalogue: `default_locale` is `ru`, and a fake would let a missing key pass. */
const CATALOGUE = JSON.parse(
  readFileSync(
    path.resolve(import.meta.dirname, '../../../../apps/extension/_locales/ru/messages.json'),
    'utf8',
  ),
) as Catalogue

useResolver(fromCatalogue(CATALOGUE))

function entry(overrides: Partial<JournalEntry> = {}): JournalEntry {
  return {
    id: 'e1',
    createdAt: '2026-08-05T09:00:00.000Z',
    kind: 'verdict',
    summary: 'Hidden instruction found on example.test',
    automatic: true,
    ...overrides,
  }
}

const SINCE = '2026-08-04T00:00:00.000Z'

function handlers(overrides: Partial<JournalHandlers> = {}): JournalHandlers {
  return { onToggleHistory: vi.fn(), onOpenEntry: vi.fn(), ...overrides }
}

function render(entries: JournalEntry[], since: string | null, opts = {}, h = handlers()) {
  const el = renderJournal(document, diffSince(entries, since, opts), { retentionDays: 30 }, h)
  document.body.append(el)
  return el
}

function role(root: HTMLElement, name: string): HTMLElement | null {
  return root.querySelector(`[data-role=${name}]`)
}

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('what changed since last time', () => {
  it('shows the entries, grouped', () => {
    const el = render([entry(), entry({ id: 'e2', kind: 'action', automatic: false })], SINCE)
    expect(el.querySelectorAll('[data-role=group]')).toHaveLength(2)
    expect(el.querySelectorAll('[data-role=entry]')).toHaveLength(2)
  })

  it('says of each entry whether the product did it or the user did', () => {
    const el = render([entry({ automatic: true })], SINCE)
    expect(role(el, 'entry')?.textContent).toMatch(/сделано автоматически/i)
  })

  it('marks the ones the user chose as theirs', () => {
    const el = render([entry({ automatic: false })], SINCE)
    expect(role(el, 'entry')?.textContent).toMatch(/это сделали вы/i)
  })

  it('opens an entry on request', () => {
    const h = handlers()
    const el = render([entry({ id: 'e9' })], SINCE, {}, h)
    role(el, 'entry')?.click()
    expect(h.onOpenEntry).toHaveBeenCalledWith('e9')
  })
})

describe('the empty state says something', () => {
  it('names the moment nothing has changed since', () => {
    const el = render([], SINCE)
    expect(role(el, 'empty')?.textContent).toContain('2026-08-04')
  })

  it('says it plainly on a first-ever check', () => {
    const el = render([], null)
    expect(role(el, 'empty')?.textContent).toMatch(/первая проверка/i)
  })

  it('shows no group boxes when there is nothing to group', () => {
    const el = render([], SINCE)
    expect(el.querySelectorAll('[data-role=group]')).toHaveLength(0)
  })
})

describe('when part of the journal is unreadable', () => {
  it('says the view is incomplete instead of passing a short list off as all of it', () => {
    const el = render([entry()], SINCE, { unreadable: 3 })
    expect(role(el, 'incomplete')?.textContent).toContain('3')
  })

  it('stays quiet when nothing was lost', () => {
    expect(role(render([entry()], SINCE), 'incomplete')).toBeNull()
  })
})

describe('the rest of it', () => {
  it('offers full history without making it the default', () => {
    const h = handlers()
    const el = render([entry()], SINCE, {}, h)
    role(el, 'history')?.click()
    expect(h.onToggleHistory).toHaveBeenCalledTimes(1)
  })

  it('states how long anything is kept at all', () => {
    // The retention window is the reason full history is short. Saying it turns
    // a missing entry from a bug report into an expected outcome.
    const el = render([entry()], SINCE)
    expect(role(el, 'retention')?.textContent).toContain('30 дней')
  })
})

describe('a failure’s own words sit under the sentence, not inside it', () => {
  /**
   * Two writers interpolated `String(cause)` into a catalogue sentence, so a reader got a
   * Russian line with an English exception in the middle — "Проверка страницы не завершилась:
   * Error: the background service refused …". The text is worth keeping and worth keeping out
   * of the sentence (B-115).
   */
  const shown = (diagnostic?: string): HTMLElement =>
    render(
      [
        entry({
          kind: 'error',
          summary: 'Проверка страницы не завершилась.',
          ...(diagnostic === undefined ? {} : { diagnostic }),
        }),
      ],
      SINCE,
    )

  it('shows it as its own line when there is one', () => {
    expect(role(shown('Error: the background service refused'), 'entry-diagnostic')?.textContent).toBe(
      'Error: the background service refused',
    )
  })

  it('keeps the sentence free of it', () => {
    const line = role(shown('Error: refused'), 'entry-line')?.textContent ?? ''
    expect(line).not.toContain('Error: refused')
    expect(line).toContain('Проверка страницы не завершилась.')
  })

  it('draws no empty line when a record has none', () => {
    expect(role(shown(), 'entry-diagnostic')).toBeNull()
    expect(role(shown(''), 'entry-diagnostic')).toBeNull()
  })
})

describe('what an agent did (B-218 wave (c))', () => {
  it('says an agent did it, offers «Вернуть» beside the row, and says once it was undone', () => {
    const onUndo = vi.fn()
    const el = render(
      [
        entry({ id: 'a1', kind: 'action', automatic: false, byAgent: true, undo: 'available' }),
        entry({ id: 'a2', kind: 'action', automatic: false, byAgent: true, undo: 'done' }),
      ],
      null,
      {},
      handlers({ onUndo }),
    )
    expect(el.querySelector('[data-entry=a1] [data-role=entry-line]')?.textContent).toContain(CATALOGUE['journalByAgent']?.message as string)
    const undo = el.querySelector('[data-role=entry-undo]') as HTMLButtonElement
    expect(undo.textContent).toBe(CATALOGUE['journalUndo']?.message)
    expect(undo.closest('[data-role=entry]')).toBeNull()
    undo.click()
    expect(onUndo).toHaveBeenCalledWith('a1')
    expect(el.querySelector('[data-role=entry-undone]')?.textContent).toBe(CATALOGUE['journalUndone']?.message)
  })
})

