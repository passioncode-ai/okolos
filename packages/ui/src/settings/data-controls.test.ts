/** @vitest-environment happy-dom */
import { describe, expect, it, vi } from 'vitest'

import {
  renderDataControls,
  type DataControlsHandlers,
  type LeakKeyPanel,
} from './data-controls.js'

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

function handlers(overrides: Partial<DataControlsHandlers> = {}): DataControlsHandlers {
  return {
    onExport: vi.fn(async () => undefined),
    onWipe: vi.fn(async () => ({ ok: true, failed: [] as string[] })),
    onWiped: vi.fn(),
    ...overrides,
  }
}

/**
 * A list this renderer is *given*, not the list it must be given.
 *
 * The renderer's promise is narrow on purpose: it names every kind handed to it and
 * refuses an empty hand. Whether that hand holds all nine stores is a fact about
 * the schema, which this package does not depend on — `tools/data-kinds.test.ts`
 * checks it, and checking it here would have meant retyping the store list, which
 * is exactly how the defect survived: the renderer held five of nine, its test held
 * the same five, and two copies of a wrong list read as confirmation.
 */
const KINDS = [
  'dataKindFindings',
  'dataKindJournal',
  'dataKindAudit',
  'dataKindExceptions',
  'dataKindSettings',
  'dataKindSnapshots',
  'dataKindModels',
  'dataKindFeeds',
  'dataKindReuse',
] as const

function mount(
  h = handlers(),
  kinds: readonly string[] = KINDS,
): { el: HTMLElement; h: DataControlsHandlers } {
  const el = renderDataControls(document, h, kinds)
  document.body.replaceChildren(el)
  return { el, h }
}

describe('leaving costs one click and no residue', () => {
  it('offers export without any confirmation — nothing is destroyed', async () => {
    const { el, h } = mount()
    el.querySelector<HTMLButtonElement>('[data-role=export]')?.click()
    expect(h.onExport).toHaveBeenCalledOnce()
    expect(el.querySelector('[data-role=confirm]')).toBeNull()
  })
})

describe('wiping asks once, and says what it will take', () => {
  it('does not delete on the first click', async () => {
    const { el, h } = mount()
    el.querySelector<HTMLButtonElement>('[data-role=wipe]')?.click()
    expect(h.onWipe).not.toHaveBeenCalled()
  })

  it('names every category it is about to delete', () => {
    const { el } = mount()
    el.querySelector<HTMLButtonElement>('[data-role=wipe]')?.click()
    const confirm = el.querySelector('[data-role=confirm]')?.textContent ?? ''
    // Every kind, by key. Listing the words here pinned the test to one language
    // and to the exact nouns, neither of which is what this control promises: it
    // promises to name everything it will delete. And the list comes from the
    // schema, because a list retyped in the test agrees with a wrong renderer.
    for (const key of KINDS) {
      expect(confirm, `the confirmation does not name ${key}`).toContain(message(key))
    }
  })

  it('draws one row per kind it was given, and no more', () => {
    // Counted as well as contained: `toContain` on the joined text passes when the
    // list is drawn twice, or when one row holds two kinds.
    const { el } = mount()
    el.querySelector<HTMLButtonElement>('[data-role=wipe]')?.click()
    expect(el.querySelectorAll('[data-role=confirm] li')).toHaveLength(KINDS.length)
  })

  it('refuses to render a confirmation that names nothing', () => {
    // An empty list would draw a dialog listing no data over a button that
    // deletes all of it, which reads as "nothing will be deleted". Louder at the
    // seam than wrong on the screen.
    expect(() => renderDataControls(document, handlers(), [])).toThrow(/must name what it deletes/)
  })

  it('deletes only after the second, explicit confirmation', async () => {
    const { el, h } = mount()
    el.querySelector<HTMLButtonElement>('[data-role=wipe]')?.click()
    el.querySelector<HTMLButtonElement>('[data-role=confirm-yes]')?.click()
    await vi.waitFor(() => expect(h.onWipe).toHaveBeenCalledOnce())
  })

  it('lets the user back out, leaving everything in place', () => {
    const { el, h } = mount()
    el.querySelector<HTMLButtonElement>('[data-role=wipe]')?.click()
    el.querySelector<HTMLButtonElement>('[data-role=confirm-no]')?.click()
    expect(h.onWipe).not.toHaveBeenCalled()
    expect(el.querySelector('[data-role=confirm]')).toBeNull()
  })
})

