/** @vitest-environment happy-dom */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { BannerHandlers } from '@okolos/ui'

import { showDownloadVerdict, type DownloadVerdictMessage } from './download.js'
import { createSurfaceSlot } from './surface-slot.js'

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fromCatalogue, useResolver, type Catalogue } from '@okolos/i18n'

/** The shipped Russian catalogue: `default_locale` is `ru`, and a fake would let a missing key pass. */
const CATALOGUE = JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, '../../_locales/ru/messages.json'), 'utf8'),
) as Catalogue

useResolver(fromCatalogue(CATALOGUE))

function message(overrides: Partial<DownloadVerdictMessage> = {}): DownloadVerdictMessage {
  return {
    action: 'block',
    // A code, because that is what crosses the RPC now; the words are resolved here
    // from the shipped catalogue (B-75).
    headline: 'blocked',
    shape: [],
    reasons: 'The address this came from is listed by URLhaus (entry from 2026-08-01).',
    skipped: 'hash: the file has not been written yet, so there are no bytes to hash',
    ...overrides,
  }
}

const deps = () => ({ doc: document, openJournal: vi.fn() })
const banner = () => document.querySelector('okolos-banner')

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('a download that was stopped', () => {
  it('is told to the person who started it', () => {
    // For a while this did not happen: the worker announced its verdict to a
    // message type nobody listened for, so the file was journalled and the user
    // saw nothing.
    const handle = showDownloadVerdict(message(), deps())
    expect(handle).not.toBeNull()
    expect(banner()).not.toBeNull()
  })

  it('says the file never reached the disk, rather than offering to stop it', () => {
    const handle = showDownloadVerdict(message(), deps())
    const detail = handle?.root.querySelector('[data-role=detail]')?.textContent ?? ''
    expect(detail).toContain('на диск ничего не попало')
  })

  it('names what matched', () => {
    const handle = showDownloadVerdict(message(), deps())
    expect(handle?.root.querySelector('[data-role=detail]')?.textContent).toContain('URLhaus')
  })

  it('names the checks that could not run', () => {
    const handle = showDownloadVerdict(message(), deps())
    expect(handle?.root.querySelector('[data-role=detail]')?.textContent).toContain('Не проверено')
  })
})

describe('a download that was only doubted', () => {
  it('keeps the judge’s own headline rather than claiming a block', () => {
    const handle = showDownloadVerdict(
      message({ action: 'warn', headline: 'needs-a-look' }),
      deps(),
    )
    expect(handle?.root.querySelector('[data-role=headline]')?.textContent).toBe(
      CATALOGUE.downloadHeadlineNeedsLook?.message,
    )
  })

  it('does not claim the file was cancelled, because it was not', () => {
    const handle = showDownloadVerdict(message({ action: 'warn' }), deps())
    expect(handle?.root.querySelector('[data-role=detail]')?.textContent).not.toContain(
      'nothing reached your disk',
    )
  })
})

describe('a download that passed', () => {
  it('says nothing at all', () => {
    // Announcing every clean download is how a banner becomes wallpaper.
    expect(showDownloadVerdict(message({ action: 'inform' }), deps())).toBeNull()
    expect(banner()).toBeNull()
  })
})

describe('the way to the full record', () => {
  it('offers the record instead of an action nobody can take', () => {
    const handle = showDownloadVerdict(message(), deps())
    expect(handle?.root.querySelector('[data-role=primary]')?.textContent).toBe('Показать запись')
  })

  it('opens the journal on request', () => {
    const d = deps()
    const handle = showDownloadVerdict(message(), d)
    handle?.root.querySelector<HTMLElement>('[data-role=primary]')?.click()
    expect(d.openJournal).toHaveBeenCalledTimes(1)
  })
})

