import { createHash, timingSafeEqual } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { serviceDirs } from '../service/dirs.js'
import {
  CLAIM_WINDOW_MS,
  EXPIRED_SHOWN_MS,
  MAX_NEW_PER_MINUTE,
  MAX_PENDING,
  MAX_STORE_BYTES,
  Pairing,
  PairingStoreError,
  REQUEST_LIFETIME_MS,
  pairingStoreFile,
  type PairingNotice,
  type RandomSource,
} from './pairing.js'

// The real comparison, watched: verify must go through it.
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>()
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) }
})

const temps: string[] = []
afterEach(() => {
  for (const dir of temps.splice(0)) {
    chmodSync(dir, 0o700)
    rmSync(dir, { recursive: true, force: true })
  }
  vi.mocked(timingSafeEqual).mockClear()
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

/**
 * The page's handle for a request, found in list() at `now` by the code the request was given, the
 * way the person matches the two codes. The page's actions take nothing else (audit #9).
 */
function handleOf(pairing: Pairing, request: { code: string }, now: number): string {
  const rows = pairing.list(now).requests.filter((row) => row.code === request.code)
  if (rows.length !== 1) throw new Error(`expected one row with code ${request.code}, found ${rows.length}`)
  return rows[0]!.handle
}

/** The person confirms the request on the page at `now`. */
function confirmAt(pairing: Pairing, request: { code: string }, now: number): boolean {
  return pairing.confirmByHandle(handleOf(pairing, request, now), now)
}

/** The person declines the request on the page at `now`. */
function declineAt(pairing: Pairing, request: { code: string }, now: number): boolean {
  return pairing.declineByHandle(handleOf(pairing, request, now), now)
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
    expect(pairing.declineByHandle(byName.get('Codex')!, T0 + 4)).toBe(true)
    const claimed = pairing.claim(paired.requestId, T0 + 5)
    expect(claimed).toHaveProperty('key')
    const later = pairing.list(T0 + REQUEST_LIFETIME_MS + 10)
    expect(pairing.revoke(later.agents[0]!.agentId, T0 + REQUEST_LIFETIME_MS + 11)).toMatchObject({ name: 'Claude Code' })

    const everything = JSON.stringify({ page, later, notices, store: readFileSync(file, 'utf8') })
    for (const id of ids) expect(everything).not.toContain(id)
    expect(notices.map((n) => n.kind)).toEqual(['requested', 'requested', 'requested', 'confirmed', 'declined', 'paired', 'expired', 'revoked'])
  })

  it('is forgotten once the key is given out: a second claim is told so, and a late confirm finds nothing', () => {
    const pairing = open()
    const request = asked(pairing.request('Claude Code', T0))
    const { requestId } = request
    const handle = handleOf(pairing, request, T0)
    expect(pairing.confirmByHandle(handle, T0 + 1)).toBe(true)
    expect(pairing.claim(requestId, T0 + 2)).toHaveProperty('key')
    expect(pairing.confirmByHandle(handle, T0 + 3)).toBe(false)
    expect(pairing.claim(requestId, T0 + 4)).toEqual({ refused: 'claimed' })
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

  it('after the confirm gives a 256-bit key once; a second claim is refused as claimed', () => {
    const pairing = open()
    const request = asked(pairing.request('Claude Code', T0))
    const { requestId } = request
    expect(confirmAt(pairing, request, T0 + MINUTE)).toBe(true)
    const first = pairing.claim(requestId, T0 + MINUTE + 1)
    expect(first).toEqual({ key: expect.stringMatching(/^[0-9a-f]{64}$/) })
    expect(pairing.claim(requestId, T0 + MINUTE + 2)).toEqual({ refused: 'claimed' })
    expect(pairing.list(T0 + MINUTE + 3).agents.map((a) => a.name)).toEqual(['Claude Code'])
  })

  it('closes five minutes after the confirm, even when the confirm came late in the request', () => {
    expect(CLAIM_WINDOW_MS).toBe(5 * MINUTE)
    const pairing = open()
    const late = asked(pairing.request('Claude Code', T0))
    const confirmedAt = T0 + 4 * MINUTE
    expect(confirmAt(pairing, late, confirmedAt)).toBe(true)
    // Past the request's own five minutes, inside the claim window: still claimable.
    expect(pairing.claim(late.requestId, T0 + 6 * MINUTE)).toHaveProperty('key')

    const missed = asked(pairing.request('Codex', T0))
    expect(confirmAt(pairing, missed, confirmedAt)).toBe(true)
    expect(pairing.claim(missed.requestId, confirmedAt + CLAIM_WINDOW_MS)).toEqual({ refused: 'claim_expired' })
    expect(pairing.list(confirmedAt + CLAIM_WINDOW_MS).agents.map((a) => a.name)).toEqual(['Claude Code'])
  })

  it('is refused for a request the person declined', () => {
    const pairing = open()
    const request = asked(pairing.request('Claude Code', T0))
    const handle = handleOf(pairing, request, T0)
    expect(pairing.declineByHandle(handle, T0)).toBe(true)
    expect(pairing.claim(request.requestId, T0 + 1)).toEqual({ refused: 'declined' })
    expect(pairing.confirmByHandle(handle, T0 + 2)).toBe(false)
    expect(pairing.list(T0 + 3).requests).toEqual([])
  })

  it('answers unknown for an id it never gave out', () => {
    const pairing = open()
    expect(pairing.claim('0'.repeat(32), T0)).toEqual({ refused: 'unknown' })
    expect(pairing.confirmByHandle('0'.repeat(16), T0)).toBe(false)
    expect(pairing.declineByHandle('0'.repeat(16), T0)).toBe(false)
  })
})

// Fix round 3: a claim that gets no key says why, so the CLI can tell the person the true reason.
describe('why a claim gets no key (fix round 3)', () => {
  it('says declined, expired, claim_expired or claimed while the end is recent, then unknown', () => {
    const pairing = open()
    const declined = asked(pairing.request('Declined', T0))
    const expired = asked(pairing.request('Expired', T0))
    const missed = asked(pairing.request('Missed', T0))
    expect(confirmAt(pairing, missed, T0 + 1)).toBe(true)
    const declinedAt = T0 + 4 * MINUTE
    expect(declineAt(pairing, declined, declinedAt)).toBe(true)
    // The decline frees a place for a fourth request (MAX_PENDING), which is paired at once.
    const claimed = asked(pairing.request('Claimed', declinedAt))
    expect(confirmAt(pairing, claimed, declinedAt)).toBe(true)
    expect(pairing.claim(claimed.requestId, declinedAt)).toHaveProperty('key')

    // Past the request's five minutes and the missed claim window: all four have ended.
    const at = T0 + 1 + CLAIM_WINDOW_MS
    expect(pairing.claim(declined.requestId, at)).toEqual({ refused: 'declined' })
    expect(pairing.claim(expired.requestId, at)).toEqual({ refused: 'expired' })
    expect(pairing.claim(missed.requestId, at)).toEqual({ refused: 'claim_expired' })
    expect(pairing.claim(claimed.requestId, at)).toEqual({ refused: 'claimed' })
    // The answer does not change on asking again, and makes no request.
    expect(pairing.claim(expired.requestId, at + 1)).toEqual({ refused: 'expired' })
    expect(pairing.list(at + 1).requests.map((row) => [row.name, row.state])).toEqual([
      ['Expired', 'expired'],
      ['Missed', 'claim_expired'],
    ])

    // Each answer is kept as long as an ended row is shown, counted from its end; then unknown.
    // (The clock only moves forward: a later sweep has already dropped what an earlier time kept.)
    expect(pairing.claim(declined.requestId, declinedAt + EXPIRED_SHOWN_MS - 1)).toEqual({ refused: 'declined' })
    expect(pairing.claim(claimed.requestId, declinedAt + EXPIRED_SHOWN_MS - 1)).toEqual({ refused: 'claimed' })
    expect(pairing.claim(declined.requestId, declinedAt + EXPIRED_SHOWN_MS)).toEqual({ refused: 'unknown' })
    expect(pairing.claim(claimed.requestId, declinedAt + EXPIRED_SHOWN_MS)).toEqual({ refused: 'unknown' })
    expect(pairing.claim(expired.requestId, T0 + REQUEST_LIFETIME_MS + EXPIRED_SHOWN_MS - 1)).toEqual({ refused: 'expired' })
    expect(pairing.claim(expired.requestId, T0 + REQUEST_LIFETIME_MS + EXPIRED_SHOWN_MS)).toEqual({ refused: 'unknown' })
    expect(pairing.claim(missed.requestId, at + EXPIRED_SHOWN_MS - 1)).toEqual({ refused: 'claim_expired' })
    expect(pairing.claim(missed.requestId, at + EXPIRED_SHOWN_MS)).toEqual({ refused: 'unknown' })
  })

  it('keeps no request id to answer with: only its SHA-256, in memory', () => {
    const pairing = open()
    const request = asked(pairing.request('Claude Code', T0))
    expect(declineAt(pairing, request, T0 + 1)).toBe(true)
    // What the instance holds, as JSON, never carries the request id itself.
    const held = JSON.stringify(pairing, (_key, value: unknown) => (value instanceof Map ? [...value.entries()] : value))
    expect(held).not.toContain(request.requestId)
    expect(pairing.claim(request.requestId, T0 + 2)).toEqual({ refused: 'declined' })
  })
})

describe('how long a request lives and how many there may be (spec §11 F5)', () => {
  it('ends five minutes after its creation when nobody confirms it', () => {
    const notices: PairingNotice[] = []
    const pairing = open(storeFile(), notices)
    const request = asked(pairing.request('Claude Code', T0))
    const { requestId } = request
    expect(pairing.claim(requestId, T0 + REQUEST_LIFETIME_MS - 1)).toEqual({ pending: true })
    expect(pairing.claim(requestId, T0 + REQUEST_LIFETIME_MS)).toEqual({ refused: 'expired' })
    // The ended row keeps its handle on the page, and that handle confirms nothing.
    expect(confirmAt(pairing, request, T0 + REQUEST_LIFETIME_MS)).toBe(false)
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

  it('tells a request never confirmed from a confirmed one whose key nobody collected (SCR-23, fix round 1)', () => {
    const notices: PairingNotice[] = []
    const pairing = open(storeFile(), notices)
    asked(pairing.request('Never confirmed', T0))
    const late = asked(pairing.request('Confirmed late', T0 + 1))
    const confirmedAt = T0 + 2 * MINUTE
    expect(confirmAt(pairing, late, confirmedAt)).toBe(true)
    expect(pairing.list(confirmedAt + 1).requests[1]).toMatchObject({ state: 'confirmed', confirmedAt, expiresAt: confirmedAt + CLAIM_WINDOW_MS })

    // At T0 + 5 min the unconfirmed one ends as 'expired'; the confirmed one still waits.
    const atFive = pairing.list(T0 + REQUEST_LIFETIME_MS).requests
    expect(atFive.map((row) => [row.name, row.state, row.confirmedAt])).toEqual([
      ['Confirmed late', 'confirmed', confirmedAt],
      ['Never confirmed', 'expired', null],
    ])

    // Five minutes after its confirm the key was not collected: 'claim_expired', still saying when.
    const end = confirmedAt + CLAIM_WINDOW_MS
    expect(pairing.list(end - 1).requests.find((row) => row.name === 'Confirmed late')?.state).toBe('confirmed')
    expect(pairing.list(end).requests.find((row) => row.name === 'Confirmed late')).toMatchObject({
      state: 'claim_expired',
      confirmedAt,
      expiresAt: end,
      duplicateName: false,
    })
    expect(pairing.claim(late.requestId, end)).toEqual({ refused: 'claim_expired' })
    expect(pairing.list(end + EXPIRED_SHOWN_MS).requests).toEqual([])
    expect(notices.filter((n) => n.kind === 'expired' || n.kind === 'claim_expired').map((n) => [n.kind, n.name])).toEqual([
      ['expired', 'Never confirmed'],
      ['claim_expired', 'Confirmed late'],
    ])
  })

  it('refuses a fourth waiting request; a confirmed one still waits for its claim', () => {
    expect(MAX_PENDING).toBe(3)
    const pairing = open()
    const first = asked(pairing.request('Agent one', T0))
    asked(pairing.request('Agent two', T0 + 1))
    const third = asked(pairing.request('Agent three', T0 + 2))
    expect(pairing.request('Agent four', T0 + 3)).toEqual({ refused: 'too_many_pending' })
    expect(confirmAt(pairing, first, T0 + 4)).toBe(true)
    expect(pairing.request('Agent four', T0 + 5)).toEqual({ refused: 'too_many_pending' })
    expect(pairing.claim(first.requestId, T0 + 6)).toHaveProperty('key')
    asked(pairing.request('Agent four', T0 + 7))
    expect(declineAt(pairing, third, T0 + 7)).toBe(true)
    asked(pairing.request('Agent five', T0 + 8))
    // An expired request waits for nothing.
    asked(pairing.request('Agent six', T0 + 8 + REQUEST_LIFETIME_MS))
  })

  it('refuses a seventh new request within a minute, and takes one again when the minute moves on', () => {
    expect(MAX_NEW_PER_MINUTE).toBe(6)
    const pairing = open()
    for (let n = 0; n < 6; n++) {
      const request = asked(pairing.request(`Agent ${n}`, T0 + n * 1000))
      expect(declineAt(pairing, request, T0 + n * 1000)).toBe(true)
    }
    expect(pairing.request('Agent seven', T0 + MINUTE - 1)).toEqual({ refused: 'too_many_requests' })
    // A refused request is not a new one: the count stays at six, and the first leaves at T0 + 1 min.
    asked(pairing.request('Agent seven', T0 + MINUTE))
    expect(pairing.request('Agent eight', T0 + MINUTE + 1)).toEqual({ refused: 'too_many_requests' })
  })

  it('keeps the name in NFC: on the page, in the notices and in the store (fix round 5)', () => {
    const file = storeFile()
    const notices: PairingNotice[] = []
    const pairing = open(file, notices)
    const decomposed = 'Йван'
    const composed = 'Йван'
    const key = pair(pairing, decomposed, T0)
    expect(pairing.verify(key)).toMatchObject({ name: composed })
    expect(notices.map((n) => n.name)).toEqual([composed, composed, composed])
    expect(readFileSync(file, 'utf8')).toContain(`"name": "${composed}"`)
    expect(open(file).verify(key)).toMatchObject({ name: composed })
  })

  it('refuses a name the rules refuse, and that refusal counts toward nothing', () => {
    const pairing = open()
    expect(pairing.request('agent 123', T0)).toEqual({ refused: 'name_digits' })
    expect(pairing.request('a'.repeat(41), T0)).toEqual({ refused: 'name_too_long' })
    expect(pairing.request('Okolos Agent', T0)).toEqual({ refused: 'name_reserved' })
    expect(pairing.request('Oko\u0399os', T0)).toEqual({ refused: 'name_script' }) // Greek capital iota
    expect(pairing.request('\u041ekolos', T0)).toEqual({ refused: 'name_script' }) // Cyrillic O among Latin letters
    expect(pairing.list(T0).requests).toEqual([])
  })
})

/** Pairs `name` from request to claim and gives back the key. */
function pair(pairing: Pairing, name: string, now: number): string {
  const request = asked(pairing.request(name, now))
  expect(confirmAt(pairing, request, now + 1)).toBe(true)
  const claimed = pairing.claim(request.requestId, now + 2)
  if (!('key' in claimed)) throw new Error('no key')
  return claimed.key
}

describe('checking a key and the pairing store (spec §3, §11 F13)', () => {
  it('lives in the service data folder', () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'okolos-agent-home-'))
    temps.push(home)
    expect(pairingStoreFile(serviceDirs(home))).toBe(path.join(serviceDirs(home).data, 'pairings.json'))
  })

  it('finds the agent a key belongs to by its SHA-256, compared with timingSafeEqual', () => {
    const pairing = open()
    const key = pair(pairing, 'Claude Code', T0)
    pair(pairing, 'Codex', T0 + 10)
    vi.mocked(timingSafeEqual).mockClear()

    expect(pairing.verify(key)).toEqual({ agentId: expect.any(String), name: 'Claude Code', pairedAt: T0 + 2, lastCallAt: null })
    const digest = createHash('sha256').update(key, 'utf8').digest()
    const calls = vi.mocked(timingSafeEqual).mock.calls
    expect(calls.length).toBeGreaterThan(0)
    for (const [a, b] of calls) {
      expect(Buffer.byteLength(a as Buffer)).toBe(32)
      expect(Buffer.byteLength(b as Buffer)).toBe(32)
    }
    expect(calls.some(([a, b]) => digest.equals(a as Buffer) || digest.equals(b as Buffer))).toBe(true)

    expect(pairing.verify('f'.repeat(64))).toBeNull()
    expect(pairing.verify('')).toBeNull()
  })

  it('keeps only the hash of the key, in a 0600 file that a reopened store reads back', () => {
    const file = storeFile()
    const key = pair(open(file), 'Claude Code', T0)
    const stored = readFileSync(file, 'utf8')
    expect(stored).not.toContain(key)
    expect(stored).toContain(createHash('sha256').update(key, 'utf8').digest('hex'))
    expect(statSync(file).mode & 0o777).toBe(0o600)

    expect(open(file).verify(key)).toMatchObject({ name: 'Claude Code' })
  })

  it('refuses a revoked key, now and after a reopen', () => {
    const file = storeFile()
    const pairing = open(file)
    const key = pair(pairing, 'Claude Code', T0)
    const kept = pair(pairing, 'Codex', T0 + 10)
    const agent = pairing.verify(key)!
    expect(pairing.revoke(agent.agentId, T0 + 20)).toEqual(agent)
    expect(pairing.verify(key)).toBeNull()
    expect(pairing.revoke(agent.agentId, T0 + 20)).toBeNull()
    expect(pairing.list(T0 + 20).agents.map((a) => a.name)).toEqual(['Codex'])
    expect(open(file).verify(key)).toBeNull()
    expect(open(file).verify(kept)).toMatchObject({ name: 'Codex' })
  })

  it('says who was revoked: the record it removed, and a notice with the agent id (fix round 1)', () => {
    const notices: PairingNotice[] = []
    const pairing = open(storeFile(), notices)
    const agent = pairing.verify(pair(pairing, 'Claude Code', T0))!
    expect(pairing.revoke(agent.agentId, T0 + 10)).toEqual(agent)
    expect(notices.at(-1)).toEqual({ kind: 'revoked', agentId: agent.agentId, name: 'Claude Code', at: T0 + 10 })
    expect(pairing.revoke('no-such-agent', T0 + 11)).toBeNull()
    expect(notices.filter((n) => n.kind === 'revoked')).toHaveLength(1)
  })

  it('records an agent last call in memory and writes it at most once a minute (fix round 1)', () => {
    const file = storeFile()
    const pairing = open(file)
    const agent = pairing.verify(pair(pairing, 'Claude Code', T0))!
    expect(agent.lastCallAt).toBeNull()
    expect(pairing.list(T0 + 3).agents[0]).toMatchObject({ lastCallAt: null })
    const stored = (): unknown => (JSON.parse(readFileSync(file, 'utf8')) as { agents: Array<{ lastCallAt: unknown }> }).agents[0]!.lastCallAt

    const t1 = T0 + 10_000
    expect(pairing.touch(agent.agentId, t1)).toBe(true)
    expect(pairing.list(t1).agents[0]).toMatchObject({ lastCallAt: t1 })
    expect(stored()).toBe(t1)
    const inode = statSync(file).ino

    expect(pairing.touch(agent.agentId, t1 + 30_000)).toBe(true)
    expect(pairing.list(t1 + 30_000).agents[0]).toMatchObject({ lastCallAt: t1 + 30_000 })
    expect(stored()).toBe(t1)
    expect(statSync(file).ino).toBe(inode)

    expect(pairing.touch(agent.agentId, t1 + MINUTE)).toBe(true)
    expect(stored()).toBe(t1 + MINUTE)
    expect(statSync(file).ino).not.toBe(inode)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(readdirSync(path.dirname(file))).toEqual(['pairings.json'])

    expect(open(file).list(t1 + MINUTE).agents[0]).toMatchObject({ name: 'Claude Code', lastCallAt: t1 + MINUTE })
    expect(open(file).verify('f'.repeat(64))).toBeNull()
  })

  describe('last calls of several agents (fix round 2)', () => {
    function stored(file: string): Record<string, unknown> {
      const agents = (JSON.parse(readFileSync(file, 'utf8')) as { agents: Array<{ name: string; lastCallAt: unknown }> }).agents
      return Object.fromEntries(agents.map((a) => [a.name, a.lastCallAt]))
    }

    it('keeps each agent stored value at most a minute old, without a flush', () => {
      const file = storeFile()
      const pairing = open(file)
      const a = pairing.verify(pair(pairing, 'Claude Code', T0))!
      const b = pairing.verify(pair(pairing, 'Codex', T0 + 10))!
      const t1 = T0 + 10_000
      const calls: Array<[string, number]> = [
        [a.agentId, t1],
        [b.agentId, t1 + 10_000],
        [a.agentId, t1 + 30_000],
        [b.agentId, t1 + 40_000],
        [a.agentId, t1 + 55_000],
        [a.agentId, t1 + 61_000],
        [b.agentId, t1 + 69_000],
        [b.agentId, t1 + 75_000],
        [a.agentId, t1 + 130_000],
      ]
      const latest = new Map<string, number>()
      for (const [agentId, at] of calls) {
        expect(pairing.touch(agentId, at)).toBe(true)
        latest.set(agentId, at)
        const now = stored(file)
        for (const [id, name] of [[a.agentId, 'Claude Code'], [b.agentId, 'Codex']] as const) {
          const last = latest.get(id)
          if (last === undefined) continue
          const value = now[name]
          expect(value, `${name} after a call at ${at - T0}`).toEqual(expect.any(Number))
          expect(last - (value as number), `${name} after a call at ${at - T0}`).toBeLessThanOrEqual(MINUTE)
        }
      }
      // The first call of each agent is written at once, whoever wrote last.
      expect(open(file).list(t1 + 10_000).agents.map((x) => x.lastCallAt)).not.toContain(null)
    })

    it('writes what is not yet saved on flush, so two agents touched 10 s apart both survive a reopen', () => {
      const file = storeFile()
      const pairing = open(file)
      const a = pairing.verify(pair(pairing, 'Claude Code', T0))!
      const b = pairing.verify(pair(pairing, 'Codex', T0 + 10))!
      const t1 = T0 + 10_000
      pairing.touch(a.agentId, t1)
      pairing.touch(b.agentId, t1 + 10_000)
      pairing.touch(a.agentId, t1 + 20_000)
      pairing.touch(b.agentId, t1 + 30_000)
      expect(stored(file)).toEqual({ 'Claude Code': t1, Codex: t1 + 10_000 })

      const inode = statSync(file).ino
      pairing.flush()
      expect(statSync(file).ino).not.toBe(inode)
      expect(statSync(file).mode & 0o777).toBe(0o600)
      expect(readdirSync(path.dirname(file))).toEqual(['pairings.json'])
      expect(open(file).list(t1 + 30_000).agents.map((x) => [x.name, x.lastCallAt])).toEqual([
        ['Claude Code', t1 + 20_000],
        ['Codex', t1 + 30_000],
      ])
    })

    it('writes nothing on flush when nothing is waiting to be saved', () => {
      const empty = storeFile()
      open(empty).flush()
      expect(readdirSync(path.dirname(empty))).toEqual([])

      const file = storeFile()
      const pairing = open(file)
      const a = pairing.verify(pair(pairing, 'Claude Code', T0))!
      pairing.touch(a.agentId, T0 + 10_000)
      const inode = statSync(file).ino
      pairing.flush()
      expect(statSync(file).ino).toBe(inode)

      // A pending call saved by another write (here a pairing) leaves flush nothing to do.
      pairing.touch(a.agentId, T0 + 20_000)
      pair(pairing, 'Codex', T0 + 30_000)
      expect(stored(file)).toMatchObject({ 'Claude Code': T0 + 20_000 })
      const after = statSync(file).ino
      pairing.flush()
      expect(statSync(file).ino).toBe(after)
    })

    it('throws a store error when flush cannot write, and keeps the call for the next flush', () => {
      const file = storeFile()
      const pairing = open(file)
      const a = pairing.verify(pair(pairing, 'Claude Code', T0))!
      pairing.touch(a.agentId, T0 + 10_000)
      pairing.touch(a.agentId, T0 + 20_000)
      chmodSync(path.dirname(file), 0o500)
      expect(() => pairing.flush()).toThrow(expect.objectContaining({ name: 'PairingStoreError', reason: 'unwritable' }))
      chmodSync(path.dirname(file), 0o700)
      expect(stored(file)).toEqual({ 'Claude Code': T0 + 10_000 })
      pairing.flush()
      expect(stored(file)).toEqual({ 'Claude Code': T0 + 20_000 })
    })
  })

  // Fix round 3: a store that cannot be written must not be tried on every call of a busy agent.
  it('tries a failed last-call write again a minute later, not on the next call (fix round 3)', () => {
    const file = storeFile()
    const pairing = open(file)
    const agent = pairing.verify(pair(pairing, 'Claude Code', T0))!
    const t1 = T0 + 10_000
    expect(pairing.touch(agent.agentId, t1)).toBe(true)
    chmodSync(path.dirname(file), 0o500)
    try {
      expect(() => pairing.touch(agent.agentId, t1 + MINUTE)).toThrow(expect.objectContaining({ name: 'PairingStoreError', reason: 'unwritable' }))
      // The failure is thrown once; the calls of the next minute stay in memory and write nothing.
      expect(pairing.touch(agent.agentId, t1 + MINUTE + 1)).toBe(true)
      expect(pairing.touch(agent.agentId, t1 + 2 * MINUTE - 1)).toBe(true)
      expect(pairing.list(t1 + 2 * MINUTE - 1).agents[0]).toMatchObject({ lastCallAt: t1 + 2 * MINUTE - 1 })
      // A minute after the failed write, the next one is tried, and fails again while the store is shut.
      expect(() => pairing.touch(agent.agentId, t1 + 2 * MINUTE)).toThrow(PairingStoreError)
    } finally {
      chmodSync(path.dirname(file), 0o700)
    }
    expect(pairing.touch(agent.agentId, t1 + 3 * MINUTE - 1)).toBe(true)
    expect((JSON.parse(readFileSync(file, 'utf8')) as { agents: Array<{ lastCallAt: number }> }).agents[0]!.lastCallAt).toBe(t1)
    expect(pairing.touch(agent.agentId, t1 + 3 * MINUTE)).toBe(true)
    expect((JSON.parse(readFileSync(file, 'utf8')) as { agents: Array<{ lastCallAt: number }> }).agents[0]!.lastCallAt).toBe(t1 + 3 * MINUTE)
  })

  it('touches nothing for an agent it does not know', () => {
    const file = storeFile()
    const pairing = open(file)
    expect(pairing.touch('no-such-agent', T0)).toBe(false)
    expect(readdirSync(path.dirname(file))).toEqual([])
  })

  it('pairs the same name again after a revoke, with a new key', () => {
    const pairing = open()
    const old = pair(pairing, 'Claude Code', T0)
    pairing.revoke(pairing.verify(old)!.agentId, T0 + 5)
    const fresh = pair(pairing, 'Claude Code', T0 + 10)
    expect(fresh).not.toBe(old)
    expect(pairing.verify(fresh)).toMatchObject({ name: 'Claude Code' })
    expect(pairing.verify(old)).toBeNull()
  })

  it('writes by replacing the file whole, leaving no temporary file beside it', () => {
    const file = storeFile()
    const pairing = open(file)
    pair(pairing, 'Claude Code', T0)
    const before = statSync(file).ino
    pair(pairing, 'Codex', T0 + 10)
    expect(statSync(file).ino).not.toBe(before)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(readdirSync(path.dirname(file))).toEqual(['pairings.json'])
  })

  it('gives no key when the store cannot be written, and the claim can be tried again', () => {
    const file = storeFile()
    const pairing = open(file)
    const request = asked(pairing.request('Claude Code', T0))
    const { requestId } = request
    expect(confirmAt(pairing, request, T0 + 1)).toBe(true)
    chmodSync(path.dirname(file), 0o500)
    expect(() => pairing.claim(requestId, T0 + 2)).toThrow(PairingStoreError)
    expect(() => pairing.claim(requestId, T0 + 2)).toThrow(expect.objectContaining({ reason: 'unwritable', file }))
    chmodSync(path.dirname(file), 0o700)
    expect(pairing.list(T0 + 3).agents).toEqual([])
    expect(pairing.claim(requestId, T0 + 4)).toHaveProperty('key')
    expect(pairing.list(T0 + 5).agents).toHaveLength(1)
  })

  it('keeps the agent its access when a revoke cannot write the store: a store error (fix round 2)', () => {
    const file = storeFile()
    const notices: PairingNotice[] = []
    const pairing = open(file, notices)
    const key = pair(pairing, 'Claude Code', T0)
    const agent = pairing.verify(key)!
    const before = readFileSync(file, 'utf8')
    chmodSync(path.dirname(file), 0o500)
    expect(() => pairing.revoke(agent.agentId, T0 + 5)).toThrow(PairingStoreError)
    expect(() => pairing.revoke(agent.agentId, T0 + 5)).toThrow(expect.objectContaining({ reason: 'unwritable', file }))
    chmodSync(path.dirname(file), 0o700)
    expect(pairing.verify(key)).toEqual(agent)
    expect(pairing.list(T0 + 10).agents).toEqual([agent])
    expect(readFileSync(file, 'utf8')).toBe(before)
    expect(notices.filter((n) => n.kind === 'revoked')).toEqual([])
    // Once the store can be written again, the revoke goes through.
    expect(pairing.revoke(agent.agentId, T0 + 11)).toEqual(agent)
    expect(pairing.verify(key)).toBeNull()
  })

  it('does not open a file of foreign content: a store error, and the file is left as it was', () => {
    const foreign: Array<[string, string]> = [
      ['not json', 'not_json'],
      ['', 'not_json'],
      ['[]', 'not_a_store'],
      ['{}', 'not_a_store'],
      [JSON.stringify({ schema: 'something-else/1', agents: [] }), 'not_a_store'],
      [JSON.stringify({ schema: 'okolos-agent/pairings/1', agents: {} }), 'not_a_store'],
      [JSON.stringify({ schema: 'okolos-agent/pairings/1', agents: [{ agentId: 1, name: 'x', pairedAt: 0, keyHash: 'a'.repeat(64) }] }), 'bad_record'],
      [JSON.stringify({ schema: 'okolos-agent/pairings/1', agents: [{ agentId: 'a1', name: 'x', pairedAt: 0, keyHash: 'not a hash' }] }), 'bad_record'],
      [JSON.stringify({ schema: 'okolos-agent/pairings/1', agents: [null] }), 'bad_record'],
      // Fix round 3: one agent id twice would make a revoke ambiguous.
      [
        JSON.stringify({
          schema: 'okolos-agent/pairings/1',
          agents: [
            { agentId: '00000000000000a1', name: 'x', pairedAt: 0, lastCallAt: null, keyHash: 'a'.repeat(64) },
            { agentId: '00000000000000a1', name: 'y', pairedAt: 1, lastCallAt: null, keyHash: 'b'.repeat(64) },
          ],
        }),
        'bad_record',
      ],
    ]
    for (const [content, reason] of foreign) {
      const file = storeFile()
      writeFileSync(file, content, { mode: 0o600 })
      let thrown: unknown = null
      try {
        open(file)
      } catch (error) {
        thrown = error
      }
      expect(thrown, content).toBeInstanceOf(PairingStoreError)
      expect((thrown as PairingStoreError).file).toBe(file)
      expect((thrown as PairingStoreError).reason, content).toBe(reason)
      expect(readFileSync(file, 'utf8')).toBe(content)
    }
  })

  it('does not open a store it cannot read: a store error', () => {
    const file = storeFile()
    mkdirSync(file)
    expect(() => open(file)).toThrow(PairingStoreError)
    expect(() => open(file)).toThrow(expect.objectContaining({ reason: 'unreadable' }))
  })

  it('ends every open request at a restart: pending and confirmed ones leave no row and are unknown, agents stay (fix round 1)', () => {
    const file = storeFile()
    const before = open(file)
    pair(before, 'Claude Code', T0)
    const pending = asked(before.request('Codex', T0 + 10))
    const confirmed = asked(before.request('Cursor', T0 + 11))
    expect(confirmAt(before, confirmed, T0 + 12)).toBe(true)

    const after = open(file)
    const page = after.list(T0 + 13)
    expect(page.requests).toEqual([])
    expect(page.agents.map((a) => a.name)).toEqual(['Claude Code'])
    expect(after.claim(pending.requestId, T0 + 14)).toEqual({ refused: 'unknown' })
    expect(after.claim(confirmed.requestId, T0 + 14)).toEqual({ refused: 'unknown' })
  })

  it('opens a missing file as an empty store and writes nothing until a pairing', () => {
    const file = storeFile()
    const pairing = open(file)
    expect(pairing.list(T0).agents).toEqual([])
    asked(pairing.request('Claude Code', T0))
    expect(readdirSync(path.dirname(file))).toEqual([])
  })
})

