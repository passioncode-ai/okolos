/** @vitest-environment happy-dom */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { renderPopup, type PopupHandlers, type PopupState } from './popup.js'
import type { QueueItem } from '@okolos/core-queue'

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

/** The entry, or a failure that names the key rather than comparing to undefined. */
function message(key: string): string {
  const entry = CATALOGUE[key]
  if (!entry) throw new Error(`the shipped catalogue has no key "${key}"`)
  return entry.message
}


function handlers(overrides: Partial<PopupHandlers> = {}): PopupHandlers {
  return {
    onAct: vi.fn(),
    onShowAll: vi.fn(),
    onResolve: vi.fn(),
    onDefer: vi.fn(),
    onWhatChanged: vi.fn(),
    onOpen: vi.fn(),
    onRepair: vi.fn(),
    ...overrides,
  }
}

function item(overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    id: 'i1',
    severity: 'major',
    createdAt: '2026-08-02T00:00:00.000Z',
    fixability: 'one-click',
    summary: 'Hidden instruction on example.test',
    actionLabel: 'Neutralise it',
    ...overrides,
  }
}

const READY: PopupState = {
  kind: 'ready',
  page: { verdict: 'clean', reason: 'No hidden instructions found on this page.' },
  queue: { shown: [], hidden: 0, rankedBy: 'full' },
  changed: 0,
  lastCheck: '2026-08-05T09:00:00.000Z',
}

function render(state: PopupState, h = handlers()): HTMLElement {
  const el = renderPopup(document, state, h)
  document.body.append(el)
  return el
}

function role(root: HTMLElement, name: string): HTMLElement | null {
  return root.querySelector(`[data-role=${name}]`)
}

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('the three-second answer', () => {
  it('says whether this page is fine, and why', () => {
    const el = render(READY)
    expect(role(el, 'verdict')?.textContent).toContain('No hidden instructions')
  })

  it('does not claim a page is clean while it is still checking', () => {
    // A premature "clean" is the one thing this popup must never say.
    const el = render({ kind: 'loading' })
    expect(role(el, 'status')?.textContent).toMatch(/страница проверяется/i)
    expect(role(el, 'verdict')).toBeNull()
  })

  it('names the trouble when the page is not fine', () => {
    const el = render({
      ...READY,
      page: { verdict: 'finding', reason: 'Hidden text here addresses an assistant.' },
    })
    expect(el.getAttribute('data-verdict')).toBe('finding')
    expect(role(el, 'verdict')?.textContent).toContain('addresses an assistant')
  })
})

describe('what changed', () => {
  it('shows the count and offers the diff', () => {
    const h = handlers()
    const el = render({ ...READY, changed: 4 }, h)
    expect(role(el, 'changed')?.textContent).toContain('4')
    role(el, 'changed')?.click()
    expect(h.onWhatChanged).toHaveBeenCalledTimes(1)
  })

  it('says when it last looked rather than showing a bare zero', () => {
    const el = render(READY)
    const label = role(el, 'changed')?.textContent ?? ''
    // The moment, not the wording. This assertion used to match /nothing new/i,
    // which pinned one language's prose: the day the line moved into the
    // catalogue the test failed on a screen that had become more correct, not
    // less. What the control actually promises is that a zero is never shown
    // bare — it names the point it is counting from.
    expect(label).toContain('2026-08-05')
    expect(label.length).toBeGreaterThan('2026-08-05'.length)
  })
})

describe('the queue', () => {
  it('shows the items it was given', () => {
    const el = render({
      ...READY,
      queue: { shown: [item(), item({ id: 'i2' })], hidden: 0, rankedBy: 'full' },
    })
    expect(el.querySelectorAll('[data-role=item]')).toHaveLength(2)
  })

  it('never shows more than the queue handed it', () => {
    const shown = [item({ id: 'a' }), item({ id: 'b' }), item({ id: 'c' })]
    const el = render({ ...READY, queue: { shown, hidden: 12, rankedBy: 'full' } })
    expect(el.querySelectorAll('[data-role=item]')).toHaveLength(3)
  })

  it('counts what it is holding back instead of hiding it', () => {
    const el = render({ ...READY, queue: { shown: [item()], hidden: 12, rankedBy: 'full' } })
    expect(role(el, 'show-all')?.textContent).toContain('12')
  })

  it('offers no "show all" when there is nothing behind it', () => {
    const el = render({ ...READY, queue: { shown: [item()], hidden: 0, rankedBy: 'full' } })
    expect(role(el, 'show-all')).toBeNull()
  })

  it('runs the item’s own action, naming the item', () => {
    const h = handlers()
    const el = render({ ...READY, queue: { shown: [item()], hidden: 0, rankedBy: 'full' } }, h)
    role(el, 'act')?.click()
    expect(h.onAct).toHaveBeenCalledWith('i1')
  })

  it('says when the ranking is reduced rather than presenting it as considered', () => {
    const el = render({
      ...READY,
      queue: { shown: [item()], hidden: 0, rankedBy: 'severity-only' },
    })
    expect(role(el, 'ranking-note')?.textContent).toBe(message('queueSeverityOnly'))
  })

  it('is quiet about ranking when the ranking was complete', () => {
    const el = render({ ...READY, queue: { shown: [item()], hidden: 0, rankedBy: 'full' } })
    expect(role(el, 'ranking-note')).toBeNull()
  })

  it('says nothing needs the user when the queue is empty', () => {
    const el = render(READY)
    expect(role(el, 'queue-empty')?.textContent).toMatch(/от вас ничего не требуется/i)
  })
})

describe('when local data cannot be read', () => {
  it('states the failure and offers repair', () => {
    const h = handlers()
    const el = render({ kind: 'error', message: 'the database is locked' }, h)
    expect(role(el, 'error')?.textContent).toContain('the database is locked')
    role(el, 'repair')?.click()
    expect(h.onRepair).toHaveBeenCalledTimes(1)
  })

  it('never shows a clean verdict it could not compute', () => {
    const el = render({ kind: 'error', message: 'the database is locked' })
    expect(role(el, 'verdict')).toBeNull()
    expect(el.textContent).not.toMatch(/от вас ничего не требуется/i)
  })
})

describe('the way out', () => {
  it('links to the self-audit, the journal and settings', () => {
    const h = handlers()
    const el = render(READY, h)
    for (const target of ['self-audit', 'journal', 'settings']) {
      role(el, target)?.click()
      expect(h.onOpen).toHaveBeenCalledWith(target)
    }
  })
})
