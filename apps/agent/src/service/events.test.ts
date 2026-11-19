import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { EventLog } from './events.js'

const temps: string[] = []
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function file(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'okolos-agent-events-'))
  temps.push(dir)
  return path.join(dir, 'events.jsonl')
}

describe('the events feed', () => {
  it('gives each event the next id and pages after a cursor, ascending', () => {
    const log = new EventLog(file())
    expect(log.read(null, 50)).toEqual([])
    for (const n of [1, 2, 3, 4]) log.append('service.started', 'info', `Start number ${n}.`)

    expect(log.read(null, 50).map((e) => e.id)).toEqual(['1', '2', '3', '4'])
    expect(log.read(null, 2).map((e) => e.id)).toEqual(['3', '4'])
    expect(log.read('2', 50).map((e) => e.id)).toEqual(['3', '4'])
    expect(log.read('2', 1).map((e) => e.id)).toEqual(['3'])
    expect(log.read('4', 50)).toEqual([])
  })

  it('keeps counting across a restart, so a cursor a host holds stays valid', () => {
    const where = file()
    new EventLog(where).append('service.started', 'info', 'Okolos Agent started.')
    const again = new EventLog(where).append('service.started', 'info', 'Okolos Agent started.')
    expect(again.id).toBe('2')
  })

  it('writes events a host can read: kind, level, sentence, time; the file is 0600', () => {
    const where = file()
    const event = new EventLog(where).append('service.stopping', 'info', 'Okolos Agent is stopping.')
    expect(event).toMatchObject({ kind: 'service.stopping', level: 'info', text: 'Okolos Agent is stopping.' })
    expect(Date.parse(event.at)).not.toBeNaN()
    expect(statSync(where).mode & 0o777).toBe(0o600)
  })

  it('refuses a kind that is not dotted lowercase (the kit’s rule)', () => {
    expect(() => new EventLog(file()).append('Service Started', 'info', 'x')).toThrow(/dotted lowercase/)
  })
})

describe('a torn or unreadable line does not stop the service', () => {
  const line = (id: number) =>
    JSON.stringify({ id: String(id), at: '2026-10-27T05:00:00Z', kind: 'service.started', level: 'info', text: `Start ${id}.` })

  it('skips a truncated last line, counts it, and the next event lands on a line of its own', () => {
    const where = file()
    writeFileSync(where, `${line(1)}\n${line(2)}\n${line(3).slice(0, 25)}`, { mode: 0o600 })
    const log = new EventLog(where)
    expect(log.unreadable).toBe(1)
    expect(log.read(null, 50).map((e) => e.id)).toEqual(['1', '2'])

    const next = log.append('service.started', 'info', 'Okolos Agent started.')
    expect(next.id).toBe('3')
    expect(new EventLog(where).read(null, 50).map((e) => e.id)).toEqual(['1', '2', '3'])
  })

  it('skips a line that is not an event in the middle, and counts it', () => {
    const where = file()
    writeFileSync(where, `${line(1)}\nnot json\n{"id":"x"}\n${line(2)}\n`, { mode: 0o600 })
    const log = new EventLog(where)
    expect(log.unreadable).toBe(2)
    expect(log.read(null, 50).map((e) => e.id)).toEqual(['1', '2'])
  })

  it('rewrites the file without the unreadable lines at start, so the next start finds it clean', () => {
    const where = file()
    writeFileSync(where, `${line(1)}\nnot json\n${line(2)}\n${line(3).slice(0, 25)}`, { mode: 0o600 })
    expect(new EventLog(where).unreadable).toBe(2)
    expect(readFileSync(where, 'utf8')).toBe(`${line(1)}\n${line(2)}\n`)
    expect(statSync(where).mode & 0o777).toBe(0o600)
    const again = new EventLog(where)
    expect(again.unreadable).toBe(0)
    expect(again.read(null, 50).map((e) => e.id)).toEqual(['1', '2'])
  })

  it('counts nothing on a clean file', () => {
    const where = file()
    writeFileSync(where, `${line(1)}\n`, { mode: 0o600 })
    expect(new EventLog(where).unreadable).toBe(0)
  })
})

describe('retention at start: at least 7 days or 1000 events (fabric-service/0.1)', () => {
  const DAY = 24 * 60 * 60 * 1000
  const NOW = Date.parse('2026-10-27T12:00:00Z')

  /** A log file of `count` events, the first `old` of them 8 days old, the rest from today. */
  function seeded(count: number, old: number): string {
    const where = file()
    const lines: string[] = []
    for (let id = 1; id <= count; id += 1) {
      const at = new Date(id <= old ? NOW - 8 * DAY : NOW - 60_000).toISOString()
      lines.push(JSON.stringify({ id: String(id), at, kind: 'service.started', level: 'info', text: `Start ${id}.` }))
    }
    writeFileSync(where, `${lines.join('\n')}\n`, { mode: 0o600 })
    return where
  }

  const ids = (log: EventLog) => log.read('0', 10_000).map((e) => Number(e.id))

  it('drops events older than 7 days beyond the newest 1000', () => {
    const log = new EventLog(seeded(1200, 1200), { now: () => NOW })
    const kept = ids(log)
    expect(kept).toHaveLength(1000)
    expect(kept[0]).toBe(201)
    expect(kept.at(-1)).toBe(1200)
  })

  it('keeps every event of the last 7 days, however many', () => {
    const log = new EventLog(seeded(1500, 300), { now: () => NOW })
    const kept = ids(log)
    expect(kept).toHaveLength(1200)
    expect(kept[0]).toBe(301)
  })

  it('keeps the newest 1000 even when most are old', () => {
    const log = new EventLog(seeded(1100, 1050), { now: () => NOW })
    const kept = ids(log)
    expect(kept).toHaveLength(1000)
    expect(kept[0]).toBe(101)
  })

  it('keeps a small log whole, however old', () => {
    expect(ids(new EventLog(seeded(10, 10), { now: () => NOW }))).toHaveLength(10)
  })

  it('keeps ids, so a host’s cursor stays valid, and the file stays 0600', () => {
    const where = seeded(1200, 1200)
    const log = new EventLog(where, { now: () => NOW })
    expect(log.append('service.started', 'info', 'Okolos Agent started.').id).toBe('1201')
    expect(log.read('1199', 50).map((e) => e.id)).toEqual(['1200', '1201'])
    expect(statSync(where).mode & 0o777).toBe(0o600)
    expect(readFileSync(where, 'utf8').trim().split('\n')).toHaveLength(1001)
  })
})
