import { describe, expect, it } from 'vitest'

import { AuditWriteError, TransportError } from '@okolos/net'

import { countedToday, sendFailure, SendTimedOut, storageFailureKind, utcDay, withCounted } from './errors.js'

const NOON = Date.parse('2026-11-19T12:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000

describe('error_occurred once a UTC day for each area and kind (B-206)', () => {
  it('counts nothing before the first record', () => {
    expect(countedToday(undefined, 'download', 'unexpected', NOON)).toBe(false)
  })

  it('knows a pair counted today, and only that pair', () => {
    const record = withCounted(undefined, 'download', 'unexpected', NOON)
    expect(record).toEqual({ day: utcDay(NOON), seen: ['download:unexpected'] })
    expect(countedToday(record, 'download', 'unexpected', NOON + 60_000)).toBe(true)
    expect(countedToday(record, 'storage', 'unexpected', NOON)).toBe(false)
    expect(countedToday(record, 'download', 'timeout', NOON)).toBe(false)
  })

  it('starts over at UTC midnight, not after 24 hours', () => {
    const late = Date.parse('2026-11-19T23:59:00.000Z')
    const record = withCounted(undefined, 'usage', 'network', late)
    expect(countedToday(record, 'usage', 'network', late + 2 * 60_000)).toBe(false)
    expect(withCounted(record, 'usage', 'network', late + 2 * 60_000)).toEqual({ day: utcDay(late) + 1, seen: ['usage:network'] })
  })

  it('keeps the day\'s other pairs when it adds one', () => {
    const one = withCounted(undefined, 'storage', 'storage-full', NOON)
    expect(withCounted(one, 'usage', 'refused', NOON).seen).toEqual(['storage:storage-full', 'usage:refused'])
    expect(utcDay(NOON + DAY)).toBe(utcDay(NOON) + 1)
  })
})

describe('a failed write to the extension storage', () => {
  it('is storage-full when the engine says the quota ran out, and unexpected otherwise', () => {
    expect(storageFailureKind(Object.assign(new Error('x'), { name: 'QuotaExceededError' }))).toBe('storage-full')
    expect(storageFailureKind(new Error('the database connection is closing'))).toBe('unexpected')
  })
})

describe('a failed usage send', () => {
  it('reads the answer: 408 timeout, 4xx refused, 5xx unexpected', () => {
    expect(sendFailure({ status: 408 })).toEqual({ area: 'usage', kind: 'timeout' })
    expect(sendFailure({ status: 400 })).toEqual({ area: 'usage', kind: 'refused' })
    expect(sendFailure({ status: 429 })).toEqual({ area: 'usage', kind: 'refused' })
    expect(sendFailure({ status: 503 })).toEqual({ area: 'usage', kind: 'unexpected' })
  })

  it('reads what was thrown: the deadline, the network, the audit write, a fault', () => {
    expect(sendFailure({ thrown: new TransportError(new SendTimedOut('late')) })).toEqual({ area: 'usage', kind: 'timeout' })
    expect(sendFailure({ thrown: new TransportError(new TypeError('Failed to fetch')) })).toEqual({ area: 'usage', kind: 'network' })
    expect(sendFailure({ thrown: new AuditWriteError(Object.assign(new Error('q'), { name: 'QuotaExceededError' })) })).toEqual({
      area: 'storage',
      kind: 'storage-full',
    })
    expect(sendFailure({ thrown: new AuditWriteError(new Error('did not open in time')) })).toEqual({ area: 'storage', kind: 'unexpected' })
    expect(sendFailure({ thrown: new TypeError('x is not a function') })).toEqual({ area: 'usage', kind: 'unexpected' })
  })
})
