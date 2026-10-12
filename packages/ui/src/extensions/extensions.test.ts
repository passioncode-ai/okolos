/** @vitest-environment happy-dom */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { InventoryChange } from '@okolos/core-extensions'

import { renderExtensions, type ExtensionsHandlers, type ExtensionsState } from './extensions.js'

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

function handlers(overrides: Partial<ExtensionsHandlers> = {}): ExtensionsHandlers {
  return { onDisable: vi.fn(), onTrust: vi.fn(), onInspect: vi.fn(), ...overrides }
}

const CHANGE: InventoryChange = {
  kind: 'permission-added',
  id: 'abc',
  name: 'Colour Picker',
  permissions: ['cookies'],
  severity: 'critical',
}

const NOTE =
  'No browser hands one extension another’s code, so nothing here can be analysed on its own.'

const ROW = { id: 'abc', name: 'Colour Picker', version: '2.0.0', permissions: ['storage'], enabled: true }

function render(state: ExtensionsState, h = handlers()): HTMLElement {
  const el = renderExtensions(document, state, h)
  document.body.append(el)
  return el
}

const role = (root: HTMLElement, name: string) => root.querySelector<HTMLElement>(`[data-role=${name}]`)

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('the delta comes first', () => {
  it('shows what changed above the inventory', () => {
    const el = render({ kind: 'ready', changes: [CHANGE], installed: [ROW], analysis: null, analysisNote: NOTE })
    const roles = [...el.querySelectorAll('[data-role=change], [data-role=installed]')].map((node) =>
      node.getAttribute('data-role'),
    )
    expect(roles[0]).toBe('change')
  })

  it('says what the change actually was', () => {
    const el = render({ kind: 'ready', changes: [CHANGE], installed: [], analysis: null, analysisNote: NOTE })
    // The permission name, unchanged — a person checking the extension's own listing
    // has to find the same word there. The sentence around it is `changeSentence`'s,
    // and `words.test.ts` holds it to the catalogue.
    expect(role(el, 'detail')?.textContent).toContain('cookies')
  })

  it('carries the severity, so the styling has something to key off', () => {
    const el = render({ kind: 'ready', changes: [CHANGE], installed: [], analysis: null, analysisNote: NOTE })
    expect(role(el, 'change')?.getAttribute('data-severity')).toBe('critical')
  })

  it('says plainly when nothing changed', () => {
    const el = render({ kind: 'ready', changes: [], installed: [ROW], analysis: null, analysisNote: NOTE })
    expect(role(el, 'no-changes')?.textContent).toMatch(/ничего не изменилось/i)
  })
})

describe('the action is real', () => {
  it('disables the extension the change was about', () => {
    // A security screen whose only verb is "review" leaves the user exactly
    // where they started.
    const h = handlers()
    const el = render({ kind: 'ready', changes: [CHANGE], installed: [], analysis: null, analysisNote: NOTE }, h)
    role(el, 'change-actions')?.querySelector<HTMLElement>('[data-role=disable]')?.click()
    expect(h.onDisable).toHaveBeenCalledWith('abc')
  })

  it('lets the user accept a change instead', () => {
    const h = handlers()
    const el = render({ kind: 'ready', changes: [CHANGE], installed: [], analysis: null, analysisNote: NOTE }, h)
    role(el, 'trust')?.click()
    expect(h.onTrust).toHaveBeenCalledWith('abc')
  })

  it('offers disabling from the inventory too, not only from a change', () => {
    const h = handlers()
    const el = render({ kind: 'ready', changes: [], installed: [ROW], analysis: null, analysisNote: NOTE }, h)
    role(el, 'installed')?.querySelector<HTMLElement>('[data-role=disable]')?.click()
    expect(h.onDisable).toHaveBeenCalledWith('abc')
  })

  it('does not offer to disable something already off', () => {
    const el = render({
      kind: 'ready',
      changes: [],
      installed: [{ ...ROW, enabled: false }],
      analysis: null,
      analysisNote: NOTE,
    })
    expect(role(el, 'installed')?.querySelector('[data-role=disable]')).toBeNull()
    expect(role(el, 'disabled')?.textContent).toMatch(/уже отключено/i)
  })
})

