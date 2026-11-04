/** @vitest-environment happy-dom */
import { describe, expect, it, vi } from 'vitest'

import { renderFirstRun, type CheckRow } from './screen.js'

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

/**
 * The catalogue entry, or a failure that names the missing key.
 *
 * A test that reaches for `CATALOGUE.someKey.message` and finds `undefined`
 * fails somewhere else entirely, on a comparison against nothing — which is
 * the shape this project keeps catching. This says which key is absent.
 */
function message(key: string): string {
  const entry = CATALOGUE[key]
  if (!entry) throw new Error(`the shipped catalogue has no key "${key}"`)
  return entry.message
}

const handlers = { onContinue: vi.fn(), onSkip: vi.fn(), onOpenAudit: vi.fn() }

function rows(overrides: Partial<CheckRow>[] = []): CheckRow[] {
  const base: CheckRow[] = [
    { id: 'detector', label: 'Hidden-instruction detection', state: 'ok', note: 'active on every page you open' },
    { id: 'storage', label: 'Local storage', state: 'ok', note: 'ready' },
  ]
  return overrides.length > 0 ? (overrides as CheckRow[]) : base
}

describe('the first thing a new user sees', () => {
  it('lists every check by name rather than spinning without a label', () => {
    const el = renderFirstRun(document, { checks: rows(), findings: 0 }, handlers)
    const labels = [...el.querySelectorAll('[data-role=check-label]')].map((n) => n.textContent)
    expect(labels).toContain('Hidden-instruction detection')
    expect(el.querySelector('[data-role=spinner]:not([aria-label])')).toBeNull()
  })

  it('names what it did NOT check, and why', () => {
    // The scenario promises a scan of open tabs and installed extensions. Both
    // need permissions this version deliberately does not request, so the
    // screen says so instead of implying a scan that never ran.
    const el = renderFirstRun(
      document,
      {
        checks: rows([
          { id: 'detector', label: 'Hidden-instruction detection', state: 'ok', note: 'active' },
          {
            id: 'extensions',
            label: 'Installed extensions',
            state: 'unavailable',
            note: 'needs the extensions permission, which arrives with that feature',
          },
        ]),
        findings: 0,
      },
      handlers,
    )
    const unavailable = el.querySelector('[data-state=unavailable]')
    expect(unavailable?.textContent).toContain('needs the extensions permission')
  })

  it('says plainly that nothing was found, with what was actually checked', () => {
    const el = renderFirstRun(document, { checks: rows(), findings: 0 }, handlers)
    // Against the catalogue, not against one language's wording. Pinning the
    // English here is what made three of these tests fail the day the screen
    // started speaking the language it ships in.
    expect(el.querySelector('[data-role=result]')?.textContent).toContain(
      message('firstRunNothingFound').split('$')[0]?.trim(),
    )
    // The count is what this line promises — that the screen says how many
    // checks actually ran rather than implying all of them did. The number is
    // language-independent; the sentence around it is not.
    expect(el.querySelector('[data-role=result]')?.textContent).toContain('2')
  })

  it('offers the next action only when there is something to act on', () => {
    const clean = renderFirstRun(document, { checks: rows(), findings: 0 }, handlers)
    expect(clean.querySelector<HTMLButtonElement>('[data-role=continue]')?.disabled).toBe(true)

    const found = renderFirstRun(document, { checks: rows(), findings: 3 }, handlers)
    const cta = found.querySelector<HTMLButtonElement>('[data-role=continue]')
    expect(cta?.disabled).toBe(false)
    expect(cta?.textContent).toBe(message('firstRunContinue'))
  })

  it('links to the audit panel before asking for any trust', () => {
    const el = renderFirstRun(document, { checks: rows(), findings: 0 }, handlers)
    el.querySelector<HTMLButtonElement>('[data-role=what-this-sends]')?.click()
    expect(handlers.onOpenAudit).toHaveBeenCalled()
  })

  it('reports a failed check with its reason rather than hiding it', () => {
    const el = renderFirstRun(
      document,
      {
        checks: rows([
          { id: 'storage', label: 'Local storage', state: 'failed', note: 'database locked' },
        ]),
        findings: 0,
      },
      handlers,
    )
    expect(el.querySelector('[data-state=failed]')?.textContent).toContain('database locked')
    expect(el.querySelector('[data-role=retry]')).not.toBeNull()
  })

  it('says the run was partial when any check did not complete', () => {
    const el = renderFirstRun(
      document,
      {
        checks: rows([
          { id: 'a', label: 'One', state: 'ok', note: '' },
          { id: 'b', label: 'Two', state: 'failed', note: 'nope' },
        ]),
        findings: 0,
      },
      handlers,
    )
    expect(el.querySelector('[data-role=result]')?.textContent).toContain(message('firstRunPartial'))
  })
})

describe('the usage and error data notice (B-199, SCN-050)', () => {
  it('says what is sent and links to the switch, when collection is on', () => {
    const onUsageSettings = vi.fn()
    const el = renderFirstRun(document, { checks: rows(), findings: 0, usage: 'on' }, { ...handlers, onUsageSettings })
    expect(el.querySelector('[data-role=usage-notice]')?.textContent).toBe(message('firstRunUsageNotice'))
    const off = el.querySelector<HTMLButtonElement>('[data-role=usage-off]')
    expect(off?.textContent).toBe(message('firstRunUsageOff'))
    off?.click()
    expect(onUsageSettings).toHaveBeenCalledTimes(1)
  })

  it('says nothing about sending when nothing is sent: off, a Firefox that was not granted, or one with no consent', () => {
    for (const usage of ['off', 'unsupported'] as const) {
      const el = renderFirstRun(document, { checks: rows(), findings: 0, usage }, handlers)
      expect(el.querySelector('[data-role=usage-notice]')).toBeNull()
    }
    expect(renderFirstRun(document, { checks: rows(), findings: 0 }, handlers).querySelector('[data-role=usage-notice]')).toBeNull()
  })
})