describe('a wipe that half-worked never reports success', () => {
  it('names the stores it could not clear and offers a retry', async () => {
    const h = handlers({ onWipe: vi.fn(async () => ({ ok: false, failed: ['journal'] })) })
    const { el } = mount(h)
    el.querySelector<HTMLButtonElement>('[data-role=wipe]')?.click()
    el.querySelector<HTMLButtonElement>('[data-role=confirm-yes]')?.click()

    await vi.waitFor(() => {
      const failure = el.querySelector('[data-role=wipe-failed]')?.textContent ?? ''
      expect(failure).toContain('journal')
      expect(failure).toContain(message('dataWipePartial').split('$')[0]?.trim())
    })
    expect(el.querySelector('[data-role=wipe-retry]')).not.toBeNull()
  })

  it('tells the caller only when everything really went', async () => {
    const h = handlers()
    const { el } = mount(h)
    el.querySelector<HTMLButtonElement>('[data-role=wipe]')?.click()
    el.querySelector<HTMLButtonElement>('[data-role=confirm-yes]')?.click()
    await vi.waitFor(() => expect(h.onWiped).toHaveBeenCalledOnce())
  })

  it('does not announce success when the wipe was partial', async () => {
    const h = handlers({ onWipe: vi.fn(async () => ({ ok: false, failed: ['settings'] })) })
    const { el } = mount(h)
    el.querySelector<HTMLButtonElement>('[data-role=wipe]')?.click()
    el.querySelector<HTMLButtonElement>('[data-role=confirm-yes]')?.click()
    await vi.waitFor(() => expect(el.querySelector('[data-role=wipe-failed]')).not.toBeNull())
    expect(h.onWiped).not.toHaveBeenCalled()
  })
})

describe('a wipe that never began says so, and does not look like one that worked', () => {
  /**
   * The outcome that used to be silence.
   *
   * `onWipe` is `async () => { const db = await openDb(); return wipeAll(db) }`, so
   * a database that will not open **rejects** rather than returning a partial
   * outcome — and the renderer called it as `void run()`, with the confirmation
   * already removed at the top of `run`. The user clicked "yes, delete it", the
   * dialog vanished, nothing was deleted, and a dialog vanishing is exactly what
   * success looks like on this screen.
   *
   * None of the eight tests here supplied a rejecting promise. Every one of them
   * resolved, and the branch that mattered was the one nobody expressed.
   */
  const refusing = () =>
    handlers({
      onWipe: vi.fn(async () => {
        throw new Error('the database would not open')
      }),
    })

  const wipeAndConfirm = (el: HTMLElement) => {
    el.querySelector<HTMLButtonElement>('[data-role=wipe]')?.click()
    el.querySelector<HTMLButtonElement>('[data-role=confirm-yes]')?.click()
  }

  it('puts the refusal on the screen instead of swallowing it', async () => {
    const h = refusing()
    const { el } = mount(h)
    wipeAndConfirm(el)

    await vi.waitFor(() => {
      const failure = el.querySelector('[data-role=wipe-failed]')?.textContent ?? ''
      expect(failure).toContain(message('dataWipeUnavailable').split('$')[0]?.trim())
      expect(failure, 'the reason is the only thing that tells two failures apart').toContain(
        'would not open',
      )
    })
  })

  it('says nothing was erased, rather than naming stores it never touched', async () => {
    // A partial wipe leaves some of the user's data gone and names which; a wipe
    // that never began leaves all of it. Reporting the second as the first would
    // invent a state, and this is the sentence a person acts on.
    const h = refusing()
    const { el } = mount(h)
    wipeAndConfirm(el)

    await vi.waitFor(() => expect(el.querySelector('[data-role=wipe-failed]')).not.toBeNull())
    const failure = el.querySelector('[data-role=wipe-failed]')?.textContent ?? ''
    expect(failure).not.toContain(message('dataWipePartial').split('$')[0]?.trim())
  })

  it('does not tell the caller to repaint a first-run screen', async () => {
    // `onWiped` returns the extension to its first-run state. Calling it here
    // would show an empty product over a database that is still full.
    const h = refusing()
    const { el } = mount(h)
    wipeAndConfirm(el)
    await vi.waitFor(() => expect(el.querySelector('[data-role=wipe-failed]')).not.toBeNull())
    expect(h.onWiped).not.toHaveBeenCalled()
  })

  it('offers the retry, and the retry really tries again', async () => {
    let attempts = 0
    const h = handlers({
      onWipe: vi.fn(async () => {
        attempts += 1
        if (attempts === 1) throw new Error('the database would not open')
        return { ok: true, failed: [] as string[] }
      }),
    })
    const { el } = mount(h)
    wipeAndConfirm(el)
    await vi.waitFor(() => expect(el.querySelector('[data-role=wipe-retry]')).not.toBeNull())

    el.querySelector<HTMLButtonElement>('[data-role=wipe-retry]')?.click()
    await vi.waitFor(() => expect(h.onWiped).toHaveBeenCalledOnce())
    // And the failure it was retrying is off the screen, not left beside a
    // success.
    expect(el.querySelector('[data-role=wipe-failed]')).toBeNull()
  })

  it('does not reject out of the click handler', async () => {
    // The click path is `() => void run()`, so anything `run` throws is lost. It
    // must handle its own failure rather than rely on a caller that cannot.
    const h = refusing()
    const { el } = mount(h)
    const errors: unknown[] = []
    const onError = (event: ErrorEvent) => errors.push(event.error)
    window.addEventListener('error', onError)
    wipeAndConfirm(el)
    await vi.waitFor(() => expect(el.querySelector('[data-role=wipe-failed]')).not.toBeNull())
    window.removeEventListener('error', onError)
    expect(errors).toEqual([])
  })
})

