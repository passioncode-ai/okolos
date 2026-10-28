import { describe, expect, it, vi } from 'vitest'
import type { FeedSnapshot } from '@okolos/core-feeds'

import { discardDownload, handleDownload, type DownloadDeps, type DownloadItem } from './downloads.js'

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fromCatalogue, useResolver, type Catalogue } from '@okolos/i18n'

/** The shipped Russian catalogue: `default_locale` is `ru`, and a fake would let a missing key pass. */
const CATALOGUE = JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, '../../_locales/ru/messages.json'), 'utf8'),
) as Catalogue

useResolver(fromCatalogue(CATALOGUE))

/** The entry, or a failure that names the key rather than comparing to undefined. */
function message(key: string): string {
  const entry = CATALOGUE[key]
  if (!entry) throw new Error(`the shipped catalogue has no key "${key}"`)
  return entry.message
}

const FEED: FeedSnapshot = {
  name: 'URLhaus',
  version: 4,
  updatedAt: '2026-08-04T00:00:00.000Z',
  entries: ['malware.test'],
}

function item(overrides: Partial<DownloadItem> = {}): DownloadItem {
  return { id: 1, url: 'https://files.test/report.pdf', filename: 'report.pdf', mime: 'application/pdf', ...overrides }
}

function deps(overrides: Partial<DownloadDeps> = {}): DownloadDeps & {
  cancel: ReturnType<typeof vi.fn>
  journal: ReturnType<typeof vi.fn>
} {
  return {
    feed: async () => FEED,
    cancel: vi.fn(async () => undefined),
    journal: vi.fn(async () => undefined),
    announce: vi.fn(async () => undefined),
    ...overrides,
  } as DownloadDeps & { cancel: ReturnType<typeof vi.fn>; journal: ReturnType<typeof vi.fn> }
}

describe('a file from a listed address', () => {
  it('is cancelled before it reaches the disk', async () => {
    const d = deps()
    const verdict = await handleDownload(item({ url: 'https://malware.test/x.exe' }), d)

    expect(verdict.action).toBe('block')
    expect(d.cancel).toHaveBeenCalledWith(1)
  })

  it('names the list and the date of its entry', async () => {
    const verdict = await handleDownload(item({ url: 'https://malware.test/x.exe' }), deps())
    expect(verdict.reasons.join(' ')).toContain('URLhaus')
    expect(verdict.reasons.join(' ')).toContain('2026-08-04')
  })

  it('is written to the journal', async () => {
    const d = deps()
    await handleDownload(item({ url: 'https://malware.test/x.exe' }), d)
    expect(d.journal).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'block' }))
  })
})

describe('the check that can never run here', () => {
  it('reports the hash as not run, with the reason', async () => {
    // There is no file yet. Treating the missing hash as a pass would be a
    // green tick nobody earned.
    const verdict = await handleDownload(item(), deps())
    expect(verdict.skipped).toContainEqual({
      check: 'hash',
      why: message('downloadNotWritten'),
    })
  })

  it('never claims every check passed', async () => {
    const verdict = await handleDownload(item(), deps())
    expect(verdict.headline).toBe('passed-what-ran')
  })
})

describe('when the lists are unavailable', () => {
  it('says the source was not checked rather than passing it', async () => {
    const verdict = await handleDownload(item(), deps({ feed: async () => null }))
    expect(verdict.skipped.map((entry) => entry.check)).toContain('feed')
  })

  it('still lets an ordinary file through', async () => {
    const d = deps({ feed: async () => null })
    const verdict = await handleDownload(item(), d)
    expect(verdict.action).not.toBe('block')
    expect(d.cancel).not.toHaveBeenCalled()
  })

  it('survives a storage failure without stopping the download', async () => {
    const d = deps({
      feed: async () => {
        throw new Error('database gone')
      },
    })
    await expect(handleDownload(item(), d)).resolves.toBeTruthy()
    expect(d.cancel).not.toHaveBeenCalled()
  })
})

