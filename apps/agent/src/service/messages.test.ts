import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { SERVICE_KEYS, serviceMessages } from './messages.js'

const LOCALES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '_locales')

const catalogue = (locale: string) =>
  JSON.parse(readFileSync(path.join(LOCALES, locale, 'messages.json'), 'utf8')) as Record<
    string,
    { message: string }
  >

describe('the sentences the service shell says to a person', () => {
  it('every key is in both catalogues', () => {
    for (const locale of ['ru', 'en']) {
      for (const key of SERVICE_KEYS) expect(catalogue(locale)[key]?.message, `${locale} ${key}`).toBeTruthy()
    }
  })

  it('in the Okolos voice: no exclamation, no em dash, a full stop at the end', () => {
    for (const locale of ['ru', 'en']) {
      for (const key of SERVICE_KEYS) {
        const message = catalogue(locale)[key]?.message ?? ''
        expect(message, `${locale} ${key}`).not.toMatch(/[!—]/)
        expect(message.trim().endsWith('.'), `${locale} ${key}`).toBe(true)
      }
    }
  })

  it('says only what the drain can keep: stopping takes no new work, and a cut-off is told with its count', () => {
    expect(catalogue('ru').eventStopping?.message).toBe('Okolos Agent останавливается и новую работу не берёт.')
    expect(catalogue('en').eventStopping?.message).toBe('Okolos Agent is stopping and takes on no new work.')
    const ru = serviceMessages('ru', LOCALES)
    const en = serviceMessages('en', LOCALES)
    expect(ru.drainCutOff(2)).toBe('Okolos Agent остановился, не дождавшись конца запросов (2): они оборваны.')
    expect(en.drainCutOff(2)).toBe('Okolos Agent stopped before 2 requests finished: they were cut off.')
  })

  it('refuses a catalogue that lacks a key the service says, naming the key', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'okolos-agent-locales-'))
    try {
      const partial = { ...catalogue('en') }
      delete partial.eventStarted
      mkdirSync(path.join(dir, 'en'))
      writeFileSync(path.join(dir, 'en', 'messages.json'), JSON.stringify(partial))
      expect(() => serviceMessages('en', dir)).toThrow(/eventStarted/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('resolves each in the locale asked for, with its number put in', () => {
    const ru = serviceMessages('ru', LOCALES)
    const en = serviceMessages('en', LOCALES)
    expect(ru.started()).toBe(catalogue('ru').eventStarted?.message)
    expect(en.started()).toBe(catalogue('en').eventStarted?.message)
    expect(en.stopping()).toBe(catalogue('en').eventStopping?.message)
    expect(en.refusingWhileStopping()).toBe(catalogue('en').serviceStopping?.message)
    expect(en.unreadableEvents(3)).toContain('3')
    expect(en.unreadableEvents(3)).not.toContain('$')
    expect(ru.unreadableEvents(3)).toContain('3')
  })
})
