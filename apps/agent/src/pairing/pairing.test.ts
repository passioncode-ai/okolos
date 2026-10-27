import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  CLAIM_WINDOW_MS,
  EXPIRED_SHOWN_MS,
  MAX_NEW_PER_MINUTE,
  MAX_PENDING,
  Pairing,
  REQUEST_LIFETIME_MS,
  type PairingNotice,
  type RandomSource,
} from './pairing.js'

const temps: string[] = []
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function storeFile(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'okolos-agent-pairing-'))
  temps.push(dir)
  return path.join(dir, 'pairings.json')
}

/** A random source that gives the same bytes on every run: SHA-256 of a seed and a counter. */
function seeded(seed = 'n-007'): RandomSource {
  let n = 0
  return (size) => {
    const out = Buffer.alloc(size)
    let filled = 0
    while (filled < size) filled += createHash('sha256').update(`${seed}:${n++}`).digest().copy(out, filled)
    return out
  }
}

const T0 = Date.parse('2026-10-27T10:00:00Z')
const MINUTE = 60_000

function open(file = storeFile(), notices: PairingNotice[] = []): Pairing {
  return Pairing.open(file, { random: seeded(), onNotice: (notice) => notices.push(notice) })
}

function asked(result: ReturnType<Pairing['request']>): { requestId: string; code: string; expiresAt: number } {
  if ('refused' in result) throw new Error(`refused: ${result.refused}`)
  return result
}

describe('the pairing request id (spec §11 F5)', () => {
  it('is 128 bits as 32 hex, and the code is six digits; the request lives five minutes', () => {
    const pairing = open()
    const { requestId, code, expiresAt } = asked(pairing.request('Claude Code', T0))
    expect(requestId).toMatch(/^[0-9a-f]{32}$/)
    expect(code).toMatch(/^\d{6}$/)
    expect(REQUEST_LIFETIME_MS).toBe(5 * MINUTE)
    expect(expiresAt).toBe(T0 + REQUEST_LIFETIME_MS)
  })

  it('never reaches the page, the store or a notice the journal and events are written from', () => {
    const file = storeFile()
    const notices: PairingNotice[] = []
    const pairing = open(file, notices)
    const ids: string[] = []

    // One request paired and then revoked, one declined, one left to expire.
    const paired = asked(pairing.request('Claude Code', T0))
    const declined = asked(pairing.request('Codex', T0 + 1))
    const expiring = asked(pairing.request('Cursor', T0 + 2))
    ids.push(paired.requestId, declined.requestId, expiring.requestId)

    const page = pairing.list(T0 + 3)
    expect(page.requests).toHaveLength(3)
    for (const row of page.requests) {
      expect(row.handle).not.toMatch(/^[0-9a-f]{32}$/)
      expect(Object.keys(row)).not.toContain('requestId')
    }
    const byName = new Map(page.requests.map((row) => [row.name, row.handle]))

    expect(pairing.confirmByHandle(byName.get('Claude Code')!, T0 + 4)).toBe(true)
    expect(pairing.declineByHandle(byName.get('Codex')!)).toBe(true)
    const claimed = pairing.claim(paired.requestId, T0 + 5)
    expect(claimed).toHaveProperty('key')
    const later = pairing.list(T0 + REQUEST_LIFETIME_MS + 10)
    expect(pairing.revoke(later.agents[0]!.agentId)).toBe(true)

    const everything = JSON.stringify({ page, later, notices, store: readFileSync(file, 'utf8') })
    for (const id of ids) expect(everything).not.toContain(id)
    expect(notices.map((n) => n.kind)).toEqual(['requested', 'requested', 'requested', 'confirmed', 'declined', 'paired', 'expired', 'revoked'])
  })

  it('is forgotten once the key is given out: a second claim and a late confirm find nothing', () => {
    const pairing = open()
    const { requestId } = asked(pairing.request('Claude Code', T0))
    expect(pairing.confirm(requestId, T0 + 1)).toBe(true)
    expect(pairing.claim(requestId, T0 + 2)).toHaveProperty('key')
    expect(pairing.confirm(requestId, T0 + 3)).toBe(false)
    expect(pairing.claim(requestId, T0 + 4)).toBeNull()
    expect(pairing.list(T0 + 5).requests).toEqual([])
  })
})