describe('a notice handler that throws (fix round 1)', () => {
  function failing(): { pairing: Pairing; reported: Array<[unknown, PairingNotice]> } {
    const reported: Array<[unknown, PairingNotice]> = []
    const pairing = Pairing.open(storeFile(), {
      random: seeded(),
      onNotice: () => {
        throw new Error('journal is full')
      },
      onNoticeError: (error, notice) => reported.push([error, notice]),
    })
    return { pairing, reported }
  }

  it('still gives the CLI its request id, and reports the failed notice', () => {
    const { pairing, reported } = failing()
    const result = pairing.request('Claude Code', T0)
    expect(result).toEqual({ requestId: expect.stringMatching(/^[0-9a-f]{32}$/), code: expect.any(String), expiresAt: T0 + REQUEST_LIFETIME_MS })
    expect(pairing.list(T0 + 1).requests).toHaveLength(1)
    expect(reported.map(([error, notice]) => [(error as Error).message, notice.kind])).toEqual([['journal is full', 'requested']])
  })

  it('still gives the agent its key once the hash is stored, and reports the failed notice', () => {
    const { pairing, reported } = failing()
    const request = asked(pairing.request('Claude Code', T0))
    expect(confirmAt(pairing, request, T0 + 1)).toBe(true)
    const claimed = pairing.claim(request.requestId, T0 + 2)
    expect(claimed).toEqual({ key: expect.stringMatching(/^[0-9a-f]{64}$/) })
    expect(pairing.verify((claimed as { key: string }).key)).toMatchObject({ name: 'Claude Code' })
    expect(reported.map(([, notice]) => notice.kind)).toEqual(['requested', 'confirmed', 'paired'])
  })

  // Fix round 2: the branches no test reached.
  it('goes to process.emitWarning when no onNoticeError is given, and the change stands', () => {
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => {})
    try {
      const pairing = Pairing.open(storeFile(), {
        random: seeded(),
        onNotice: (notice) => {
          if (notice.kind === 'requested') throw new Error('journal is full')
          throw 'not an error' // a handler may throw anything, not only an Error
        },
      })
      const request = asked(pairing.request('Claude Code', T0))
      expect(pairing.list(T0 + 1).requests).toHaveLength(1)
      expect(confirmAt(pairing, request, T0 + 2)).toBe(true)
      expect(warn.mock.calls).toEqual([
        [expect.objectContaining({ message: 'journal is full' }), { code: 'OKOLOS_PAIRING_NOTICE', detail: 'requested' }],
        ['not an error', { code: 'OKOLOS_PAIRING_NOTICE', detail: 'confirmed' }],
      ])
      expect(pairing.claim(request.requestId, T0 + 3)).toHaveProperty('key')
    } finally {
      warn.mockRestore()
    }
  })

  it('loses neither the request nor the stored key when onNoticeError throws too', () => {
    const file = storeFile()
    const pairing = Pairing.open(file, {
      random: seeded(),
      onNotice: () => {
        throw new Error('journal is full')
      },
      onNoticeError: () => {
        throw new Error('the reporter is down too')
      },
    })
    const result = pairing.request('Claude Code', T0)
    expect(result).toEqual({ requestId: expect.stringMatching(/^[0-9a-f]{32}$/), code: expect.any(String), expiresAt: T0 + REQUEST_LIFETIME_MS })
    const request = asked(result)
    expect(pairing.list(T0 + 1).requests).toMatchObject([{ name: 'Claude Code', state: 'pending' }])
    expect(confirmAt(pairing, request, T0 + 2)).toBe(true)
    const claimed = pairing.claim(request.requestId, T0 + 3)
    expect(claimed).toEqual({ key: expect.stringMatching(/^[0-9a-f]{64}$/) })
    const key = (claimed as { key: string }).key
    expect(pairing.verify(key)).toMatchObject({ name: 'Claude Code' })
    expect(open(file).verify(key)).toMatchObject({ name: 'Claude Code' })
  })
})

