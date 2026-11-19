import { AuditWriteError, TransportError } from '@okolos/net'

import { isOutOfSpace } from '../audit-space.js'
import type { EventProps } from './catalogue.js'

/**
 * `error_occurred` is counted at most once a UTC day for each area and kind (B-206).
 *
 * A failing step repeats: the same send fails at every flush, the same full disk refuses every
 * journal line. One event a day says the failure happened on this install that day, which is what
 * the error rate reads; more of them would only fill the queue (500 events) with copies.
 */

export type ErrorArea = EventProps<'error_occurred'>['area']
export type ErrorKind = EventProps<'error_occurred'>['kind']

/** Where the day's counted pairs are kept, beside the queue in `storage.local`. */
export const ERRORS_KEY = 'usage:errorsReported'

export interface ErrorsReported {
  /** Days since the epoch in UTC. */
  readonly day: number
  /** `area:kind` pairs counted that day. */
  readonly seen: readonly string[]
}

const DAY_MS = 24 * 60 * 60 * 1000

export function utcDay(now: number): number {
  return Math.floor(now / DAY_MS)
}

/** Whether `area`/`kind` was counted already on the UTC day of `now`; a record of another day counts nothing. */
export function countedToday(record: ErrorsReported | undefined, area: ErrorArea, kind: ErrorKind, now: number): boolean {
  return record !== undefined && record.day === utcDay(now) && record.seen.includes(`${area}:${kind}`)
}

/** The record with `area`/`kind` added for the UTC day of `now`; a record of another day starts over. */
export function withCounted(record: ErrorsReported | undefined, area: ErrorArea, kind: ErrorKind, now: number): ErrorsReported {
  const day = utcDay(now)
  const seen = record !== undefined && record.day === day ? record.seen : []
  return { day, seen: [...seen, `${area}:${kind}`] }
}

/** The kind of a failed write to the extension's own storage. */
export function storageFailureKind(cause: unknown): ErrorKind {
  return isOutOfSpace(cause) ? 'storage-full' : 'unexpected'
}

/**
 * The deadline of a usage send (`send.ts`), carried as the `TransportError`'s cause so the failure
 * reads as `timeout` and not `network`.
 */
export class SendTimedOut extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SendTimedOut'
  }
}

/**
 * What a failed usage send counts as: the answer's status, or what was thrown.
 *
 * A failed audit write is the storage's failure (the send was refused because the log could not be
 * written); everything else is the send's own, area `usage`.
 */
export function sendFailure(failure: { status: number } | { thrown: unknown }): { area: ErrorArea; kind: ErrorKind } {
  if ('status' in failure) {
    if (failure.status === 408) return { area: 'usage', kind: 'timeout' }
    return { area: 'usage', kind: failure.status >= 500 ? 'unexpected' : 'refused' }
  }
  const cause = failure.thrown
  if (cause instanceof AuditWriteError) return { area: 'storage', kind: storageFailureKind(cause.cause) }
  if (cause instanceof TransportError) return { area: 'usage', kind: cause.cause instanceof SendTimedOut ? 'timeout' : 'network' }
  return { area: 'usage', kind: 'unexpected' }
}
