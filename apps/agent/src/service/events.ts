/**
 * The service's events feed (`GET /fabric/v1/events`): a JSONL file in the data folder.
 *
 * The Node kit pages events (`eventsPage`) and shapes them (`makeEvent`) but, unlike the Python
 * kit, carries no JSONL log, so this is the small one the service keeps. Each event is one sentence
 * a person reads; ids are consecutive integers as strings, so a cursor is the last id returned.
 * Each append is fsynced before it returns. The feed never carries a token, a code or a cookie: the
 * service writes only fixed sentences into it.
 */
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, writeSync } from 'node:fs'

import { makeEvent, nowIso, type FabricEvent } from '../fabric/fabric-service.mjs'

export class EventLog {
  readonly file: string
  private last: number

  constructor(file: string) {
    this.file = file
    const events = this.all()
    this.last = Number(events.at(-1)?.id ?? 0)
  }

  append(kind: string, level: FabricEvent['level'], text: string): FabricEvent {
    const event = makeEvent(String(this.last + 1), nowIso(), kind, level, text)
    const fd = openSync(this.file, 'a', 0o600)
    try {
      writeSync(fd, `${JSON.stringify(event)}\n`)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    this.last += 1
    return event
  }

  /** Events after `after`, ascending; with no cursor, the newest `limit`, ascending. */
  read(after: string | null, limit: number): FabricEvent[] {
    const events = this.all()
    if (after === null) return events.slice(-limit)
    const from = Number(after)
    return events.filter((event) => Number(event.id) > from).slice(0, limit)
  }

  private all(): FabricEvent[] {
    if (!existsSync(this.file)) return []
    return readFileSync(this.file, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as FabricEvent)
  }
}
