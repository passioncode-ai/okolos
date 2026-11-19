import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { fromCatalogue, type Catalogue } from '@okolos/i18n'
import { afterEach, describe, expect, it } from 'vitest'

import { diagnose, doctorText, systemDoctorProbe } from './doctor.js'
import { pairingStoreFile } from './pairing/pairing.js'
import { serviceDirs } from './service/dirs.js'

const homes: string[] = []
afterEach(() => {
  for (const home of homes.splice(0)) {
    chmodSync(home, 0o700)
    rmSync(home, { recursive: true, force: true })
  }
})

function home() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'okolos-doctor-'))
  homes.push(dir)
  const dirs = serviceDirs(dir)
  mkdirSync(path.join(dirs.data, 'journal'), { recursive: true })
  return dirs
}

const withChrome = { ...systemDoctorProbe, chrome: () => '/chrome' }
const say = (locale: 'ru' | 'en') =>
  fromCatalogue(JSON.parse(readFileSync(path.join(import.meta.dirname, '..', '_locales', locale, 'messages.json'), 'utf8')) as Catalogue)

describe('okolos-agent doctor (N-016)', () => {
  it('finds nothing on a fresh home, and says so in both languages', () => {
    const dirs = home()
    expect(diagnose(dirs, withChrome)).toEqual([])
    for (const locale of ['ru', 'en'] as const) expect(doctorText([], say(locale))).toEqual([say(locale)('doctorOk')])
  })

  it('names a missing Chrome', () => {
    const problems = diagnose(home(), { ...withChrome, chrome: () => null })
    expect(problems).toEqual([{ check: 'chrome', reason: 'missing' }])
    expect(doctorText(problems, say('en'))[0]).toContain('Install Google Chrome')
  })

  it('names the access list with its path when it cannot be read, written or parsed', () => {
    const dirs = home()
    const store = pairingStoreFile(dirs)
    writeFileSync(store, '{ not json')
    expect(diagnose(dirs, withChrome)).toEqual([{ check: 'pairing', reason: 'unparsable', path: store }])
    writeFileSync(store, '{}')
    const deny = (mode: number) => ({ ...withChrome, can: (file: string, m: number) => !(file === store && m === mode) })
    expect(diagnose(dirs, deny(4))).toEqual([{ check: 'pairing', reason: 'no_read', path: store }])
    expect(diagnose(dirs, deny(2))).toEqual([{ check: 'pairing', reason: 'no_write', path: store }])
    const line = doctorText([{ check: 'pairing', reason: 'no_write', path: store }], say('en'))[0]
    expect(line).toBe(`the access list: ${store}, no permission to write.`)
  })

  it('names the agents journal and its newest day when they cannot be written, without opening a journal', () => {
    const dirs = home()
    const journal = path.join(dirs.data, 'journal')
    const day = path.join(journal, '2026-11-19.jsonl')
    writeFileSync(day, '')
    const problems = diagnose(dirs, { ...withChrome, can: (file, mode) => !(file === day && mode === 2) })
    expect(problems).toEqual([{ check: 'journal', reason: 'no_write', path: day }])
    expect(doctorText(problems, say('ru'))[0]).toBe(`журнал агентов: ${day}, нет прав на запись.`)
  })
})
