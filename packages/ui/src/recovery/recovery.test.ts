/** @vitest-environment happy-dom */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderRecovery, type RecoveryHandlers } from './recovery.js'

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { buildChecklist } from '@okolos/core-recovery'
import { fromCatalogue, useResolver, type Catalogue } from '@okolos/i18n'

/** The shipped Russian catalogue: `default_locale` is `ru`, and a fake would let a missing key pass. */
const CATALOGUE = JSON.parse(
  readFileSync(
    path.resolve(import.meta.dirname, '../../../../apps/extension/_locales/ru/messages.json'),
    'utf8',
  ),
) as Catalogue

useResolver(fromCatalogue(CATALOGUE))

function handlers(overrides: Partial<RecoveryHandlers> = {}): RecoveryHandlers {
  return { onToggle: vi.fn(), onArchive: vi.fn(), onCopy: vi.fn(), ...overrides }
}

function render(kind: string, progress: Array<{ stepId: string; doneAt: string }> = [], h = handlers()) {
  const el = renderRecovery(document, buildChecklist(kind, progress), h)
  document.body.append(el)
  return el
}

const role = (root: HTMLElement, name: string) => root.querySelector<HTMLElement>(`[data-role=${name}]`)

beforeEach(() => {
  document.body.innerHTML = ''
})

/** The catalogue key for a step's title, by the same rule the renderer uses. */
function titleKey(id: string): string {
  return `recoveryStepTitle${id.split('-').map((p) => (p[0] ?? '').toUpperCase() + p.slice(1)).join('')}`
}

/** The catalogue key for a step's reason. */
function whyKey(id: string): string {
  return `recoveryStepWhy${id.split('-').map((p) => (p[0] ?? '').toUpperCase() + p.slice(1)).join('')}`
}

describe('the list itself', () => {
  it('is ordered, with the most damaging step first', () => {
    const el = render('pasted-command')
    expect(el.querySelector('[data-role=step]')?.getAttribute('data-step')).toBe('disconnect')
  })

  it('gives every step its reason', () => {
    const el = render('pasted-command')
    for (const step of el.querySelectorAll('[data-role=step]')) {
      expect(step.querySelector('[data-role=why]')?.textContent?.length ?? 0).toBeGreaterThan(20)
    }
  })

  it('says which steps cannot be done here', () => {
    // Discovering that halfway through is where people stop.
    const el = render('pasted-command')
    expect(role(el, 'elsewhere')).not.toBeNull()
  })
})

describe('progress', () => {
  it('counts what is left', () => {
    expect(role(render('entered-password'), 'progress')?.textContent).toContain('4 steps left')
  })

  it('marks a finished step and reduces the count', () => {
    const el = render('entered-password', [{ stepId: 'change-password', doneAt: 'now' }])
    expect(el.querySelector('[data-step=change-password]')?.getAttribute('data-done')).toBe('true')
    expect(role(el, 'progress')?.textContent).toContain('3 steps left')
  })

  it('reports a step being ticked', () => {
    const h = handlers()
    const el = render('entered-password', [], h)
    el.querySelector<HTMLInputElement>('[data-role=done]')?.click()
    expect(h.onToggle).toHaveBeenCalledWith('change-password', true)
  })

  it('offers to archive only once everything is done', () => {
    expect(role(render('entered-password'), 'archive')).toBeNull()
    const all = buildChecklist('entered-password').steps.map((step) => ({ stepId: step.id, doneAt: 'now' }))
    expect(role(render('entered-password', all), 'archive')).not.toBeNull()
  })
})

describe('when we do not know what happened', () => {
  it('says the list is the broad one rather than answering a different question', () => {
    expect(role(render('something-nobody-defined'), 'generic')?.textContent).toMatch(/самый полный безопасный/i)
  })
})

describe('reachable without a mouse', () => {
  it('associates every checkbox with its label', () => {
    // A checkbox whose label is merely adjacent is an unlabelled checkbox to
    // everything except a sighted mouse user.
    const el = render('pasted-command')
    for (const item of el.querySelectorAll('[data-role=step]')) {
      const box = item.querySelector('input[type=checkbox]')
      const label = item.querySelector('label')
      expect(box?.id).toBeTruthy()
      expect(label?.getAttribute('for')).toBe(box?.id)
    }
  })
})