describe('an export that could not be made', () => {
  it('says so on the screen', async () => {
    // It was `() => void handlers.onExport()`: a click that did nothing and said
    // nothing. Export needs no confirmation because nothing is lost — which is a
    // reason to skip the question, not a reason to skip the answer.
    const h = handlers({
      onExport: vi.fn(async () => {
        throw new Error('the database would not open')
      }),
    })
    const { el } = mount(h)
    el.querySelector<HTMLButtonElement>('[data-role=export]')?.click()

    await vi.waitFor(() => {
      const failure = el.querySelector('[data-role=export-failed]')?.textContent ?? ''
      expect(failure).toContain(message('dataExportFailed').split('$')[0]?.trim())
      expect(failure).toContain('would not open')
    })
  })

  it('says it once, however many times it is asked', async () => {
    const h = handlers({
      onExport: vi.fn(async () => {
        throw new Error('nope')
      }),
    })
    const { el } = mount(h)
    for (let i = 0; i < 3; i += 1) el.querySelector<HTMLButtonElement>('[data-role=export]')?.click()
    await vi.waitFor(() => expect(el.querySelectorAll('[data-role=export-failed]').length).toBe(1))
  })

  it('takes the old failure down when a later export works', async () => {
    let calls = 0
    const h = handlers({
      onExport: vi.fn(async () => {
        calls += 1
        if (calls === 1) throw new Error('nope')
      }),
    })
    const { el } = mount(h)
    el.querySelector<HTMLButtonElement>('[data-role=export]')?.click()
    await vi.waitFor(() => expect(el.querySelector('[data-role=export-failed]')).not.toBeNull())

    el.querySelector<HTMLButtonElement>('[data-role=export]')?.click()
    await vi.waitFor(() => expect(el.querySelector('[data-role=export-failed]')).toBeNull())
  })
})