describe('claiming the key (spec §11 F5)', () => {
  it('before the person confirms answers pending and makes no new request', () => {
    const pairing = open()
    const { requestId } = asked(pairing.request('Claude Code', T0))
    expect(pairing.claim(requestId, T0 + 1000)).toEqual({ pending: true })
    expect(pairing.claim(requestId, T0 + 2000)).toEqual({ pending: true })
    expect(pairing.list(T0 + 2000).requests).toHaveLength(1)
    expect(pairing.list(T0 + 2000).agents).toEqual([])
  })

  it('after the confirm gives a 256-bit key once; a second claim finds nothing', () => {
    const pairing = open()
    const { requestId } = asked(pairing.request('Claude Code', T0))
    expect(pairing.confirm(requestId, T0 + MINUTE)).toBe(true)
    const first = pairing.claim(requestId, T0 + MINUTE + 1)
    expect(first).toEqual({ key: expect.stringMatching(/^[0-9a-f]{64}$/) })
    expect(pairing.claim(requestId, T0 + MINUTE + 2)).toBeNull()
    expect(pairing.list(T0 + MINUTE + 3).agents.map((a) => a.name)).toEqual(['Claude Code'])
  })

  it('closes five minutes after the confirm, even when the confirm came late in the request', () => {
    expect(CLAIM_WINDOW_MS).toBe(5 * MINUTE)
    const pairing = open()
    const late = asked(pairing.request('Claude Code', T0))
    const confirmedAt = T0 + 4 * MINUTE
    expect(pairing.confirm(late.requestId, confirmedAt)).toBe(true)
    // Past the request's own five minutes, inside the claim window: still claimable.
    expect(pairing.claim(late.requestId, T0 + 6 * MINUTE)).toHaveProperty('key')

    const missed = asked(pairing.request('Codex', T0))
    expect(pairing.confirm(missed.requestId, confirmedAt)).toBe(true)
    expect(pairing.claim(missed.requestId, confirmedAt + CLAIM_WINDOW_MS)).toBeNull()
    expect(pairing.list(confirmedAt + CLAIM_WINDOW_MS).agents.map((a) => a.name)).toEqual(['Claude Code'])
  })

  it('is refused for a request the person declined', () => {
    const pairing = open()
    const { requestId } = asked(pairing.request('Claude Code', T0))
    expect(pairing.decline(requestId)).toBe(true)
    expect(pairing.claim(requestId, T0 + 1)).toBeNull()
    expect(pairing.confirm(requestId, T0 + 2)).toBe(false)
    expect(pairing.list(T0 + 3).requests).toEqual([])
  })

  it('finds nothing for an id it never gave out', () => {
    const pairing = open()
    expect(pairing.claim('0'.repeat(32), T0)).toBeNull()
    expect(pairing.confirm('0'.repeat(32), T0)).toBe(false)
  })
})