// Fix round 3: every notice says when it happened, so the journal and the events need no clock of
// their own: an end at its deadline, everything else at the call that caused it.
describe('when a notice happened (fix round 3)', () => {
  it('carries the time of the call that caused it', () => {
    const notices: PairingNotice[] = []
    const pairing = open(storeFile(), notices)
    const paired = asked(pairing.request('Claude Code', T0))
    const declined = asked(pairing.request('Codex', T0 + 1))
    expect(confirmAt(pairing, paired, T0 + 2)).toBe(true)
    expect(declineAt(pairing, declined, T0 + 3)).toBe(true)
    const claimed = pairing.claim(paired.requestId, T0 + 4)
    const agent = pairing.verify((claimed as { key: string }).key)!
    pairing.revoke(agent.agentId, T0 + 5)
    expect(notices.map((n) => [n.kind, n.at])).toEqual([
      ['requested', T0],
      ['requested', T0 + 1],
      ['confirmed', T0 + 2],
      ['declined', T0 + 3],
      ['paired', T0 + 4],
      ['revoked', T0 + 5],
    ])
  })

  it('dates an end by its deadline, not by the call that found it', () => {
    const notices: PairingNotice[] = []
    const pairing = open(storeFile(), notices)
    asked(pairing.request('Never confirmed', T0))
    const late = asked(pairing.request('Confirmed late', T0 + 1))
    const confirmedAt = T0 + 2 * MINUTE
    expect(confirmAt(pairing, late, confirmedAt)).toBe(true)
    // Nothing looks until long after both ends.
    pairing.list(T0 + 20 * MINUTE)
    expect(notices.filter((n) => n.kind === 'expired' || n.kind === 'claim_expired')).toEqual([
      { kind: 'expired', handle: expect.any(String), name: 'Never confirmed', at: T0 + REQUEST_LIFETIME_MS, cause: 'timeout' },
      { kind: 'claim_expired', handle: expect.any(String), name: 'Confirmed late', at: confirmedAt + CLAIM_WINDOW_MS, cause: 'timeout' },
    ])
  })
})

