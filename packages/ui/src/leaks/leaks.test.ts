/** @vitest-environment happy-dom */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mergeLeaks } from '@okolos/core-leaks'

import { renderLeaks, type LeaksHandlers, type LeaksState } from './leaks.js'

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

function handlers(overrides: Partial<LeaksHandlers> = {}): LeaksHandlers {
  return {
    onCheck: vi.fn(),
    onResolve: vi.fn(),
    onChangePassword: vi.fn(),
    ...overrides,
  }
}

function render(state: LeaksState, h = handlers()): HTMLElement {
  const el = renderLeaks(document, state, h)
  document.body.append(el)
  return el
}

const role = (root: HTMLElement, name: string) => root.querySelector<HTMLElement>(`[data-role=${name}]`)

const NOW = '2026-08-06T00:00:00.000Z'

const LEAK = {
  name: 'ExampleCorp',
  occurredAt: '2024-03-01',
  source: 'HIBP',
  classes: ['email addresses', 'passwords'],
}

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('the number and its basis', () => {
  it('shows the coverage line beside the total, not beneath the fold', () => {
    const inventory = mergeLeaks([
      { name: 'HIBP', answered: true, leaks: [LEAK] },
      { name: 'Cavalier', answered: false, why: 'timed out' },
    ])
    const el = render({ kind: 'ready', inventory, now: NOW })

    expect(role(el, 'total')?.textContent).toContain('Найдено утечек: 1')
    expect(role(el, 'coverage')?.textContent).toMatch(/список может быть неполным/i)
  })

  it('says what a clean result was checked against', () => {
    const inventory = mergeLeaks([{ name: 'HIBP', answered: true, leaks: [] }])
    const el = render({ kind: 'ready', inventory, now: NOW })
    expect(role(el, 'total')?.textContent).toMatch(/утечек не найдено/i)
    expect(role(el, 'coverage')?.textContent).toContain('HIBP')
  })

  it('lists what each breach exposed', () => {
    const inventory = mergeLeaks([{ name: 'HIBP', answered: true, leaks: [LEAK] }])
    const el = render({ kind: 'ready', inventory, now: NOW })
    expect(role(el, 'classes')?.textContent).toContain('Утекло:')
  })

  it('lets the user mark one as dealt with', () => {
    const h = handlers()
    const inventory = mergeLeaks([{ name: 'HIBP', answered: true, leaks: [LEAK] }])
    render({ kind: 'ready', inventory, now: NOW }, h).querySelector<HTMLElement>('[data-role=resolve]')?.click()
    expect(h.onResolve).toHaveBeenCalledWith('ExampleCorp')
  })
})

describe('before and during', () => {
  it('says what checking will send before it is asked for', () => {
    // This asserted the word "hashed", and so pinned a false claim in place:
    // the leak sources take no hash, and the address itself is what goes. A
    // test can hold a lie steady as easily as a truth.
    const idle = role(render({ kind: 'idle' }), 'idle')?.textContent ?? ''
    expect(idle, 'the idle state must say the address is sent').toMatch(/отправит ваш адрес/i)
    expect(idle, 'and must not imply the leak check is hashed').not.toMatch(/hashed form/i)
    expect(idle, 'while keeping the password check distinct').toMatch(/по префиксу хеша/i)
  })

  it('says it is working rather than showing an empty list', () => {
    const el = render({ kind: 'checking' })
    expect(role(el, 'status')).not.toBeNull()
    expect(role(el, 'total')).toBeNull()
  })
})

describe('when it fails', () => {
  it('never lets a failure read as good news', () => {
    const el = render({ kind: 'error', message: 'the network is unavailable' })
    expect(role(el, 'error-note')?.textContent).toMatch(/не значит, что ничего не утекло/i)
    expect(role(el, 'total')).toBeNull()
  })
})

describe('the credit the data carries with it', () => {
  it('names Have I Been Pwned and CC BY 4.0 on the screen that shows its data', () => {
    // The licence requires attribution wherever the data appears. A README a
    // user never opens is not where it appears.
    const inventory = mergeLeaks([{ name: 'HIBP', answered: true, leaks: [LEAK] }])
    const el = render({ kind: 'ready', inventory, now: NOW })
    expect(role(el, 'attribution')?.textContent).toContain('Have I Been Pwned')
    expect(role(el, 'attribution')?.textContent).toContain('CC BY 4.0')
  })

  it('carries it in every state, including the one that found nothing', () => {
    // "Nothing found" is still a result computed from someone else's work.
    for (const state of [
      { kind: 'idle' } as const,
      { kind: 'checking' } as const,
      { kind: 'error', message: 'offline' } as const,
      { kind: 'ready', inventory: mergeLeaks([{ name: 'HIBP', answered: true, leaks: [] }]), now: NOW } as const,
    ]) {
      document.body.innerHTML = ''
      expect(role(render(state), 'attribution')).not.toBeNull()
    }
  })
})