describe('how long a request lives and how many there may be (spec §11 F5)', () => {
  it('ends five minutes after its creation when nobody confirms it', () => {
    const notices: PairingNotice[] = []
    const pairing = open(storeFile(), notices)
    const { requestId } = asked(pairing.request('Claude Code', T0))
    expect(pairing.claim(requestId, T0 + REQUEST_LIFETIME_MS - 1)).toEqual({ pending: true })
    expect(pairing.claim(requestId, T0 + REQUEST_LIFETIME_MS)).toBeNull()
    expect(pairing.confirm(requestId, T0 + REQUEST_LIFETIME_MS)).toBe(false)
    expect(notices.filter((n) => n.kind === 'expired')).toHaveLength(1)
  })

  it('stays on the page as expired, with nothing to press, then leaves it (SCR-23)', () => {
    expect(EXPIRED_SHOWN_MS).toBe(5 * MINUTE)
    const pairing = open()
    asked(pairing.request('Claude Code', T0))
    const [row] = pairing.list(T0 + REQUEST_LIFETIME_MS).requests
    expect(row).toMatchObject({ name: 'Claude Code', state: 'expired', expiresAt: T0 + REQUEST_LIFETIME_MS })
    expect(pairing.confirmByHandle(row!.handle, T0 + REQUEST_LIFETIME_MS + 1)).toBe(false)
    expect(pairing.list(T0 + REQUEST_LIFETIME_MS + 1).requests[0]).toMatchObject({ state: 'expired' })
    expect(pairing.list(T0 + REQUEST_LIFETIME_MS + EXPIRED_SHOWN_MS).requests).toEqual([])
  })

  it('refuses a fourth waiting request; a confirmed one still waits for its claim', () => {
    expect(MAX_PENDING).toBe(3)
    const pairing = open()
    const first = asked(pairing.request('Agent one', T0))
    asked(pairing.request('Agent two', T0 + 1))
    const third = asked(pairing.request('Agent three', T0 + 2))
    expect(pairing.request('Agent four', T0 + 3)).toEqual({ refused: 'too_many_pending' })
    expect(pairing.confirm(first.requestId, T0 + 4)).toBe(true)
    expect(pairing.request('Agent four', T0 + 5)).toEqual({ refused: 'too_many_pending' })
    expect(pairing.claim(first.requestId, T0 + 6)).toHaveProperty('key')
    asked(pairing.request('Agent four', T0 + 7))
    expect(pairing.decline(third.requestId)).toBe(true)
    asked(pairing.request('Agent five', T0 + 8))
    // An expired request waits for nothing.
    asked(pairing.request('Agent six', T0 + 8 + REQUEST_LIFETIME_MS))
  })

  it('refuses a seventh new request within a minute, and takes one again when the minute moves on', () => {
    expect(MAX_NEW_PER_MINUTE).toBe(6)
    const pairing = open()
    for (let n = 0; n < 6; n++) {
      const { requestId } = asked(pairing.request(`Agent ${n}`, T0 + n * 1000))
      pairing.decline(requestId)
    }
    expect(pairing.request('Agent seven', T0 + MINUTE - 1)).toEqual({ refused: 'too_many_requests' })
    // A refused request is not a new one: the count stays at six, and the first leaves at T0 + 1 min.
    asked(pairing.request('Agent seven', T0 + MINUTE))
    expect(pairing.request('Agent eight', T0 + MINUTE + 1)).toEqual({ refused: 'too_many_requests' })
  })

  it('refuses a name the rules refuse, and that refusal counts toward nothing', () => {
    const pairing = open()
    expect(pairing.request('agent 123', T0)).toEqual({ refused: 'name_digits' })
    expect(pairing.request('a'.repeat(41), T0)).toEqual({ refused: 'name_too_long' })
    expect(pairing.list(T0).requests).toEqual([])
  })
})

