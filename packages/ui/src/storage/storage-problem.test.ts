/** @vitest-environment happy-dom */
import { describe, expect, it, vi } from 'vitest'

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fromCatalogue, useResolver, type Catalogue } from '@okolos/i18n'

import {
  renderStorageProblem,
  type StorageProblemHandlers,
  type StorageProblemProps,
} from './storage-problem.js'

/** The shipped Russian catalogue: `default_locale` is `ru`, and a fake would let a missing key pass. */
const CATALOGUE = JSON.parse(
  readFileSync(
    path.resolve(import.meta.dirname, '../../../../apps/extension/_locales/ru/messages.json'),
    'utf8',
  ),
) as Catalogue

useResolver(fromCatalogue(CATALOGUE))

/**
 * The screen for a store this build cannot use, which did not exist.
 *
 * A profile written by a later build answers every read with a `VersionError`, so
 * the options page rendered the browser's sentence about requested and existing
 * versions **once per panel**, six times, in a page otherwise empty — and nothing
 * distinguished "your data is fine, this build is too old" from "the store is
 * damaged". The two have different remedies, and only one of them keeps the data.
 */

const PROPS: StorageProblemProps = {
  kind: 'from-a-newer-version',
  found: 9,
  expected: 4,
  detail: 'VersionError: The requested version (4) is less than the existing version (9)',
}

function handlers(overrides: Partial<StorageProblemHandlers> = {}): StorageProblemHandlers {
  return { onRetry: vi.fn(), onReset: vi.fn(), ...overrides }
}

function mount(props: StorageProblemProps = PROPS, h = handlers()): HTMLElement {
  const el = renderStorageProblem(document, props, h)
  document.body.replaceChildren(el)
  return el
}

const role = (root: HTMLElement, name: string) => root.querySelector<HTMLElement>(`[data-role=${name}]`)

describe('saying which of two different things happened', () => {
  it('names a rollback as a rollback, and says the data is intact', async () => {
    const why = role(mount(), 'storage-why')?.textContent ?? ''
    expect(why).toMatch(/более новой версией/i)
    expect(why, 'the sentence that decides whether the user reinstalls or clears').toMatch(
      /данные целы/i,
    )
  })

  it('gives a different sentence for a store whose shape is wrong', () => {
    // Updating does not fix this one, and saying so is the whole point of having
    // two sentences instead of one.
    const why = role(mount({ ...PROPS, kind: 'shape-incomplete' }), 'storage-why')?.textContent ?? ''
    expect(why).toMatch(/структура/i)
    expect(why).toMatch(/не поможет/i)
  })

  it('has a sentence for every problem the storage layer can report', () => {
    // A kind with no words renders as `[storageSomething]` on the one screen a
    // user reaches when nothing else works.
    for (const kind of ['from-a-newer-version', 'shape-incomplete', 'blocked', 'unknown'] as const) {
      const why = role(mount({ ...PROPS, kind }), 'storage-why')?.textContent ?? ''
      expect(why, `no words for ${kind}`).not.toMatch(/^\[/)
      expect(why.length, `no words for ${kind}`).toBeGreaterThan(20)
    }
  })
})

describe('the numbers that tell the user whether updating helps', () => {
  it('shows both versions when the profile’s could be read', () => {
    const line = role(mount(), 'storage-versions')?.textContent ?? ''
    expect(line).toContain('9')
    expect(line).toContain('4')
  })

  it('says nothing about versions rather than inventing one', () => {
    // `found` is null when the profile could not be opened even to be asked, and
    // "version null" would be worse than silence.
    expect(role(mount({ ...PROPS, found: null }), 'storage-versions')).toBeNull()
  })

  it('carries the underlying message verbatim, last', () => {
    // The sentence a bug report needs, and the one a user should not read first.
    const el = mount()
    expect(role(el, 'storage-detail')?.textContent).toBe(PROPS.detail)
    const order = [...el.querySelectorAll('[data-role]')].map((n) => n.getAttribute('data-role'))
    expect(order.indexOf('storage-detail')).toBeGreaterThan(order.indexOf('storage-why'))
  })
})

describe('the two things a person can do', () => {
  it('offers trying again as the primary action', () => {
    // The blocked case clears by itself once the other window closes, and
    // reinstalling the newer build makes the first case go away entirely.
    expect(role(mount(), 'storage-retry')?.getAttribute('data-primary')).toBe('true')
  })

  it('calls back on each', () => {
    const h = handlers()
    const el = mount(PROPS, h)
    role(el, 'storage-retry')?.click()
    role(el, 'storage-reset')?.click()
    expect(h.onRetry).toHaveBeenCalledTimes(1)
    expect(h.onReset).toHaveBeenCalledTimes(1)
  })

  it('says what clearing destroys, in the words the wipe dialog uses', () => {
    /**
     * This button deletes everything and there is no confirmation behind it —
     * the panel *is* the confirmation, and the note has to carry what the wipe
     * dialog's list carries, or the user is agreeing to a word.
     */
    const note = role(mount(), 'storage-reset-note')?.textContent ?? ''
    for (const kind of ['находки', 'журнал', 'настройки', 'списки блокировок']) {
      expect(note, `the note does not mention ${kind}`).toContain(kind)
    }
    expect(note).toMatch(/отменить нельзя/i)
  })

  it('is announced, because the user reached it by everything else failing', () => {
    expect(mount().getAttribute('role')).toBe('alert')
  })
})
