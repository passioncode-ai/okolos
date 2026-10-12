/** @vitest-environment happy-dom */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { renderTrusted, type TrustedDomain, type TrustedHandlers } from './trusted.js'

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

function handlers(overrides: Partial<TrustedHandlers> = {}): TrustedHandlers {
  return { onRevoke: vi.fn(), ...overrides }
}

const ENTRY: TrustedDomain = {
  domain: 'g00gle.com',
  grantedAt: '2026-08-05T12:34:56.000Z',
  reason: 'marked legitimate by the user',
}

function render(domains: readonly TrustedDomain[], h = handlers()): HTMLElement {
  const el = renderTrusted(document, { kind: 'ready', domains }, h)
  document.body.append(el)
  return el
}

/** The other half of the screen: it could not read the list at all. */
function renderUnread(message: string, h = handlers()): HTMLElement {
  const el = renderTrusted(document, { kind: 'error', message }, h)
  document.body.append(el)
  return el
}

const role = (root: HTMLElement, name: string) => root.querySelector<HTMLElement>(`[data-role=${name}]`)

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('taking trust back', () => {
  it('lists what the user trusted', () => {
    const el = render([ENTRY])
    expect(role(el, 'domain')?.textContent).toBe('g00gle.com')
  })

  it('revokes on request, naming the domain', () => {
    // The comparison view promises this in those words: "can be undone in
    // settings". Until this list existed the promise was false.
    const h = handlers()
    render([ENTRY], h).querySelector<HTMLElement>('[data-role=revoke]')?.click()
    expect(h.onRevoke).toHaveBeenCalledWith('g00gle.com')
  })

  it('says when the trust was granted, and why', () => {
    const el = render([ENTRY])
    expect(role(el, 'granted')?.textContent).toContain('2026-08-05')
    expect(role(el, 'granted')?.textContent).toContain('marked legitimate')
  })

  it('shows the date alone when there is no reason recorded', () => {
    const el = render([{ domain: 'bank.test', grantedAt: '2026-01-02T00:00:00.000Z' }])
    expect(role(el, 'granted')?.textContent).toBe('Отмечен 2026-01-02')
  })

  it('says taking one back takes effect at once', () => {
    expect(role(render([ENTRY]), 'trusted-note')?.textContent).toMatch(/сразу/i)
  })

  it('lists every entry, not just the first', () => {
    const el = render([ENTRY, { domain: 'other.test', grantedAt: '2026-02-02T00:00:00.000Z' }])
    expect(el.querySelectorAll('[data-role=trusted-row]')).toHaveLength(2)
  })
})

describe('when nothing is trusted', () => {
  it('says so, and says what would put something here', () => {
    // An empty area would read as a broken screen rather than an empty list.
    const el = render([])
    expect(role(el, 'trusted-empty')?.textContent).toMatch(/пока не отметили настоящим ни одного сайта/i)
    expect(el.querySelectorAll('[data-role=trusted-row]')).toHaveLength(0)
  })
})

describe('when the list could not be read', () => {
  it('says so, and does not render an empty list in its place', () => {
    /**
     * The reassuring answer is "you trust nothing", and it is possibly the wrong one. The
     * behaviour was already right — the options page built this sentence itself — but it
     * lived *beside* this renderer, so SCR-16's record named a file its error state was
     * not in, and no test here nor the axe sweep that walks this markup could reach it
     * (B-59).
     */
    const el = renderUnread('store unreadable: VersionError')

    expect(role(el, 'trusted-error')?.textContent).toContain('VersionError')
    expect(role(el, 'trusted-empty'), 'an empty state stood in for a failure').toBeNull()
    expect(el.querySelectorAll('[data-role=trusted-row]')).toHaveLength(0)
  })

  it('keeps the heading, so the screen is still the screen it was', () => {
    // A failure that replaces the whole surface leaves the user unsure which page they
    // are on; the area is addressed by hash and reached from a nav row that names it.
    const el = renderUnread('nope')
    expect(el.querySelector('h1')?.textContent).toBeTruthy()
    expect(el.getAttribute('data-role')).toBe('trusted')
  })

  it('offers nothing to revoke, because there is nothing it could name', () => {
    const el = renderUnread('nope')
    expect(el.querySelectorAll('button')).toHaveLength(0)
  })
})
