import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { DEFAULT_LOCALE, localeFromEnv, run, type RunIo } from './command.js'
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
  const seen = { written: [] as string[], codes: [] as number[] }
  const io: RunIo = {
    write: (text) => seen.written.push(text),
    exit: (code) => seen.codes.push(code),
  }
  return { io, seen }
}

describe('how the command ends', () => {
  it('writes the verdict and ends with its code', async () => {
    const { io, seen } = recorder()
    await run(['scan', 'x'], {}, io, () => ({ text: 'verdict', code: EXIT.signalsFound }))
    expect(seen.written).toEqual(['verdict\n'])
    expect(seen.codes).toEqual([EXIT.signalsFound])
  })

  /**
   * A crash is the launcher's to report: it prefixes the line with
   * `okolos-mail:` and ends with 2. `run` neither swallows it nor half-reports
   * it, so the crash reaches the one place that formats every failure.
   */
  it('lets a crash reach the launcher, with nothing written and no exit code set', async () => {
    const { io, seen } = recorder()
    const planted = new Error('planted')
    await expect(
      run(['scan', 'x'], {}, io, () => {
        throw planted
      }),
    ).rejects.toBe(planted)
    expect(seen.written).toEqual([])
    expect(seen.codes).toEqual([])
  })
})