describe('what it will not claim', () => {
  it('never shows an empty list in place of a failure', () => {
    const el = render({ kind: 'error', message: 'the store is unreadable' })
    expect(role(el, 'error-note')?.textContent).toMatch(/не значит, что ничего не изменилось/i)
    expect(role(el, 'no-changes')).toBeNull()
  })

  it('says when this browser will not answer at all', () => {
    const el = render({ kind: 'unsupported', why: 'this browser does not let an extension read the others' })
    expect(role(el, 'unsupported')?.textContent).toMatch(/does not let/i)
  })

  it('states when a package could not be read rather than implying it was clean', () => {
    const el = render({ kind: 'ready', changes: [], installed: [ROW], analysis: null, analysisNote: NOTE })
    expect(role(el, 'analysis-note')?.textContent).toMatch(/nothing here can be analysed/i)
  })
})

describe('inspecting a package the user supplies', () => {
  const REPORT = {
    findings: [
      { kind: 'remote-code' as const, evidence: 'importScripts("https://cdn.test/x.js")', where: 'a.js' },
    ],
    endpoints: ['https://cdn.test'],
    minified: false,
  }

  it('explains why nothing can be analysed on its own', () => {
    // Silence here would read as "nothing to report" rather than "this cannot
    // be done from a browser extension at all".
    const el = render({ kind: 'ready', changes: [], installed: [], analysis: null, analysisNote: NOTE })
    expect(role(el, 'analysis-note')?.textContent).toMatch(/nothing here can be analysed/i)
  })

  it('offers a file the user chooses, and labels the control', () => {
    const el = render({ kind: 'ready', changes: [], installed: [], analysis: null, analysisNote: NOTE })
    const picker = role(el, 'inspect') as HTMLInputElement
    expect(picker.type).toBe('file')
    expect(el.querySelector('label')?.getAttribute('for')).toBe(picker.id)
  })

  it('shows what was found, verbatim', () => {
    const el = render({
      kind: 'ready',
      changes: [],
      installed: [],
      analysis: REPORT,
      analysisNote: NOTE,
    })
    expect(role(el, 'evidence')?.textContent).toContain('importScripts')
    expect(role(el, 'finding')?.getAttribute('data-kind')).toBe('remote-code')
  })

  it('shows the report’s own caveat beside its findings', () => {
    // Evidence, not an accusation: eval appears in polyfills and minified code
    // looks obfuscated. Filing that away would turn a list into a verdict.
    const el = render({
      kind: 'ready',
      changes: [],
      installed: [],
      analysis: REPORT,
      analysisNote: NOTE,
    })
    // The caveat is the difference between evidence and an accusation, so it is shown
    // rather than filed away. Its words come from the catalogue now (B-75), which is
    // why this asserts the shipped message rather than an English phrase.
    expect(role(el, 'analysis-caveat')?.textContent).toBe(
      CATALOGUE['extensionsAnalysisReadable']?.message,
    )
  })

  it('says plainly when a clean file is clean', () => {
    const el = render({
      kind: 'ready',
      changes: [],
      installed: [],
      analysis: { findings: [], endpoints: [], minified: false },
      analysisNote: NOTE,
    })
    expect(role(el, 'analysis-summary')?.textContent).toMatch(/ничего примечательного/i)
  })
})

describe('when there is nothing to watch', () => {
  it('says no other extensions are installed, rather than only "nothing changed"', () => {
    /**
     * Two true sentences that together mislead: a heading with no rows under "nothing has
     * changed since the last check" reads as "we looked and there is nothing to say",
     * when the fact is that there is nothing to look at. SCR-09 records this state and
     * the screen did not build it (B-59).
     */
    const el = render({ kind: 'ready', changes: [], installed: [], analysis: null, analysisNote: NOTE })

    expect(role(el, 'none-installed')?.textContent).toBe(CATALOGUE['extensionsNoneInstalled']?.message)
  })

  it('does not say it when something is installed', () => {
    // The sentence is about an empty machine, not about a quiet week.
    const el = render({ kind: 'ready', changes: [], installed: [ROW], analysis: null, analysisNote: NOTE })
    expect(role(el, 'none-installed')).toBeNull()
  })

  it('counts what is installed from the catalogue, not from an English heading', () => {
    // `Installed (1)` and `Can use: cookies` were English on a ru-default screen, and the
    // sweep cannot see either: both are shorter than its three-word floor (B-76 records
    // the classes it does read; this is the one it structurally cannot).
    const el = render({ kind: 'ready', changes: [], installed: [ROW], analysis: null, analysisNote: NOTE })
    const heading = el.querySelector('[data-role=installed] h2')
    expect(heading?.textContent).toBe(
      CATALOGUE['extensionsInstalledCount']?.message.replace('$COUNT$', '1'),
    )
    expect(role(el, 'permissions')?.textContent).toContain('storage')
    expect(role(el, 'permissions')?.textContent).not.toContain('Can use')
  })
})

