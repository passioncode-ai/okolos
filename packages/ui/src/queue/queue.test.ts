/** @vitest-environment happy-dom */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Queue, QueueItem } from '@okolos/core-queue'

import { renderQueue, type QueueHandlers } from './queue.js'

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


function handlers(overrides: Partial<QueueHandlers> = {}): QueueHandlers {
  return {
    onAct: vi.fn(),
    onShowAll: vi.fn(),
    onResolve: vi.fn(),
    onDefer: vi.fn(),
    ...overrides,
  }
}

function item(overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    id: 'i1',
    severity: 'major',
    createdAt: '2026-08-05T00:00:00.000Z',
    fixability: 'one-click',
    summary: 'Hidden instruction on example.test',
    actionLabel: 'Neutralise it',
    ...overrides,
  }
}

function render(queue: Queue, h = handlers()): HTMLElement {
  const el = renderQueue(document, queue, h)
  document.body.append(el)
  return el
}

const role = (root: HTMLElement, name: string) => root.querySelector<HTMLElement>(`[data-role=${name}]`)

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('what the queue shows', () => {
  it('renders the items it was handed', () => {
    const el = render({ shown: [item(), item({ id: 'i2' })], hidden: 0, rankedBy: 'full' })
    expect(el.querySelectorAll('[data-role=item]')).toHaveLength(2)
  })

  it('says nothing needs the user when there is nothing', () => {
    const el = render({ shown: [], hidden: 0, rankedBy: 'full' })
    expect(role(el, 'queue-empty')?.textContent).toMatch(/от вас ничего не требуется/i)
  })

  it('counts what it holds back rather than hiding it', () => {
    const el = render({ shown: [item()], hidden: 12, rankedBy: 'full' })
    expect(role(el, 'show-all')?.textContent).toContain('12')
  })

  it('offers no "show all" when there is nothing behind it', () => {
    expect(role(render({ shown: [item()], hidden: 0, rankedBy: 'full' }), 'show-all')).toBeNull()
  })

  it('says when the ranking is reduced rather than presenting it as considered', () => {
    const el = render({ shown: [item()], hidden: 0, rankedBy: 'severity-only' })
    expect(role(el, 'ranking-note')?.textContent).toBe(message('queueSeverityOnly'))
  })
})

describe('the two verbs that let the list end', () => {
  it('marks an item done', () => {
    // Until these existed the only control opened the page, so the queue could
    // be read and never cleared — a finishable list with no finishing move.
    const h = handlers()
    const el = render({ shown: [item()], hidden: 0, rankedBy: 'full' }, h)
    role(el, 'resolve')?.click()
    expect(h.onResolve).toHaveBeenCalledWith('i1')
  })

  it('defers an item without pretending it is gone', () => {
    const h = handlers()
    const el = render({ shown: [item()], hidden: 0, rankedBy: 'full' }, h)
    role(el, 'defer')?.click()
    expect(h.onDefer).toHaveBeenCalledWith('i1')
  })

  it('keeps the item’s own action alongside them', () => {
    const el = render({ shown: [item()], hidden: 0, rankedBy: 'full' })
    const labels = [...el.querySelectorAll('[data-role=item-actions] button')].map(
      (button) => button.textContent,
    )
    expect(labels).toEqual(['Neutralise it', 'Готово', 'Не сейчас'])
  })
})

describe('a row says how serious and how recent, not only in colour', () => {
  /**
   * The queue is the screen a person acts from, and until 2026-08-21 a row was a sentence
   * and three buttons. **When** it happened was nowhere on it — the first thing that
   * decides whether a finding still matters — and severity was carried by a coloured strip
   * three pixels wide and nothing else. Colour as the sole carrier of meaning is WCAG
   * 1.4.1, and the accessibility sweep cannot see it: axe has no way to know the strip
   * means anything. Found by rendering the area and reading it.
   */
  const shown = (i: QueueItem): HTMLElement => {
    document.body.innerHTML = ''
    const el = renderQueue(document, { shown: [i], hidden: 0, rankedBy: 'full' }, handlers())
    document.body.append(el)
    return el
  }

  it('names the severity in words', () => {
    const el = shown(item({ severity: 'critical' }))
    expect(el.querySelector('[data-role=severity]')?.textContent).toBe(
      message('bannerSeverityCritical'),
    )
  })

  it('uses the same words as every other surface, for every severity', () => {
    for (const [severity, key] of [
      ['critical', 'bannerSeverityCritical'],
      ['major', 'bannerSeverityMajor'],
      ['minor', 'bannerSeverityMinor'],
      ['info', 'bannerSeverityInfo'],
    ] as const) {
      const el = shown(item({ severity }))
      expect(el.querySelector('[data-role=severity]')?.textContent, severity).toBe(message(key))
    }
  })

  it('says when it happened, through the shared rendering', () => {
    const el = shown(item({ createdAt: '2026-08-05T09:41:07.000Z' }))
    expect(el.querySelector('[data-role=when]')?.textContent).toBe('2026-08-05')
  })

  it('keeps the strip as well, because colour is a third signal and not the only one', () => {
    expect(shown(item({ severity: 'critical' })).querySelector('[data-role=item]')?.getAttribute('data-severity')).toBe(
      'critical',
    )
  })
})