describe('one answer on the screen, whatever the clicking', () => {
  /**
   * Found by a test rather than by review: the first version of the failure path
   * removed the old note and then appended a new one after the await, so three
   * clicks on a failing export produced three identical lines. All three removed
   * nothing, all three waited, all three appended.
   */
  it('holds one wipe failure through repeated retries', async () => {
    const h = handlers({
      onWipe: vi.fn(async () => {
        throw new Error('still shut')
      }),
    })
    const { el } = mount(h)
    el.querySelector<HTMLButtonElement>('[data-role=wipe]')?.click()
    el.querySelector<HTMLButtonElement>('[data-role=confirm-yes]')?.click()
    await vi.waitFor(() => expect(el.querySelector('[data-role=wipe-retry]')).not.toBeNull())

    for (let i = 0; i < 3; i += 1) {
      el.querySelector<HTMLButtonElement>('[data-role=wipe-retry]')?.click()
    }
    await vi.waitFor(() => expect(h.onWipe).toHaveBeenCalledTimes(4))
    expect(el.querySelectorAll('[data-role=wipe-failed]').length).toBe(1)
    expect(el.querySelectorAll('[data-role=wipe-retry]').length).toBe(1)
  })

  it('takes the failure and the retry away once a wipe succeeds', async () => {
    // A retry button left beside a first-run screen invites a second wipe of
    // nothing, and a failure line left there says the opposite of what happened.
    let attempts = 0
    const h = handlers({
      onWipe: vi.fn(async () => {
        attempts += 1
        if (attempts === 1) return { ok: false, failed: ['journal'] }
        return { ok: true, failed: [] as string[] }
      }),
    })
    const { el } = mount(h)
    el.querySelector<HTMLButtonElement>('[data-role=wipe]')?.click()
    el.querySelector<HTMLButtonElement>('[data-role=confirm-yes]')?.click()
    await vi.waitFor(() => expect(el.querySelector('[data-role=wipe-retry]')).not.toBeNull())

    el.querySelector<HTMLButtonElement>('[data-role=wipe-retry]')?.click()
    await vi.waitFor(() => expect(h.onWiped).toHaveBeenCalledOnce())
    expect(el.querySelector('[data-role=wipe-failed]')).toBeNull()
    expect(el.querySelector('[data-role=wipe-retry]')).toBeNull()
  })

  it('replaces a "could not start" with a partial failure when that is what happened next', async () => {
    // The two are different facts and the screen must not show yesterday's.
    let attempts = 0
    const h = handlers({
      onWipe: vi.fn(async () => {
        attempts += 1
        if (attempts === 1) throw new Error('shut')
        return { ok: false, failed: ['models'] }
      }),
    })
    const { el } = mount(h)
    el.querySelector<HTMLButtonElement>('[data-role=wipe]')?.click()
    el.querySelector<HTMLButtonElement>('[data-role=confirm-yes]')?.click()
    await vi.waitFor(() => expect(el.querySelector('[data-role=wipe-retry]')).not.toBeNull())

    el.querySelector<HTMLButtonElement>('[data-role=wipe-retry]')?.click()
    await vi.waitFor(() =>
      expect(el.querySelector('[data-role=wipe-failed]')?.textContent ?? '').toContain('models'),
    )
    expect(el.querySelectorAll('[data-role=wipe-failed]').length).toBe(1)
  })
})

/**
 * B-125: the Have I Been Pwned key, which the background read and nothing wrote.
 *
 * The renderer is told whether a key exists, never what it is, so there is no value it
 * could put back on screen. The fake key below is obviously fake on purpose.
 */