describe('what is true of an extension as it stands', () => {
  it('says a sideload is not from the store, on the row itself', () => {
    /**
     * The panel reported deltas and nothing else, so an extension that arrived by
     * sideload was reported exactly once: never, because arriving is not a change (B-56).
     */
    const el = render({
      kind: 'ready',
      changes: [],
      installed: [
        {
          ...ROW,
          standing: [
            {
              kind: 'not-from-store',
              id: ROW.id,
              name: ROW.name,
              severity: 'critical',
              installType: 'sideload',
            },
          ],
        },
      ],
      analysis: null,
      analysisNote: NOTE,
    })

    const note = el.querySelector('[data-standing=not-from-store]')
    expect(note?.textContent).toBe(CATALOGUE['extensionsNotFromStoreSideload']?.message)
    expect(note?.getAttribute('data-severity')).toBe('critical')
  })

  it('names both permissions of a pair, in the manifest\'s own words', () => {
    // A person checking the extension's listing has to find the same words there.
    const el = render({
      kind: 'ready',
      changes: [],
      installed: [
        {
          ...ROW,
          standing: [
            {
              kind: 'reads-everything-and-more',
              id: ROW.id,
              name: ROW.name,
              severity: 'critical',
              pair: ['cookies', 'webRequest'],
              everywhere: true,
            },
          ],
        },
      ],
      analysis: null,
      analysisNote: NOTE,
    })

    const note = el.querySelector('[data-standing=reads-everything-and-more]')
    expect(note?.textContent).toContain('cookies')
    expect(note?.textContent).toContain('webRequest')
    // And the sentence that says the pair is held everywhere rather than on one site.
    expect(note?.textContent).toContain(CATALOGUE['extensionsRiskyEverywhere']?.message)
  })

  it('leaves an ordinary row unmarked', () => {
    // The common case must stay silent, or the screen is noise and the one row that
    // matters is lost in it.
    const el = render({ kind: 'ready', changes: [], installed: [ROW], analysis: null, analysisNote: NOTE })
    expect(el.querySelector('[data-standing]')).toBeNull()
  })
})

describe('the actions offered follow the change, not the row', () => {
  /**
   * All five kinds got the same two buttons, and one of them cannot work: an extension
   * that is no longer installed has nothing to disable. Pressing it sent
   * `extensions/disable` for an id the browser does not have, which fails — so the screen
   * offered a person a remedy for a problem they could not apply it to, and answered with
   * an error. Found 2026-08-21 by rendering the area and reading it.
   */
  const kinds: readonly InventoryChange[] = [
    { kind: 'newly-installed', id: 'a', name: 'Alpha', severity: 'minor' },
    { kind: 'removed', id: 'b', name: 'Beta', severity: 'minor' },
    { kind: 'publisher-changed', id: 'c', name: 'Gamma', severity: 'critical', publisher: 'X', previousPublisher: 'Y' },
    { kind: 'permission-added', id: 'd', name: 'Delta', severity: 'critical', permissions: ['cookies'] },
    { kind: 'host-access-widened', id: 'e', name: 'Epsilon', severity: 'major', hosts: ['*://*/*'] },
  ]

  function buttonsFor(change: InventoryChange): string[] {
    document.body.innerHTML = ''
    const el = render({ kind: 'ready', changes: [change], installed: [], analysis: null, analysisNote: NOTE })
    return [...el.querySelectorAll('[data-role=change-actions] button')].map(
      (node) => node.getAttribute('data-role') ?? '',
    )
  }

  it('offers nothing to disable for an extension that is gone', () => {
    expect(buttonsFor(kinds[1] as InventoryChange)).toEqual(['trust'])
  })

  it('still lets the change be acknowledged, which is the one thing left to do about it', () => {
    const onTrust = vi.fn()
    const el = render(
      { kind: 'ready', changes: [kinds[1] as InventoryChange], installed: [], analysis: null, analysisNote: NOTE },
      handlers({ onTrust }),
    )
    el.querySelector<HTMLButtonElement>('[data-role=trust]')?.click()
    expect(onTrust).toHaveBeenCalledWith('b')
  })

  it('offers both to every change about an extension that is still there', () => {
    for (const change of kinds.filter((c) => c.kind !== 'removed')) {
      expect(buttonsFor(change), change.kind).toEqual(['disable', 'trust'])
    }
  })
})