describe('the words for a code', () => {
  /**
   * The verdict crosses the RPC as codes and is worded here (B-75). What must not
   * happen is a code reaching the screen: `[downloadHeadline…]` or the bare code itself
   * on a banner about a file somebody is about to open.
   */
  it('renders a catalogue sentence for every headline the judge can produce', () => {
    for (const code of ['blocked', 'unchecked', 'needs-a-look', 'passed-what-ran'] as const) {
      // `inform` is not shown at all, so `passed-all` never reaches a banner.
      const el = showDownloadVerdict(
        message({ action: code === 'blocked' ? 'block' : 'warn', headline: code }),
        deps(),
      )
      const headline = el?.root.querySelector('[data-role=headline]')?.textContent ?? ''
      expect(headline, `${code} has no sentence`).not.toBe('')
      expect(headline, `${code} rendered the resolver's fallback`).not.toMatch(/^\[/)
      expect(headline, `${code} rendered its own code`).not.toBe(code)
    }
  })

  it('renders a catalogue sentence for every shape fact, with its values in it', () => {
    const cases = [
      { code: 'double-extension', filename: 'invoice.pdf.exe' },
      { code: 'name-hides-a-program', mimeType: 'application/pdf' },
      { code: 'type-is-a-program', filename: 'invoice.pdf', mimeType: 'application/x-msdownload' },
      { code: 'is-a-program' },
      { code: 'is-an-archive' },
    ]
    for (const shape of cases) {
      const el = showDownloadVerdict(
        message({ action: 'warn', headline: 'needs-a-look', shape: [shape] }),
        deps(),
      )
      const detail = el?.root.querySelector('[data-role=detail]')?.textContent ?? ''
      expect(detail, `${shape.code} has no sentence`).not.toMatch(/^\[/)
      expect(detail, `${shape.code} rendered its own code`).not.toContain(shape.code)
      // Collected rather than asserted behind a branch: an `expect` inside an `if`
      // does not run when the branch is not taken, and the test passes anyway — the
      // rule `tools/test-quality.test.ts` enforces, and it caught this.
      const values = [shape.filename, shape.mimeType].filter(
        (value): value is string => value !== undefined,
      )
      const missing = values.filter((value) => !detail.includes(value))
      expect(missing, `${shape.code} dropped its values from the sentence`).toEqual([])
    }
  })
})

describe('a download panel closed by the person, through the real slot (B-165, round 2)', () => {
  /**
   * The download module closes its panel with the handle the slot gave it. Before the slot
   * released on a handle's close, the slot's watch read the closed panel as the page
   * removing a warning and drew it again a quarter-second later.
   */
  it('stays closed after Dismiss, and the slot is free again', async () => {
    const slot = createSurfaceSlot({
      doc: document,
      noteRefused: () => undefined,
      escalate: async () => undefined,
      alsoLine: (kinds) => `also here: ${kinds.join(', ')}`,
      wait: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    })
    let handlers: BannerHandlers | null = null
    showDownloadVerdict(message(), {
      ...deps(),
      mountWarning: (props, given) => {
        handlers = given
        return slot.claim({ kind: 'download', severity: props.severity, props, handlers: given })
      },
    })
    expect(banner()).not.toBeNull()

    ;(handlers as BannerHandlers | null)?.onDismiss()
    await new Promise<void>((resolve) => setTimeout(resolve, 1000))

    expect(banner()).toBeNull()
    expect(slot.current()).toBeNull()
    slot.release()
  })
})

describe('a doubted download, discarded from its panel (B-165, round 4)', () => {
  it('asks the browser to delete the file, and closes once it did', async () => {
    const discard = vi.fn(async () => true)
    const handle = showDownloadVerdict(message({ action: 'warn', headline: 'doubted', downloadId: 42 } as never), { ...deps(), discard })
    handle?.root.querySelector<HTMLElement>('[data-role=primary]')?.click()
    await Promise.resolve()
    await Promise.resolve()
    expect(discard).toHaveBeenCalledWith(42)
    expect(banner()).toBeNull()
  })

  it('stays up and says so when the file could not be deleted', async () => {
    const discard = vi.fn(async () => false)
    const handle = showDownloadVerdict(message({ action: 'warn', headline: 'doubted', downloadId: 42 } as never), { ...deps(), discard })
    handle?.root.querySelector<HTMLElement>('[data-role=primary]')?.click()
    await Promise.resolve()
    await Promise.resolve()
    expect(banner()).not.toBeNull()
  })
})