describe('what the file name gives away', () => {
  it('warns about a program dressed as a document', async () => {
    const verdict = await handleDownload(item({ filename: 'invoice.pdf.exe' }), deps())
    expect(verdict.action).toBe('warn')
  })

  it('does not cancel on a warning — that is the user’s call', async () => {
    const d = deps()
    await handleDownload(item({ filename: 'invoice.pdf.exe' }), d)
    expect(d.cancel).not.toHaveBeenCalled()
  })
})

describe('a redirect, which is how a malicious file is usually served', () => {
  /**
   * The matrix promised the reputation check ran on `finalUrl`; the code read `url`.
   * A link a page carries is a shortener nobody lists, and the host it lands on is the
   * one in the feed — so checking one address was checking whichever address happened
   * to be there (B-57).
   */
  it('cancels when the landing address is listed and the link is not', async () => {
    const d = deps()
    const verdict = await handleDownload(
      item({ url: 'https://short.test/x', finalUrl: 'https://malware.test/payload.exe' }),
      d,
    )
    expect(verdict.action).toBe('block')
    expect(d.cancel).toHaveBeenCalledWith(1)
  })

  it('cancels when the link is listed and the landing address is not', async () => {
    // The other direction, because a redirect away from a listed host does not clear it.
    const d = deps()
    const verdict = await handleDownload(
      item({ url: 'https://malware.test/payload.exe', finalUrl: 'https://cdn.test/file' }),
      d,
    )
    expect(verdict.action).toBe('block')
  })

  it('leaves an ordinary redirect alone', async () => {
    /**
     * The side that keeps this usable: a redirect through a CDN is what most large
     * downloads look like, and a check that treated a second address as suspicious in
     * itself would fire on most of the web.
     */
    const d = deps()
    const verdict = await handleDownload(
      item({ url: 'https://files.test/report.pdf', finalUrl: 'https://cdn.files.test/report.pdf' }),
      d,
    )
    expect(verdict.action).not.toBe('block')
    expect(d.cancel).not.toHaveBeenCalled()
  })

  it('still checks the one address when there is no second one', async () => {
    // Firefox has no `finalUrl`, so the absent field must not turn the check off.
    const d = deps()
    const verdict = await handleDownload(item({ url: 'https://malware.test/payload.exe' }), d)
    expect(verdict.action).toBe('block')
  })
})


describe('discardDownload (B-165, round 7)', () => {
  it('deletes the download the top frame names, without judging it again', async () => {
    const asked: number[] = []
    const result = await discardDownload({ downloadId: 7 }, { frameId: 0 }, async (id) => {
      asked.push(id)
      return true
    })
    expect(result).toEqual({ ok: true })
    expect(asked).toEqual([7])
  })

  it('refuses a frame inside the page and a malformed id, touching nothing', async () => {
    const asked: number[] = []
    const discard = async (id: number) => {
      asked.push(id)
      return true
    }
    expect(await discardDownload({ downloadId: 7 }, { frameId: 3 }, discard)).toEqual({ ok: false })
    expect(await discardDownload({ downloadId: 7 }, {}, discard)).toEqual({ ok: false })
    expect(await discardDownload({ downloadId: '7' }, { frameId: 0 }, discard)).toEqual({ ok: false })
    expect(await discardDownload({ downloadId: 1.5 }, { frameId: 0 }, discard)).toEqual({ ok: false })
    expect(await discardDownload(null, { frameId: 0 }, discard)).toEqual({ ok: false })
    expect(asked).toEqual([])
  })

  it('reports a failed deletion as not done', async () => {
    expect(await discardDownload({ downloadId: 7 }, { frameId: 0 }, async () => false)).toEqual({ ok: false })
    expect(
      await discardDownload({ downloadId: 7 }, { frameId: 0 }, async () => {
        throw new Error('gone')
      }),
    ).toEqual({ ok: false })
  })
})
