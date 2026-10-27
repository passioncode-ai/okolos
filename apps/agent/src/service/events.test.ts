import { mkdtempSync, rmSync, statSync } from 'node:fs'
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