describe('confirming twice (fix round 2)', () => {
  it('answers true again and keeps the first confirm time, with one notice', () => {
    const notices: PairingNotice[] = []
    const pairing = open(storeFile(), notices)
    const request = asked(pairing.request('Claude Code', T0))
    const handle = handleOf(pairing, request, T0)
    expect(pairing.confirmByHandle(handle, T0 + MINUTE)).toBe(true)
    expect(pairing.confirmByHandle(handle, T0 + 2 * MINUTE)).toBe(true)
    expect(pairing.list(T0 + 2 * MINUTE).requests[0]).toMatchObject({
      state: 'confirmed',
      confirmedAt: T0 + MINUTE,
      expiresAt: T0 + MINUTE + CLAIM_WINDOW_MS,
    })
    expect(notices.filter((n) => n.kind === 'confirmed')).toHaveLength(1)
    // The claim window still runs from the first confirm.
    expect(pairing.claim(request.requestId, T0 + MINUTE + CLAIM_WINDOW_MS)).toEqual({ refused: 'claim_expired' })
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

  it('are marked when the names differ only in case or punctuation', () => {
    const pairing = open()
    asked(pairing.request('Claude Code', T0))
    asked(pairing.request('claude-code.', T0 + 1))
    expect(Object.values(flags(pairing, T0 + 2))).toEqual([true, true])
  })

  it('stay marked when one is already confirmed, and the mark goes when the other leaves', () => {
    const pairing = open()
    const first = asked(pairing.request('Claude Code', T0))
    const second = asked(pairing.request('Claude Code', T0 + 1))
    expect(confirmAt(pairing, first, T0 + 2)).toBe(true)
    expect(Object.values(flags(pairing, T0 + 3))).toEqual([true, true])
    expect(declineAt(pairing, second, T0 + 3)).toBe(true)
    expect(Object.values(flags(pairing, T0 + 4))).toEqual([false])
  })

  // Fix round 1: names are compared by what they look like, not by their code points. Fix round 4:
  // one Cyrillic letter among Latin ones is refused outright; a name all in Cyrillic letters that
  // reads as a Latin one is marked.
  it('are marked when an all-Cyrillic name reads as a Latin one', () => {
    const pairing = open()
    expect(pairing.request('\u0421odex', T0)).toEqual({ refused: 'name_script' }) // Cyrillic capital Es
    asked(pairing.request('Cocoa', T0))
    asked(pairing.request('\u0421\u043e\u0441\u043e\u0430', T0 + 1)) // all Cyrillic
    asked(pairing.request('Claude', T0 + 2))
    const rows = pairing.list(T0 + 3).requests
    expect(rows.map((row) => [row.name, row.duplicateName])).toEqual([
      ['Cocoa', true],
      ['\u0421\u043e\u0441\u043e\u0430', true],
      ['Claude', false],
    ])
  })

  it('are marked when the names differ only by trailing or repeated spaces', () => {
    const pairing = open()
    asked(pairing.request('Claude  Code', T0))
    asked(pairing.request('Claude Code ', T0 + 1))
    expect(Object.values(flags(pairing, T0 + 2))).toEqual([true, true])
  })

  // Fix round 2: duplicateName is about other waiting requests only; a look-alike of an agent with
  // access is told by sameNameAgents alone.
  it('names the agent with access a lone request looks like, without marking it a duplicate', () => {
    const pairing = open()
    const key = pair(pairing, 'Claude Code', T0)
    const agent = pairing.verify(key)!
    asked(pairing.request('claude_code ', T0 + 10)) // underscore, trailing space
    asked(pairing.request('Codex', T0 + 11))
    const rows = pairing.list(T0 + 12).requests
    expect(rows[0]).toMatchObject({ duplicateName: false, sameNameAgents: [{ agentId: agent.agentId, name: 'Claude Code' }] })
    expect(rows[1]).toMatchObject({ duplicateName: false, sameNameAgents: [] })
  })

  // Fix round 3: a capital I for the small l is a look-alike too.
  it('names the agent with access a request mimics with a capital I for an l (fix round 3)', () => {
    const pairing = open()
    const agent = pairing.verify(pair(pairing, 'Claude Code', T0))!
    asked(pairing.request('CIaude Code', T0 + 10))
    expect(pairing.list(T0 + 11).requests[0]).toMatchObject({ name: 'CIaude Code', sameNameAgents: [{ agentId: agent.agentId, name: 'Claude Code' }] })
  })

  // Fix round 4: the look-alikes the comparison key must catch, and one it must not.
  it('names the agent with access for every spelling of its name, and not for another name (fix round 4)', () => {
    for (const name of ['Claude-Code', 'Claude_Code', 'Claude Code.', 'claude code', 'CIaude Code']) {
      const pairing = open()
      const agent = pairing.verify(pair(pairing, 'Claude Code', T0))!
      asked(pairing.request(name, T0 + 10))
      expect(pairing.list(T0 + 11).requests[0], name).toMatchObject({ name, sameNameAgents: [{ agentId: agent.agentId, name: 'Claude Code' }] })
    }
    const pairing = open()
    pair(pairing, 'Claude Code', T0)
    asked(pairing.request('Codex', T0 + 10))
    expect(pairing.list(T0 + 11).requests[0]).toMatchObject({ name: 'Codex', sameNameAgents: [] })
  })

  it('marks two waiting look-alikes of an agent with access as duplicates, and names the agent on both', () => {
    const pairing = open()
    const agent = pairing.verify(pair(pairing, 'Claude Code', T0))!
    asked(pairing.request('Claude Code', T0 + 10))
    asked(pairing.request('CIaude Code', T0 + 11)) // capital i for the l
    const rows = pairing.list(T0 + 12).requests
    expect(rows.map((row) => [row.duplicateName, row.sameNameAgents])).toEqual([
      [true, [{ agentId: agent.agentId, name: 'Claude Code' }]],
      [true, [{ agentId: agent.agentId, name: 'Claude Code' }]],
    ])
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
  // Fix round 2: the request id is the agent's own secret, so no public method confirms or declines
  // by it; a route that mapped it to a confirm would let an agent pair itself.
  it('has no way to confirm or decline by request id', () => {
    const pairing = open() as unknown as Record<string, unknown>
    expect(pairing['confirm']).toBeUndefined()
    expect(pairing['decline']).toBeUndefined()
  })

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
    expect(pairing.declineByHandle(row!.handle, T0 + 1)).toBe(true)
    expect(pairing.claim(requestId, T0 + 2)).toEqual({ refused: 'declined' })
    expect(pairing.list(T0 + 3).requests).toEqual([])
  })

  it('refuses a request id offered as a handle, and a handle offered as a request id', () => {
    const pairing = open()
    const { requestId } = asked(pairing.request('Claude Code', T0))
    const [row] = pairing.list(T0 + 1).requests
    expect(row!.handle).not.toBe(requestId)
    expect(pairing.confirmByHandle(requestId, T0 + 2)).toBe(false)
    expect(pairing.declineByHandle(requestId, T0 + 2)).toBe(false)
    expect(pairing.claim(row!.handle, T0 + 2)).toEqual({ refused: 'unknown' })
    expect(pairing.claim(requestId, T0 + 3)).toEqual({ pending: true })
    expect(pairing.list(T0 + 3).requests[0]).toMatchObject({ state: 'pending' })
  })

  it('does not decline a request whose five minutes are over: it stays an expired row (fix round 1)', () => {
    const notices: PairingNotice[] = []
    const pairing = open(storeFile(), notices)
    const claude = asked(pairing.request('Claude Code', T0))
    asked(pairing.request('Codex', T0 + 1))
    const rows = pairing.list(T0 + 2).requests
    const codex = rows.find((row) => row.name === 'Codex')!
    // At its deadline the row is already expired; its handle, looked up then, declines nothing.
    expect(declineAt(pairing, claude, T0 + REQUEST_LIFETIME_MS)).toBe(false)
    expect(pairing.declineByHandle(codex.handle, T0 + 1 + REQUEST_LIFETIME_MS)).toBe(false)
    expect(pairing.list(T0 + 2 + REQUEST_LIFETIME_MS).requests.map((row) => [row.name, row.state])).toEqual([
      ['Claude Code', 'expired'],
      ['Codex', 'expired'],
    ])
    expect(notices.filter((n) => n.kind === 'declined')).toEqual([])
  })

  it('does not confirm a request whose five minutes are over', () => {
    const pairing = open()
    const { requestId } = asked(pairing.request('Claude Code', T0))
    const [row] = pairing.list(T0 + 1).requests
    expect(pairing.confirmByHandle(row!.handle, T0 + REQUEST_LIFETIME_MS)).toBe(false)
    expect(pairing.claim(requestId, T0 + REQUEST_LIFETIME_MS)).toEqual({ refused: 'expired' })
  })
})

// Fix round 4: the daemon closes the pairing before it stops, so nothing is left half done.
describe('closing the pairing (fix round 4)', () => {
  it('ends every open request with a notice dated by the close, and flushes the last calls', () => {
    const file = storeFile()
    const notices: PairingNotice[] = []
    const pairing = open(file, notices)
    const agent = pairing.verify(pair(pairing, 'Claude Code', T0))!
    expect(pairing.touch(agent.agentId, T0 + 10)).toBe(true)
    expect(pairing.touch(agent.agentId, T0 + 20)).toBe(true) // in memory only: within the minute
    asked(pairing.request('Codex', T0 + 30))
    const confirmed = asked(pairing.request('Cursor', T0 + 31))
    expect(confirmAt(pairing, confirmed, T0 + 32)).toBe(true)
    notices.length = 0

    const at = T0 + 40
    pairing.close(at)
    expect(notices.map((n) => [n.kind, 'name' in n ? n.name : '', n.at, 'cause' in n ? n.cause : ''])).toEqual([
      ['expired', 'Codex', at, 'stopped'],
      ['claim_expired', 'Cursor', at, 'stopped'],
    ])
    expect(pairing.list(at + 1).requests.map((row) => [row.name, row.state, row.expiresAt])).toEqual([
      ['Codex', 'expired', at],
      ['Cursor', 'claim_expired', at],
    ])
    expect(open(file).list(at).agents[0]).toMatchObject({ agentId: agent.agentId, lastCallAt: T0 + 20 })
  })

  it('refuses requests, claims, confirms and declines after the close; list still answers', () => {
    const pairing = open()
    pair(pairing, 'Claude Code', T0)
    const pending = asked(pairing.request('Codex', T0 + 10))
    const confirmed = asked(pairing.request('Cursor', T0 + 11))
    expect(confirmAt(pairing, confirmed, T0 + 12)).toBe(true)
    const handles = pairing.list(T0 + 13).requests.map((row) => row.handle)

    pairing.close(T0 + 20)
    expect(pairing.request('Aider', T0 + 21)).toEqual({ refused: 'closed' })
    // Fix round 5: a claim for a request the close ended is told so.
    expect(pairing.claim(pending.requestId, T0 + 21)).toEqual({ refused: 'stopped' })
    expect(pairing.claim(confirmed.requestId, T0 + 21)).toEqual({ refused: 'stopped' })
    for (const handle of handles) {
      expect(pairing.confirmByHandle(handle, T0 + 21)).toBe(false)
      expect(pairing.declineByHandle(handle, T0 + 21)).toBe(false)
    }
    const page = pairing.list(T0 + 22)
    expect(page.agents.map((a) => a.name)).toEqual(['Claude Code'])
    expect(page.requests.map((row) => row.state)).toEqual(['expired', 'claim_expired'])
  })

  it('keeps the reason of a request that ended before the close, and dates a late end by its deadline (fix round 5)', () => {
    const notices: PairingNotice[] = []
    const pairing = open(storeFile(), notices)
    const declined = asked(pairing.request('Codex', T0))
    const late = asked(pairing.request('Cursor', T0 + 1))
    expect(declineAt(pairing, declined, T0 + 4 * MINUTE)).toBe(true)
    // The close comes after Cursor's deadline: it ends by timeout, not by the close.
    pairing.close(T0 + 1 + REQUEST_LIFETIME_MS + 10)
    expect(notices.find((n) => n.kind === 'expired')).toMatchObject({ name: 'Cursor', at: T0 + 1 + REQUEST_LIFETIME_MS, cause: 'timeout' })
    expect(pairing.claim(declined.requestId, T0 + REQUEST_LIFETIME_MS + 20)).toEqual({ refused: 'declined' })
    expect(pairing.claim(late.requestId, T0 + REQUEST_LIFETIME_MS + 20)).toEqual({ refused: 'expired' })
    expect(pairing.claim('0'.repeat(32), T0 + REQUEST_LIFETIME_MS + 20)).toEqual({ refused: 'unknown' })
  })

  it('says nothing more when closed twice', () => {
    const notices: PairingNotice[] = []
    const pairing = open(storeFile(), notices)
    asked(pairing.request('Codex', T0))
    pairing.close(T0 + 1)
    const count = notices.length
    pairing.close(T0 + 2)
    expect(notices).toHaveLength(count)
  })

  it('ends the requests even when the flush cannot write, and throws the store error', () => {
    const file = storeFile()
    const notices: PairingNotice[] = []
    const pairing = open(file, notices)
    const agent = pairing.verify(pair(pairing, 'Claude Code', T0))!
    pairing.touch(agent.agentId, T0 + 10)
    pairing.touch(agent.agentId, T0 + 20)
    asked(pairing.request('Codex', T0 + 30))
    chmodSync(path.dirname(file), 0o500)
    expect(() => pairing.close(T0 + 40)).toThrow(expect.objectContaining({ name: 'PairingStoreError', reason: 'unwritable' }))
    chmodSync(path.dirname(file), 0o700)
    expect(notices.at(-1)).toMatchObject({ kind: 'expired', name: 'Codex', at: T0 + 40 })
    expect(pairing.request('Aider', T0 + 41)).toEqual({ refused: 'closed' })
  })
})

// Fix round 4: the pairing remembers the bytes it last read or wrote. Fix round 5: a store someone
// else changed in between (another daemon, a hand edit, a restore) is read again with the checks of
// the open; a valid one is taken as it is and the operation runs against it, an invalid one is
// refused with that check's reason and nothing is written. verify sees the change too.
describe('a store changed on disk (fix rounds 4 and 5)', () => {
  function watched(file: string): { pairing: Pairing; reloads: () => number } {
    let count = 0
    const pairing = Pairing.open(file, { random: seeded(), onReload: () => count++ })
    return { pairing, reloads: () => count }
  }

  function names(file: string): string[] {
    return (JSON.parse(readFileSync(file, 'utf8')) as { agents: Array<{ name: string }> }).agents.map((a) => a.name)
  }

  it('takes a valid edit made on disk, then gives the key and writes both', () => {
    const file = storeFile()
    const { pairing, reloads } = watched(file)
    const claude = pair(pairing, 'Claude Code', T0)
    const request = asked(pairing.request('Codex', T0 + 10))
    expect(confirmAt(pairing, request, T0 + 11)).toBe(true)
    writeFileSync(file, readFileSync(file, 'utf8').replace('"Claude Code"', '"Claude"'), { mode: 0o600 })

    expect(pairing.claim(request.requestId, T0 + 12)).toHaveProperty('key')
    expect(reloads()).toBe(1)
    expect(names(file)).toEqual(['Claude', 'Codex'])
    expect(pairing.list(T0 + 13).agents.map((a) => a.name)).toEqual(['Claude', 'Codex'])
    expect(pairing.verify(claude)).toMatchObject({ name: 'Claude' })
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('sees a revoke another pairing wrote at the next verify', () => {
    const file = storeFile()
    const { pairing: a, reloads } = watched(file)
    const gone = pair(a, 'Claude Code', T0)
    const kept = pair(a, 'Codex', T0 + 10)
    const b = open(file)
    expect(b.revoke(b.verify(gone)!.agentId, T0 + 20)).toMatchObject({ name: 'Claude Code' })

    expect(a.verify(gone)).toBeNull()
    expect(reloads()).toBe(1)
    expect(a.verify(kept)).toMatchObject({ name: 'Codex' })
    expect(a.list(T0 + 30).agents.map((x) => x.name)).toEqual(['Codex'])
    expect(reloads()).toBe(1)
  })

  it('sees a revoke another pairing wrote at the next list, and throws over an invalid file as verify does', () => {
    const file = storeFile()
    const { pairing: a, reloads } = watched(file)
    const gone = pair(a, 'Claude Code', T0)
    pair(a, 'Codex', T0 + 10)
    const b = open(file)
    b.revoke(b.verify(gone)!.agentId, T0 + 20)

    expect(a.list(T0 + 30).agents.map((x) => x.name)).toEqual(['Codex'])
    expect(reloads()).toBe(1)
    writeFileSync(file, 'not json', { mode: 0o600 })
    expect(() => a.list(T0 + 40)).toThrow(expect.objectContaining({ name: 'PairingStoreError', reason: 'not_json', file }))
    expect(readFileSync(file, 'utf8')).toBe('not json')
  })

  it('reads nothing again while the file is as it was last read or written', () => {
    const file = storeFile()
    const { pairing, reloads } = watched(file)
    const key = pair(pairing, 'Claude Code', T0)
    for (let n = 0; n < 5; n++) expect(pairing.verify(key)).toMatchObject({ name: 'Claude Code' })
    pair(pairing, 'Codex', T0 + 10)
    expect(pairing.verify(key)).toMatchObject({ name: 'Claude Code' })
    expect(reloads()).toBe(0)
  })

  it('refuses an invalid edit with the reason the open gives it, writes nothing, and recovers once it is fixed', () => {
    const file = storeFile()
    const { pairing, reloads } = watched(file)
    const key = pair(pairing, 'Claude Code', T0)
    const valid = readFileSync(file, 'utf8')
    const request = asked(pairing.request('Codex', T0 + 10))
    expect(confirmAt(pairing, request, T0 + 11)).toBe(true)
    const invalid: Array<[string, string]> = [
      ['not json', 'not_json'],
      [JSON.stringify({ schema: 'something-else/1', agents: [] }), 'not_a_store'],
      [valid.replace('"Claude Code"', '"agent\\u202ex"'), 'bad_record'],
    ]
    for (const [content, reason] of invalid) {
      writeFileSync(file, content, { mode: 0o600 })
      const refused = expect.objectContaining({ name: 'PairingStoreError', reason, file })
      expect(() => pairing.claim(request.requestId, T0 + 12), reason).toThrow(refused)
      expect(() => pairing.verify(key), reason).toThrow(refused)
      expect(() => pairing.list(T0 + 13), reason).toThrow(refused)
      expect(readFileSync(file, 'utf8')).toBe(content)
    }
    expect(reloads()).toBe(0)

    writeFileSync(file, valid, { mode: 0o600 })
    // Memory stayed as it was: the agent, and the request still confirmed.
    expect(pairing.list(T0 + 13).agents.map((a) => a.name)).toEqual(['Claude Code'])
    expect(pairing.list(T0 + 13).requests[0]).toMatchObject({ name: 'Codex', state: 'confirmed' })
    expect(pairing.verify(key)).toMatchObject({ name: 'Claude Code' })
    expect(pairing.claim(request.requestId, T0 + 14)).toHaveProperty('key')
    expect(names(file)).toEqual(['Claude Code', 'Codex'])
  })

  it('takes an edit that keeps the size of the file: the bytes are compared, not only the size', () => {
    const file = storeFile()
    const { pairing, reloads } = watched(file)
    const key = pair(pairing, 'Claude Code', T0)
    const before = readFileSync(file, 'utf8')
    const edited = before.replace('"Claude Code"', '"Claude Coda"')
    expect(edited.length).toBe(before.length)
    writeFileSync(file, edited, { mode: 0o600 })
    const agent = pairing.verify(key)!
    expect(agent).toMatchObject({ name: 'Claude Coda' })
    expect(reloads()).toBe(1)
    expect(pairing.revoke(agent.agentId, T0 + 10)).toMatchObject({ name: 'Claude Coda' })
    expect(names(file)).toEqual([])
  })

  it('runs a revoke, a last-call write and a flush against the file as it is now', () => {
    const file = storeFile()
    const { pairing, reloads } = watched(file)
    const a = pairing.verify(pair(pairing, 'Claude Code', T0))!
    const b = pairing.verify(pair(pairing, 'Codex', T0 + 10))!
    writeFileSync(file, `${readFileSync(file, 'utf8')} `, { mode: 0o600 })
    expect(pairing.touch(a.agentId, T0 + 20)).toBe(true)
    expect(reloads()).toBe(1)
    writeFileSync(file, readFileSync(file, 'utf8').replace('"Codex"', '"Codex CLI"'), { mode: 0o600 })
    expect(pairing.revoke(a.agentId, T0 + 30)).toMatchObject({ name: 'Claude Code' })
    expect(names(file)).toEqual(['Codex CLI'])
    expect(pairing.touch(b.agentId, T0 + 40)).toBe(true)
    expect(pairing.touch(b.agentId, T0 + 50)).toBe(true) // in memory: within the minute
    writeFileSync(file, `${readFileSync(file, 'utf8')} `, { mode: 0o600 })
    pairing.flush()
    expect(open(file).list(T0 + 60).agents).toEqual([{ agentId: b.agentId, name: 'Codex CLI', pairedAt: T0 + 12, lastCallAt: T0 + 50 }])
  })

  it('keeps a last call held in memory only across a reload, for an agent still in the store', () => {
    const file = storeFile()
    const pairing = open(file)
    const a = pairing.verify(pair(pairing, 'Claude Code', T0))!
    expect(pairing.touch(a.agentId, T0 + 10_000)).toBe(true) // written
    expect(pairing.touch(a.agentId, T0 + 20_000)).toBe(true) // memory only
    writeFileSync(file, `${readFileSync(file, 'utf8')} `, { mode: 0o600 })
    expect(pairing.verify('f'.repeat(64))).toBeNull() // the reload
    expect(pairing.list(T0 + 30_000).agents[0]).toMatchObject({ lastCallAt: T0 + 20_000 })
    pairing.flush()
    expect(open(file).list(T0 + 30_000).agents[0]).toMatchObject({ lastCallAt: T0 + 20_000 })
  })

  it('answers false to a last call due for writing when the agent was revoked on disk, and writes nothing', () => {
    const file = storeFile()
    const a = open(file)
    const agent = a.verify(pair(a, 'Claude Code', T0))!
    const b = open(file)
    b.revoke(agent.agentId, T0 + 5)
    const after = readFileSync(file, 'utf8')
    expect(a.touch(agent.agentId, T0 + 10)).toBe(false)
    expect(readFileSync(file, 'utf8')).toBe(after)
    expect(a.list(T0 + 11).agents).toEqual([])
  })

  it('takes a file removed since it was last read as an empty store, and one created as what it holds', () => {
    const removed = storeFile()
    const first = open(removed)
    const old = pair(first, 'Claude Code', T0)
    rmSync(removed)
    expect(first.verify(old)).toBeNull()
    pair(first, 'Codex', T0 + 10)
    expect(names(removed)).toEqual(['Codex'])

    const created = storeFile()
    const second = open(created) // missing: an empty store
    const other = open(storeFile())
    const key = pair(other, 'Cursor', T0)
    writeFileSync(created, readFileSync(other.file, 'utf8'), { mode: 0o600 })
    pair(second, 'Codex', T0 + 10)
    expect(names(created)).toEqual(['Cursor', 'Codex'])
    expect(second.verify(key)).toMatchObject({ name: 'Cursor' })
  })

  it('lets two pairings on the same file both write, neither losing the other one\'s agents', () => {
    const file = storeFile()
    const a = open(file)
    const b = open(file)
    pair(a, 'Claude Code', T0)
    pair(b, 'Codex', T0 + 10)
    pair(a, 'Cursor', T0 + 30)
    expect(open(file).list(T0 + 40).agents.map((agent) => agent.name)).toEqual(['Claude Code', 'Codex', 'Cursor'])
  })

  it('goes on when onReload throws: the reload stands', () => {
    const file = storeFile()
    const pairing = Pairing.open(file, {
      random: seeded(),
      onReload: () => {
        throw new Error('log is down')
      },
    })
    const key = pair(pairing, 'Claude Code', T0)
    writeFileSync(file, readFileSync(file, 'utf8').replace('"Claude Code"', '"Claude"'), { mode: 0o600 })
    expect(pairing.verify(key)).toMatchObject({ name: 'Claude' })
  })
})

// Fix round 4: a store is checked for what it holds, not only for its shape.
describe('what a store may hold (fix round 4)', () => {
  function agentRow(agentId: string, name: string, keyHash: string): Record<string, unknown> {
    return { agentId, name, pairedAt: T0, lastCallAt: null, keyHash }
  }

  function refusal(content: string): string | null {
    const file = storeFile()
    writeFileSync(file, content, { mode: 0o600 })
    try {
      open(file)
      return null
    } catch (error) {
      expect(error).toBeInstanceOf(PairingStoreError)
      expect(readFileSync(file, 'utf8')).toBe(content)
      return (error as PairingStoreError).reason
    } finally {
      expect(readFileSync(file, 'utf8')).toBe(content)
    }
  }

  const store = (agents: unknown[]): string => JSON.stringify({ schema: 'okolos-agent/pairings/1', agents })
  const ID1 = '00000000000000a1'
  const ID2 = '00000000000000a2'
  const sha = (key: string): string => createHash('sha256').update(key, 'utf8').digest('hex')

  it('refuses one key hash under two agents as a bad record, the file left as it was', () => {
    expect(refusal(store([agentRow(ID1, 'Claude Code', 'a'.repeat(64)), agentRow(ID2, 'Codex', 'a'.repeat(64))]))).toBe('bad_record')
    expect(refusal(store([agentRow(ID1, 'Claude Code', 'a'.repeat(64)), agentRow(ID2, 'Codex', 'b'.repeat(64))]))).toBeNull()
  })

  // Fix round 5: a stored name is checked by the store rule, which is looser than the request rule
  // and stays so: an agent paired under rules that later tighten keeps its access.
  it('refuses a stored name only for what no rule ever let in, the file left as it was', () => {
    for (const name of ['', 'a'.repeat(41), 'agent\u202ex', 'agent\u0007', 'a\u200bgent', 'agent\u2028x', 'Cafe\u0301', 7]) {
      expect(refusal(store([agentRow(ID1, name as string, 'a'.repeat(64))])), JSON.stringify(name)).toBe('bad_record')
    }
  })

  it('opens and verifies a stored name the allowlist of new requests refuses (fix round 5)', () => {
    for (const name of ['Caf\u00e9', 'Oko\u0399os', 'agent 123', 'Okolos', '\u0419\u0432\u0430\u043d', 'a'.repeat(40)]) {
      const file = storeFile()
      writeFileSync(file, store([agentRow(ID1, name, sha('the key'))]), { mode: 0o600 })
      expect(open(file).verify('the key'), JSON.stringify(name)).toEqual({ agentId: ID1, name, pairedAt: T0, lastCallAt: null })
    }
  })

  it('refuses an agent id that is not 16 lowercase hex, a key hash that is not 64, and a bad time (fix round 5)', () => {
    const good = agentRow(ID1, 'Claude Code', 'a'.repeat(64))
    expect(refusal(store([good]))).toBeNull()
    for (const bad of [
      { ...good, agentId: 'a1' },
      { ...good, agentId: '00000000000000A1' },
      { ...good, agentId: '0'.repeat(17) },
      { ...good, agentId: '0'.repeat(15) + 'g' },
      { ...good, keyHash: 'A'.repeat(64) },
      { ...good, keyHash: 'a'.repeat(63) },
      { ...good, pairedAt: -1 },
      { ...good, pairedAt: 1.5 },
      { ...good, pairedAt: '0' },
      { ...good, pairedAt: 2 ** 53 },
      { ...good, lastCallAt: -1 },
      { ...good, lastCallAt: 0.5 },
    ]) {
      expect(refusal(store([bad])), JSON.stringify(bad)).toBe('bad_record')
    }
  })

  it('refuses a record with a field it does not know, or without one it needs (fix round 5)', () => {
    const good = agentRow(ID1, 'Claude Code', 'a'.repeat(64))
    expect(refusal(store([{ ...good, note: 'hi' }]))).toBe('bad_record')
    expect(refusal(store([{ ...good, key: 'the key' }]))).toBe('bad_record')
    const withoutLastCall = { ...good }
    delete withoutLastCall['lastCallAt']
    expect(refusal(store([withoutLastCall]))).toBe('bad_record')
    // A field the store itself does not know is refused too: a write would drop it.
    expect(refusal(JSON.stringify({ schema: 'okolos-agent/pairings/1', agents: [good], extra: 1 }))).toBe('not_a_store')
  })

  it('writes the five fields of a record and nothing else', () => {
    const file = storeFile()
    pair(open(file), 'Claude Code', T0)
    const written = JSON.parse(readFileSync(file, 'utf8')) as { agents: Array<Record<string, unknown>> }
    expect(Object.keys(written).sort()).toEqual(['agents', 'schema'])
    expect(Object.keys(written.agents[0]!).sort()).toEqual(['agentId', 'keyHash', 'lastCallAt', 'name', 'pairedAt'])
  })

  it('writes nothing whose text would pass 1 MiB: a too_large store error, memory and file kept (fix round 5)', () => {
    // A compact file just under the limit opens; the written form, indented, would be larger.
    const rows: Record<string, unknown>[] = []
    let size = Buffer.byteLength(store([]))
    for (let n = 0; ; n++) {
      const row = agentRow(n.toString(16).padStart(16, '0'), 'A', n.toString(16).padStart(64, '0'))
      const grown = size + Buffer.byteLength(JSON.stringify(row)) + (rows.length > 0 ? 1 : 0)
      if (grown > MAX_STORE_BYTES) break
      rows.push(row)
      size = grown
    }
    const text = store(rows)
    expect(Buffer.byteLength(text)).toBe(size)
    const file = storeFile()
    writeFileSync(file, text, { mode: 0o600 })
    const pairing = open(file)
    const first = rows[0]!['agentId'] as string
    expect(() => pairing.revoke(first, T0)).toThrow(expect.objectContaining({ name: 'PairingStoreError', reason: 'too_large', file }))
    expect(readFileSync(file, 'utf8')).toBe(text)
    expect(pairing.list(T0).agents).toHaveLength(rows.length)
    const request = asked(pairing.request('Codex', T0))
    expect(confirmAt(pairing, request, T0 + 1)).toBe(true)
    expect(() => pairing.claim(request.requestId, T0 + 2)).toThrow(expect.objectContaining({ reason: 'too_large' }))
    expect(readFileSync(file, 'utf8')).toBe(text)
  })

  it('refuses a file over 1 MiB as not a store, without reading it as one', () => {
    expect(MAX_STORE_BYTES).toBe(1024 * 1024)
    const valid = store([agentRow(ID1, 'Claude Code', 'a'.repeat(64))])
    const atLimit = valid + ' '.repeat(MAX_STORE_BYTES - Buffer.byteLength(valid))
    expect(Buffer.byteLength(atLimit)).toBe(MAX_STORE_BYTES)
    expect(refusal(atLimit)).toBeNull()
    expect(refusal(`${atLimit} `)).toBe('not_a_store')
  })
})

// Fix round 6: a time the store would refuse at open (not a whole non-negative ms) is never taken,
// so it can never be written. Every method that takes `now` throws a TypeError before it acts.
describe('the clock a caller passes (fix round 6)', () => {
  const BAD = [1.5, -1, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, '1' as unknown as number]

  it('refuses a claim and a last call at a time the store would refuse, and writes nothing', () => {
    const file = storeFile()
    const pairing = open(file)
    const agent = pairing.verify(pair(pairing, 'Claude Code', T0))!
    const request = asked(pairing.request('Codex', T0 + 10))
    expect(confirmAt(pairing, request, T0 + 11)).toBe(true)
    const before = readFileSync(file, 'utf8')
    for (const now of BAD) {
      expect(() => pairing.claim(request.requestId, now), String(now)).toThrow(TypeError)
      expect(() => pairing.touch(agent.agentId, now), String(now)).toThrow(TypeError)
    }
    expect(readFileSync(file, 'utf8')).toBe(before)
    expect(pairing.list(T0 + 12).agents).toEqual([agent])
    expect(pairing.claim(request.requestId, T0 + 12)).toHaveProperty('key')
    expect(open(file).list(T0 + 13).agents.map((a) => a.name)).toEqual(['Claude Code', 'Codex'])
  })

  it('refuses it in every other method that takes a time, before anything happens', () => {
    const file = storeFile()
    const notices: PairingNotice[] = []
    const pairing = open(file, notices)
    const agent = pairing.verify(pair(pairing, 'Claude Code', T0))!
    const request = asked(pairing.request('Codex', T0 + 10))
    const handle = handleOf(pairing, request, T0 + 10)
    const seen = notices.length
    for (const now of BAD) {
      const label = String(now)
      expect(() => pairing.request('Cursor', now), label).toThrow(TypeError)
      expect(() => pairing.confirmByHandle(handle, now), label).toThrow(TypeError)
      expect(() => pairing.declineByHandle(handle, now), label).toThrow(TypeError)
      expect(() => pairing.revoke(agent.agentId, now), label).toThrow(TypeError)
      expect(() => pairing.list(now), label).toThrow(TypeError)
      expect(() => pairing.close(now), label).toThrow(TypeError)
    }
    expect(notices).toHaveLength(seen)
    expect(pairing.list(T0 + 20)).toMatchObject({ agents: [agent], requests: [{ handle, state: 'pending' }] })
    expect(pairing.request('Cursor', T0 + 20)).toHaveProperty('requestId')
  })

  it('takes 0 and the largest safe integer', () => {
    const pairing = open()
    expect(pairing.list(0).requests).toEqual([])
    expect(pairing.list(Number.MAX_SAFE_INTEGER).requests).toEqual([])
  })
})

// Fix round 6: a handle already in use is drawn again, as claim does for agent ids. With real
// randomness this never repeats; a seeded or broken source can repeat.
describe('a handle drawn twice (fix round 6)', () => {
  /** A source whose 8-byte draws (the handle) give the same bytes the first `times` times. */
  function repeating(times: number): RandomSource {
    const base = seeded()
    const fixed = seeded('repeat')(8)
    let eights = 0
    return (size) => (size === 8 && eights++ < times ? Buffer.from(fixed) : base(size))
  }

  it('is drawn again for a waiting request, so each row keeps its own handle', () => {
    const pairing = Pairing.open(storeFile(), { random: repeating(3) })
    const first = asked(pairing.request('Claude Code', T0))
    const second = asked(pairing.request('Codex', T0 + 10))
    const rows = pairing.list(T0 + 20).requests
    expect(rows).toHaveLength(2)
    expect(new Set(rows.map((row) => row.handle)).size).toBe(2)
    expect(confirmAt(pairing, second, T0 + 21)).toBe(true)
    expect(pairing.claim(first.requestId, T0 + 22)).toEqual({ pending: true })
    expect(pairing.claim(second.requestId, T0 + 22)).toHaveProperty('key')
  })

  it('is drawn again for an ended row still on the page', () => {
    const pairing = Pairing.open(storeFile(), { random: repeating(2) })
    asked(pairing.request('Claude Code', T0))
    // The first request ends at this very time, before the second draws its handle.
    const late = T0 + REQUEST_LIFETIME_MS
    asked(pairing.request('Codex', late))
    const rows = pairing.list(late).requests
    expect(rows.map((row) => [row.name, row.state])).toEqual([
      ['Codex', 'pending'],
      ['Claude Code', 'expired'],
    ])
    expect(new Set(rows.map((row) => row.handle)).size).toBe(2)
  })

  it('draws a request id again too, while the first is waiting or still answered for', () => {
    const base = seeded()
    const fixed = seeded('repeat')(16)
    let sixteens = 0
    const pairing = Pairing.open(storeFile(), { random: (size) => (size === 16 && sixteens++ < 3 ? Buffer.from(fixed) : base(size)) })
    const first = asked(pairing.request('Claude Code', T0))
    const second = asked(pairing.request('Codex', T0 + 10))
    expect(second.requestId).not.toBe(first.requestId)
    expect(declineAt(pairing, first, T0 + 11)).toBe(true)
    const third = asked(pairing.request('Cursor', T0 + 12))
    expect(third.requestId).not.toBe(first.requestId)
    expect(pairing.claim(first.requestId, T0 + 13)).toEqual({ refused: 'declined' })
    expect(pairing.claim(second.requestId, T0 + 13)).toEqual({ pending: true })
  })
})
