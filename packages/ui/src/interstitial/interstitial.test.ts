/** @vitest-environment happy-dom */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fromCatalogue, useResolver, type Catalogue } from '@okolos/i18n'

import { renderInterstitial, type InterstitialHandlers, type InterstitialProps } from './interstitial.js'

/**
 * The words this screen shows are the shipped Russian ones, because
 * `default_locale` is `ru`. Installing the real catalogue rather than a fake
 * means these assertions check two things at once: that the screen says the
 * right thing, and that the catalogue has a message for every key it asks for.
 * A fake would let a missing key pass here and appear as `[blockBack]` on a
 * blocked page.
 */
const CATALOGUE = JSON.parse(
  readFileSync(
    path.resolve(import.meta.dirname, '../../../../apps/extension/_locales/ru/messages.json'),
    'utf8',
  ),
) as Catalogue

useResolver(fromCatalogue(CATALOGUE))

const PROPS: InterstitialProps = {
  url: 'https://bad.test/login',
  feed: 'OpenPhish',
  entryDate: '2026-08-03',
  feedAgeDays: 1,
}

function handlers(overrides: Partial<InterstitialHandlers> = {}): InterstitialHandlers {
  return { onBack: vi.fn(), onContinue: vi.fn(), onOwner: vi.fn(), ...overrides }
}

function render(props: InterstitialProps, h = handlers()): HTMLElement {
  const el = renderInterstitial(document, props, h)
  document.body.append(el)
  return el
}

const role = (root: HTMLElement, name: string) => root.querySelector<HTMLElement>(`[data-role=${name}]`)

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('on whose authority', () => {
  it('names the list and the date of its entry', () => {
    const el = render(PROPS)
    expect(role(el, 'source')?.textContent).toContain('OpenPhish')
    expect(role(el, 'source')?.textContent).toContain('2026-08-03')
  })

  it('says the source is unknown rather than dropping the line', () => {
    // A block whose origin is unknown is still a block, and the user is
    // entitled to know which of the two they are looking at.
    const el = render({ ...PROPS, feed: null, entryDate: null })
    expect(role(el, 'source')?.textContent).toMatch(/не удалось определить/i)
  })

  it('shows which page was stopped', () => {
    expect(role(render(PROPS), 'url')?.textContent).toBe('https://bad.test/login')
  })
})

describe('when the data is old', () => {
  it('says how old, so the user can weigh it', () => {
    const el = render({ ...PROPS, feedAgeDays: 30 })
    expect(role(el, 'stale')?.textContent).toContain('дней: 30')
  })

  it('stays quiet about a fresh list', () => {
    expect(role(render(PROPS), 'stale')).toBeNull()
  })

  it('stays quiet when the age is unknown, rather than implying freshness', () => {
    expect(role(render({ ...PROPS, feedAgeDays: null }), 'stale')).toBeNull()
  })
})

describe('the way out', () => {
  it('offers going back as the primary action', () => {
    const el = render(PROPS)
    expect(role(el, 'back')?.getAttribute('data-primary')).toBe('true')
  })

  it('lets the user continue, and says what continuing costs', () => {
    // A block with no way past it is a block people route around by turning the
    // extension off.
    const h = handlers()
    const el = render(PROPS, h)
    role(el, 'continue')?.click()
    expect(h.onContinue).toHaveBeenCalledTimes(1)
    expect(role(el, 'continue-note')?.textContent).toMatch(/запомнит|журнал/i)
  })

  it('gives a site owner somewhere to go', () => {
    const h = handlers()
    role(render(PROPS, h), 'owner')?.click()
    expect(h.onOwner).toHaveBeenCalledTimes(1)
  })
})
