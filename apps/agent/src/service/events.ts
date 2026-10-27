/**
 * The service's events feed (`GET /fabric/v1/events`): a JSONL file in the data folder.
 *
 * The Node kit pages events (`eventsPage`) and shapes them (`makeEvent`) but, unlike the Python
 * kit, carries no JSONL log, so this is the small one the service keeps. Each event is one sentence
 * a person reads; ids are consecutive integers as strings, so a cursor is the last id returned.
 * Each append is fsynced before it returns. The feed never carries a token, a code or a cookie: the
 * service writes only fixed sentences into it.
 *
 * Retention (fabric-service/0.1, events page): at least seven days or 1000 events. At start the
 * log keeps every event of the last seven days and the newest 1000 whatever their age, and drops
 * the rest in one atomic rewrite. Ids are kept, so a cursor a host holds stays valid.
 */
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, writeSync } from 'node:fs'

import { atomicWrite, makeEvent, nowIso, type FabricEvent } from '../fabric/fabric-service.mjs'

/** The newest events kept whatever their age. */
export const KEEP_EVENTS = 1000
/** Events younger than this are kept however many there are. */
export const KEEP_DAYS = 7

export class EventLog {
  readonly file: string
  private last: number

  constructor(file: string, { now = () => Date.now() }: { now?: () => number } = {}) {
    this.file = file
    const events = this.all()
    this.last = Number(events.at(-1)?.id ?? 0)
    this.trim(now())
  }

  /**
   * Drops what is both older than KEEP_DAYS and outside the newest KEEP_EVENTS; returns how many.
   * Runs at start, and the daemon calls it once a day so a long run stays bounded too.
   */
  trim(now: number = Date.now()): number {
    const events = this.all()
    if (events.length <= KEEP_EVENTS) return 0
    const horizon = now - KEEP_DAYS * 24 * 60 * 60 * 1000
    const firstOfNewest = events.length - KEEP_EVENTS
    const kept = events.filter((event, index) => index >= firstOfNewest || Date.parse(event.at) >= horizon)
    if (kept.length === events.length) return 0
    atomicWrite(this.file, kept.map((event) => `${JSON.stringify(event)}\n`).join(''), 0o600)
    return events.length - kept.length
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