describe('the two piles, and what each is for', () => {
  const infection = {
    name: 'Infostealer infection',
    occurredAt: '2026-07-20',
    source: 'Hudson Rock Cavalier',
    classes: ['saved passwords', 'session cookies'],
  }

  it('separates a recent infection from an old breach', () => {
    // One list makes an infected machine look like a slightly newer breach.
    const inventory = mergeLeaks([{ name: 'HIBP', answered: true, leaks: [LEAK, infection] }])
    const el = render({ kind: 'ready', inventory, now: NOW })
    const urgencies = [...el.querySelectorAll('[data-role=leak-group]')].map((group) =>
      group.getAttribute('data-urgency'),
    )
    expect(urgencies).toEqual(['fresh-infostealer', 'historical'])
  })

  it('says why the urgent pile is urgent', () => {
    const inventory = mergeLeaks([{ name: 'Cavalier', answered: true, leaks: [infection] }])
    const el = render({ kind: 'ready', inventory, now: NOW })
    expect(role(el, 'group-why')?.textContent).toMatch(/сессионные куки/i)
  })
})

describe('the repair each entry offers', () => {
  const withDomain = { ...LEAK, domain: 'examplecorp.test' }

  it('offers the service its own change-password page', () => {
    const h = handlers()
    const inventory = mergeLeaks([{ name: 'HIBP', answered: true, leaks: [withDomain] }])
    render({ kind: 'ready', inventory, now: NOW }, h)
      .querySelector<HTMLElement>('[data-role=change-password]')
      ?.click()
    expect(h.onChangePassword).toHaveBeenCalledWith(expect.objectContaining({ domain: 'examplecorp.test' }))
  })

  it('says there is nowhere to send you when the source named no site', () => {
    // A button that guesses the address of a login page is worse than a
    // sentence admitting we do not have it.
    const inventory = mergeLeaks([{ name: 'HIBP', answered: true, leaks: [LEAK] }])
    const el = render({ kind: 'ready', inventory, now: NOW })
    expect(role(el, 'change-password')).toBeNull()
    expect(role(el, 'no-domain')?.textContent).toMatch(/ссылки на него нет/i)
  })

  it('offers no reuse check, because nothing records what would answer it', () => {
    // The button existed and opened a hash nothing read. There is no local
    // index of which sites saw which password hash, so the honest state is the
    // absence of the control rather than a view that answers "none found".
    const inventory = mergeLeaks([{ name: 'HIBP', answered: true, leaks: [LEAK] }])
    const el = render({ kind: 'ready', inventory, now: NOW })
    expect(el.querySelector('[data-role=check-reuse]')).toBeNull()
  })

  it('calls the resolve control what the screen record calls it', () => {
    const inventory = mergeLeaks([{ name: 'HIBP', answered: true, leaks: [LEAK] }])
    const el = render({ kind: 'ready', inventory, now: NOW })
    expect(role(el, 'resolve')?.textContent).toBe('Отметить решённым')
  })
})

describe('a press that cannot be honoured', () => {
  it('says why, rather than looking like a broken button', () => {
    // The idle state used to be the whole answer to a press with no address:
    // the page redrew identically and nothing was said. A user cannot tell
    // that from a button that does not work, and neither could a test — a real
    // defect hid behind a fifteen-second timeout for three days because the
    // failure looked exactly like the starting state.
    const el = render({ kind: 'idle', needs: 'Enter the email address you want checked.' })
    expect(role(el, 'needs')?.textContent).toMatch(/enter the email address/i)
  })

  it('says nothing extra when there is nothing to say', () => {
    expect(role(render({ kind: 'idle' }), 'needs')).toBeNull()
  })

  it('keeps the check available so the refusal is recoverable', () => {
    const el = render({ kind: 'idle', needs: 'Enter the email address you want checked.' })
    expect(role(el, 'check')).not.toBeNull()
  })
})

describe('where the address field goes', () => {
  /**
   * The panel does not build the field — the options page owns it, because it
   * has to survive a repaint that rebuilds everything around it. What the panel
   * owes is the place.
   *
   * Ordering it from a stylesheet was tried and measured: from outside the
   * panel a rule can only put the field before the whole thing or after it, and
   * after puts the input below the button that reads it.
   */
  it('names a place for it under the description', () => {
    const el = render({ kind: 'idle' })
    expect(el.querySelector('[data-role=address-slot]'), 'no slot for the field').not.toBeNull()
  })

  it('puts that place before the button that reads it', () => {
    const el = render({ kind: 'idle' })
    const roles = [...el.querySelectorAll('[data-role]')].map((n) => n.getAttribute('data-role'))
    expect(roles.indexOf('address-slot')).toBeGreaterThan(roles.indexOf('idle'))
    expect(roles.indexOf('address-slot')).toBeLessThan(roles.indexOf('check'))
  })

  it('offers that place in every state, or the field vanishes', () => {
    /**
     * The first version emitted the slot only when idle. The page re-attaches
     * the field by replacing the slot after each paint, so any state without
     * one is a state where the field is simply gone — including the state right
     * after a check finishes, which is when someone wants to try a second
     * address.
     */
    const states = [
      { kind: 'idle' } as const,
      { kind: 'checking' } as const,
      { kind: 'error', message: 'the source did not answer' } as const,
      {
        kind: 'ready' as const,
        inventory: mergeLeaks([{ name: 'HIBP', answered: true, leaks: [] }]),
        now: NOW,
      },
    ]
    for (const state of states) {
      const el = render(state)
      expect(el.querySelector('[data-role=address-slot]'), state.kind).not.toBeNull()
    }
  })
})