describe('taking the rest with you', () => {
  it('shows the remaining steps as text, whether or not the clipboard works', () => {
    // A clipboard permission the browser declines must not be the thing that
    // strands someone mid-recovery.
    const el = render('pasted-command')
    expect(role(el, 'portable-text')?.textContent).toContain(
      CATALOGUE.recoveryStepTitleDisconnect?.message,
    )
  })

  it('carries the reason with every step it carries', () => {
    /**
     * Moved here from `packages/core-recovery` on 2026-08-20 (B-75): the words left the
     * zero-dependency package, so the assertion about them followed the words rather
     * than being deleted with them. A list of bare instructions is followed once,
     * badly, and abandoned at the first inconvenient one.
     */
    const carried = role(render('pasted-command'), 'portable-text')?.textContent ?? ''
    for (const step of buildChecklist('pasted-command').steps) {
      const key = `recoveryStepWhy${step.id
        .split('-')
        .map((part) => part[0]?.toUpperCase() + part.slice(1))
        .join('')}`
      const why = CATALOGUE[key]?.message
      expect(why, `no catalogue entry for ${key}`).toBeDefined()
      expect(carried, `${step.id} travels without its reason`).toContain(why)
    }
  })

  it('numbers the carried steps from one, in the order the checklist gives', () => {
    const carried = role(render('pasted-command'), 'portable-text')?.textContent ?? ''
    const list = buildChecklist('pasted-command')
    expect(carried).toContain(`1. ${CATALOGUE[titleKey(list.steps[0]?.id ?? '')]?.message}`)
    expect(carried).toContain(`2. ${CATALOGUE[titleKey(list.steps[1]?.id ?? '')]?.message}`)
  })

  it('marks in the text the steps this browser cannot do', () => {
    // The distinction has to survive into the thing that travels; one that exists only
    // in the object never reaches the person reading it on their phone.
    const carried = role(render('pasted-command'), 'portable-text')?.textContent ?? ''
    expect(carried).toContain(CATALOGUE.recoveryPortableNotHere?.message)
  })

  it('says plainly when there is nothing left to carry', () => {
    const all = buildChecklist('entered-password').steps.map((step) => ({
      stepId: step.id,
      doneAt: 'now',
    }))
    // With everything done the block is replaced by the archive control, so the
    // sentence is checked where it is produced rather than where it is not shown.
    expect(CATALOGUE.recoveryPortableNothingLeft?.message).toBeDefined()
    expect(role(render('entered-password', all), 'archive')).not.toBeNull()
  })

  it('renders catalogue words for every step the package can produce', () => {
    /**
     * The invariant that replaced "every step says why" in the package, and it is
     * asserted **on the screen** rather than in the catalogue.
     *
     * The first version checked that `CATALOGUE[titleKey(id)]` exists — and a plant
     * that deleted an entry from the renderer's own `STEP_TITLE_KEY` table left it
     * green, because the message was still in the catalogue and nothing was looking at
     * what the label actually said. A step missing from the map renders its own id:
     * wrong and **visible**, which is the fallback this surface chose over an empty
     * label on the one screen a person opens in a panic — but visible only if somebody
     * looks. This looks.
     */
    for (const kind of ['pasted-command', 'entered-password', 'called-number', 'not-sure'] as const) {
      const el = render(kind)
      for (const step of buildChecklist(kind).steps) {
        const item = el.querySelector(`[data-step="${step.id}"]`)
        const label = item?.querySelector('label')?.textContent ?? ''
        const why = item?.querySelector('[data-role=why]')?.textContent ?? ''
        expect(label, `${step.id} shows its id instead of a title`).toBe(
          CATALOGUE[titleKey(step.id)]?.message,
        )
        expect(why, `${step.id} shows its id instead of a reason`).toBe(
          CATALOGUE[whyKey(step.id)]?.message,
        )
      }
    }
  })

  it('says how many of them this browser cannot do', () => {
    expect(role(render('pasted-command'), 'portable-why')?.textContent).toMatch(
      /нельзя сделать в этом браузере/i,
    )
  })

  it('says outright that nothing is sent anywhere', () => {
    // The alternative design — syncing the incident to a server so it appears
    // on the phone — is the one this product cannot make.
    expect(role(render('pasted-command'), 'portable-why')?.textContent).toMatch(/никуда не отправляется/i)
  })

  it('copies exactly what it displays', () => {
    const h = handlers()
    const el = render('pasted-command', [], h)
    role(el, 'copy')?.click()
    expect(h.onCopy).toHaveBeenCalledWith(role(el, 'portable-text')?.textContent)
  })

  it('renders the text even with no copy handler at all', () => {
    const el = renderRecovery(document, buildChecklist('pasted-command'), {
      onToggle: vi.fn(),
      onArchive: vi.fn(),
    })
    document.body.append(el)
    expect(el.querySelector('[data-role=portable-text]')).not.toBeNull()
    expect(el.querySelector('[data-role=copy]')).toBeNull()
  })

  it('offers nothing to carry once everything is done', () => {
    const all = buildChecklist('entered-password').steps.map((step) => ({
      stepId: step.id,
      doneAt: 'now',
    }))
    const el = render('entered-password', all)
    expect(role(el, 'portable')).toBeNull()
    expect(role(el, 'archive')).not.toBeNull()
  })
})