describe('two waiting requests under one name (spec §11 F5)', () => {
  function flags(pairing: Pairing, now: number): Record<string, boolean> {
    return Object.fromEntries(pairing.list(now).requests.map((row) => [`${row.name}#${row.handle}`, row.duplicateName]))
  }

  it('are both marked, and a request with a name of its own is not', () => {
    const pairing = open()
    asked(pairing.request('Claude Code', T0))
    asked(pairing.request('Claude Code', T0 + 1))
    asked(pairing.request('Codex', T0 + 2))
    const rows = pairing.list(T0 + 3).requests
    expect(rows.filter((row) => row.name === 'Claude Code').map((row) => row.duplicateName)).toEqual([true, true])
    expect(rows.find((row) => row.name === 'Codex')?.duplicateName).toBe(false)
  })

  it('are marked when the names differ only in case or in Unicode form', () => {
    const pairing = open()
    asked(pairing.request('Claude Code', T0))
    asked(pairing.request('claude code', T0 + 1))
    expect(Object.values(flags(pairing, T0 + 2))).toEqual([true, true])

    const other = open()
    asked(other.request('Café', T0))
    asked(other.request('Café', T0 + 1))
    expect(Object.values(flags(other, T0 + 2))).toEqual([true, true])
  })

  it('stay marked when one is already confirmed, and the mark goes when the other leaves', () => {
    const pairing = open()
    const first = asked(pairing.request('Claude Code', T0))
    const second = asked(pairing.request('Claude Code', T0 + 1))
    expect(pairing.confirm(first.requestId, T0 + 2)).toBe(true)
    expect(Object.values(flags(pairing, T0 + 3))).toEqual([true, true])
    expect(pairing.decline(second.requestId)).toBe(true)
    expect(Object.values(flags(pairing, T0 + 4))).toEqual([false])
  })

  it('are not marked against an expired row, which waits for nothing', () => {
    const pairing = open()
    asked(pairing.request('Claude Code', T0))
    asked(pairing.request('Claude Code', T0 + REQUEST_LIFETIME_MS))
    const rows = pairing.list(T0 + REQUEST_LIFETIME_MS + 1).requests
    expect(rows.map((row) => [row.state, row.duplicateName])).toEqual([
      ['pending', false],
      ['expired', false],
    ])
  })
})

describe('the page acts by handle, never by request id (audit #9)', () => {
  it('confirms by the handle list() gives, and the agent can then claim', () => {
    const pairing = open()
    const { requestId } = asked(pairing.request('Claude Code', T0))
    const [row] = pairing.list(T0 + 1).requests
    expect(row).toMatchObject({ name: 'Claude Code', state: 'pending' })
    expect(pairing.confirmByHandle(row!.handle, T0 + 2)).toBe(true)
    expect(pairing.list(T0 + 3).requests[0]).toMatchObject({ handle: row!.handle, state: 'confirmed' })
    expect(pairing.claim(requestId, T0 + 4)).toHaveProperty('key')
  })

  it('declines by the handle list() gives, and the agent then finds nothing', () => {
    const pairing = open()
    const { requestId } = asked(pairing.request('Claude Code', T0))
    const [row] = pairing.list(T0 + 1).requests
    expect(pairing.declineByHandle(row!.handle)).toBe(true)
    expect(pairing.claim(requestId, T0 + 2)).toBeNull()
    expect(pairing.list(T0 + 3).requests).toEqual([])
  })

  it('refuses a request id offered as a handle, and a handle offered as a request id', () => {
    const pairing = open()
    const { requestId } = asked(pairing.request('Claude Code', T0))
    const [row] = pairing.list(T0 + 1).requests
    expect(row!.handle).not.toBe(requestId)
    expect(pairing.confirmByHandle(requestId, T0 + 2)).toBe(false)
    expect(pairing.declineByHandle(requestId)).toBe(false)
    expect(pairing.confirm(row!.handle, T0 + 2)).toBe(false)
    expect(pairing.decline(row!.handle)).toBe(false)
    expect(pairing.claim(requestId, T0 + 3)).toEqual({ pending: true })
    expect(pairing.list(T0 + 3).requests[0]).toMatchObject({ state: 'pending' })
  })

  it('does not confirm a request whose five minutes are over', () => {
    const pairing = open()
    const { requestId } = asked(pairing.request('Claude Code', T0))
    const [row] = pairing.list(T0 + 1).requests
    expect(pairing.confirmByHandle(row!.handle, T0 + REQUEST_LIFETIME_MS)).toBe(false)
    expect(pairing.claim(requestId, T0 + REQUEST_LIFETIME_MS)).toBeNull()
  })
})