describe('the Have I Been Pwned key', () => {
  const FAKE_KEY = 'fake-hibp-key-for-tests-0000'

  function keyPanel(saved: boolean, overrides: Partial<LeakKeyPanel> = {}): LeakKeyPanel {
    return { saved, onSave: vi.fn(), onRemove: vi.fn(), ...overrides }
  }

  function mountKey(panel: LeakKeyPanel): HTMLElement {
    const el = renderDataControls(document, handlers(), KINDS, panel)
    document.body.replaceChildren(el)
    return el
  }

  const role = (root: HTMLElement, name: string) => root.querySelector<HTMLElement>(`[data-role=${name}]`)
  const field = (root: HTMLElement) => role(root, 'leak-key-field') as HTMLInputElement

  it('draws no key block when the page passes none', () => {
    const { el } = mount()
    expect(role(el, 'leak-key')).toBeNull()
  })

  it('says no key is saved, and offers only to save one', () => {
    const el = mountKey(keyPanel(false))
    expect(role(el, 'leak-key-state')?.textContent).toBe(message('leakKeyNone'))
    expect(role(el, 'leak-key-save')?.textContent).toBe(message('leakKeySave'))
    expect(role(el, 'leak-key-remove')).toBeNull()
    expect(role(el, 'leak-key-blurb')?.textContent).toBe(message('leakKeyBlurb'))
  })

  it('says a key is saved without showing it, and offers to replace or remove it', () => {
    const el = mountKey(keyPanel(true))
    expect(role(el, 'leak-key-state')?.textContent).toBe(message('leakKeySaved'))
    expect(role(el, 'leak-key-save')?.textContent).toBe(message('leakKeyReplace'))
    expect(role(el, 'leak-key-remove')?.textContent).toBe(message('leakKeyRemove'))
    expect(field(el).value).toBe('')
  })

  it('keeps the field masked and out of the browser\'s memory of typed values', () => {
    const input = field(mountKey(keyPanel(false)))
    expect(input.type).toBe('password')
    expect(input.getAttribute('autocomplete')).toBe('off')
    expect(input.getAttribute('spellcheck')).toBe('false')
    expect(input.getAttribute('aria-label')).toBe(message('leakKeyField'))
  })

  it('saves the pasted key, trimmed, and empties the field at once', () => {
    const panel = keyPanel(false)
    const el = mountKey(panel)
    field(el).value = `  ${FAKE_KEY}\n`
    role(el, 'leak-key-save')?.click()

    expect(panel.onSave).toHaveBeenCalledWith(FAKE_KEY)
    // Emptied by the renderer itself, so the key is off the screen even if the page
    // never repaints after the save.
    expect(field(el).value).toBe('')
    expect(el.textContent).not.toContain(FAKE_KEY)
  })

  it('saves on Enter as well as on the button', () => {
    const panel = keyPanel(false)
    const el = mountKey(panel)
    field(el).value = FAKE_KEY
    field(el).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(panel.onSave).toHaveBeenCalledWith(FAKE_KEY)
  })

  it('refuses an empty field out loud and saves nothing', () => {
    const panel = keyPanel(false)
    const el = mountKey(panel)
    field(el).value = '   '
    role(el, 'leak-key-save')?.click()

    expect(panel.onSave).not.toHaveBeenCalled()
    expect(role(el, 'leak-key-needs')?.textContent).toBe(message('leakKeyEmpty'))
  })

  it('refuses a key with a space inside, and leaves it in the field to correct', () => {
    const panel = keyPanel(false)
    const el = mountKey(panel)
    field(el).value = 'abc def'
    role(el, 'leak-key-save')?.click()
    role(el, 'leak-key-save')?.click()

    expect(panel.onSave).not.toHaveBeenCalled()
    expect(role(el, 'leak-key-needs')?.textContent).toBe(message('leakKeyShape'))
    // One refusal, however many presses: the slot is replaced, not appended.
    expect(el.querySelectorAll('[data-role=leak-key-needs]')).toHaveLength(1)
    expect(field(el).value).toBe('abc def')
  })

  it('names a letter outside the Latin layout as what it is, not as a space', () => {
    // A key retyped in the Russian layout carries a Cyrillic letter; telling that person
    // to look for a space sends them hunting for something that is not there.
    const panel = keyPanel(false)
    const el = mountKey(panel)
    field(el).value = 'abcdеf0123' // the "е" is Cyrillic
    role(el, 'leak-key-save')?.click()

    expect(panel.onSave).not.toHaveBeenCalled()
    expect(role(el, 'leak-key-needs')?.textContent).toBe(message('leakKeyLatin'))
    field(el).value = 'abc\tdef'
    role(el, 'leak-key-save')?.click()
    expect(role(el, 'leak-key-needs')?.textContent).toBe(message('leakKeyShape'))
  })

  it('clears an earlier refusal once a key is accepted', () => {
    const el = mountKey(keyPanel(false))
    role(el, 'leak-key-save')?.click()
    field(el).value = FAKE_KEY
    role(el, 'leak-key-save')?.click()
    expect(role(el, 'leak-key-needs')).toBeNull()
  })

  it('removes the key on one press', () => {
    const panel = keyPanel(true)
    const el = mountKey(panel)
    role(el, 'leak-key-remove')?.click()
    expect(panel.onRemove).toHaveBeenCalledOnce()
  })

  it('keeps the wipe confirmation next to the wipe button, above the key block', () => {
    const el = mountKey(keyPanel(false))
    role(el, 'wipe')?.click()
    const confirm = role(el, 'confirm') as HTMLElement
    expect(confirm.compareDocumentPosition(role(el, 'leak-key') as Node)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    )
  })
})
