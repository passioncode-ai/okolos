import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { DEFAULT_LOCALE, localeFromEnv, run, type RunIo } from './index.js'
import { EXIT } from './scan.js'

describe('the language the command speaks', () => {
  /**
   * Two surfaces of one product must not disagree about its language. The
   * manifest is the one that ships; this holds the command to it.
   */
  it('defaults to the same locale the extension manifest declares', () => {
    const manifest = JSON.parse(
      readFileSync(path.join(process.cwd(), 'apps/extension/manifest.chrome.json'), 'utf8'),
    ) as { default_locale: string }
    expect(DEFAULT_LOCALE).toBe(manifest.default_locale)
  })

  it('ignores the shell, because the shell says what the terminal is, not what this speaks', () => {
    expect(localeFromEnv({ LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' })).toBe('ru')
  })

  it('honours a deliberate override', () => {
    expect(localeFromEnv({ OKOLOS_LOCALE: 'en' })).toBe('en')
    expect(localeFromEnv({ OKOLOS_LOCALE: 'ru' })).toBe('ru')
  })
})

/** A `RunIo` that records instead of touching the process. */
function recorder() {
  const seen = { written: [] as string[], failed: [] as unknown[], codes: [] as number[] }
  const io: RunIo = {
    write: (text) => seen.written.push(text),
    fail: (error) => seen.failed.push(error),
    exit: (code) => seen.codes.push(code),
  }
  return { io, seen }
}

describe('how the command ends', () => {
  it('writes the verdict and ends with its code', () => {
    const { io, seen } = recorder()
    run(['scan', 'x'], {}, io, () => ({ text: 'verdict', code: EXIT.signalsFound }))
    expect(seen.written).toEqual(['verdict\n'])
    expect(seen.failed).toEqual([])
    expect(seen.codes).toEqual([EXIT.signalsFound])
  })

  /**
   * Left to node, a throw exits 1, and 1 is `EXIT.signalsFound`: a crash would
   * read as a finding. It is neither a finding nor a clean message, so it ends
   * the way an unread message does.
   */
  it('ends a crash with the unread code, never 0 and never 1', () => {
    const { io, seen } = recorder()
    const planted = new Error('planted')
    run(['scan', 'x'], {}, io, () => {
      throw planted
    })
    expect(seen.written).toEqual([])
    expect(seen.failed).toEqual([planted])
    expect(seen.codes).toEqual([EXIT.unreadable])
  })
})
