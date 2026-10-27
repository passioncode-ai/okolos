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
    expect(pairing.revoke(later.agents[0]!.agentId)).toMatchObject({ name: 'Claude Code' })

    const everything = JSON.stringify({ page, later, notices, store: readFileSync(file, 'utf8') })
    for (const id of ids) expect(everything).not.toContain(id)
    expect(notices.map((n) => n.kind)).toEqual(['requested', 'requested', 'requested', 'confirmed', 'declined', 'paired', 'expired', 'revoked'])
  })

  it('is forgotten once the key is given out: a second claim and a late confirm find nothing', () => {
    const pairing = open()
    const request = asked(pairing.request('Claude Code', T0))
    const { requestId } = request
    const handle = handleOf(pairing, request, T0)
    expect(pairing.confirmByHandle(handle, T0 + 1)).toBe(true)
    expect(pairing.claim(requestId, T0 + 2)).toHaveProperty('key')
    expect(pairing.confirmByHandle(handle, T0 + 3)).toBe(false)
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
    const request = asked(pairing.request('Claude Code', T0))
    const { requestId } = request
    expect(confirmAt(pairing, request, T0 + MINUTE)).toBe(true)
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
    expect(confirmAt(pairing, late, confirmedAt)).toBe(true)
    // Past the request's own five minutes, inside the claim window: still claimable.
    expect(pairing.claim(late.requestId, T0 + 6 * MINUTE)).toHaveProperty('key')

    const missed = asked(pairing.request('Codex', T0))
    expect(confirmAt(pairing, missed, confirmedAt)).toBe(true)
    expect(pairing.claim(missed.requestId, confirmedAt + CLAIM_WINDOW_MS)).toBeNull()
    expect(pairing.list(confirmedAt + CLAIM_WINDOW_MS).agents.map((a) => a.name)).toEqual(['Claude Code'])
  })

  it('is refused for a request the person declined', () => {
    const pairing = open()
    const request = asked(pairing.request('Claude Code', T0))
    const handle = handleOf(pairing, request, T0)
    expect(pairing.declineByHandle(handle, T0)).toBe(true)
    expect(pairing.claim(request.requestId, T0 + 1)).toBeNull()
    expect(pairing.confirmByHandle(handle, T0 + 2)).toBe(false)
    expect(pairing.list(T0 + 3).requests).toEqual([])
  })

  it('finds nothing for an id it never gave out', () => {
    const pairing = open()
    expect(pairing.claim('0'.repeat(32), T0)).toBeNull()
    expect(pairing.confirmByHandle('0'.repeat(16), T0)).toBe(false)
    expect(pairing.declineByHandle('0'.repeat(16), T0)).toBe(false)
  })
})

describe('how long a request lives and how many there may be (spec §11 F5)', () => {
  it('ends five minutes after its creation when nobody confirms it', () => {
    const notices: PairingNotice[] = []
    const pairing = open(storeFile(), notices)
    const request = asked(pairing.request('Claude Code', T0))
    const { requestId } = request
    expect(pairing.claim(requestId, T0 + REQUEST_LIFETIME_MS - 1)).toEqual({ pending: true })
    expect(pairing.claim(requestId, T0 + REQUEST_LIFETIME_MS)).toBeNull()
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
    expect(pairing.claim(late.requestId, end)).toBeNull()
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

  it('refuses a name the rules refuse, and that refusal counts toward nothing', () => {
    const pairing = open()
    expect(pairing.request('agent 123', T0)).toEqual({ refused: 'name_digits' })
    expect(pairing.request('a'.repeat(41), T0)).toEqual({ refused: 'name_too_long' })
    expect(pairing.request('Okolos Agent', T0)).toEqual({ refused: 'name_reserved' })
    expect(pairing.list(T0).requests).toEqual([])
  })
})

/** Pairs `name` from request to claim and gives back the key. */
function pair(pairing: Pairing, name: string, now: number): string {
  const request = asked(pairing.request(name, now))
  expect(confirmAt(pairing, request, now + 1)).toBe(true)
  const claimed = pairing.claim(request.requestId, now + 2)
  if (claimed === null || !('key' in claimed)) throw new Error('no key')
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
    expect(pairing.revoke(agent.agentId)).toEqual(agent)
    expect(pairing.verify(key)).toBeNull()
    expect(pairing.revoke(agent.agentId)).toBeNull()
    expect(pairing.list(T0 + 20).agents.map((a) => a.name)).toEqual(['Codex'])
    expect(open(file).verify(key)).toBeNull()
    expect(open(file).verify(kept)).toMatchObject({ name: 'Codex' })
  })

  it('says who was revoked: the record it removed, and a notice with the agent id (fix round 1)', () => {
    const notices: PairingNotice[] = []
    const pairing = open(storeFile(), notices)
    const agent = pairing.verify(pair(pairing, 'Claude Code', T0))!
    expect(pairing.revoke(agent.agentId)).toEqual(agent)
    expect(notices.at(-1)).toEqual({ kind: 'revoked', agentId: agent.agentId, name: 'Claude Code' })
    expect(pairing.revoke('no-such-agent')).toBeNull()
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
    pairing.revoke(pairing.verify(old)!.agentId)
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
    expect(() => pairing.revoke(agent.agentId)).toThrow(PairingStoreError)
    expect(() => pairing.revoke(agent.agentId)).toThrow(expect.objectContaining({ reason: 'unwritable', file }))
    chmodSync(path.dirname(file), 0o700)
    expect(pairing.verify(key)).toEqual(agent)
    expect(pairing.list(T0 + 10).agents).toEqual([agent])
    expect(readFileSync(file, 'utf8')).toBe(before)
    expect(notices.filter((n) => n.kind === 'revoked')).toEqual([])
    // Once the store can be written again, the revoke goes through.
    expect(pairing.revoke(agent.agentId)).toEqual(agent)
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

  it('ends every open request at a restart: pending and confirmed ones leave no row, agents stay (fix round 1)', () => {
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
    expect(after.claim(pending.requestId, T0 + 14)).toBeNull()
    expect(after.claim(confirmed.requestId, T0 + 14)).toBeNull()
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
    expect(pairing.claim(request.requestId, T0 + MINUTE + CLAIM_WINDOW_MS)).toBeNull()
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
    expect(confirmAt(pairing, first, T0 + 2)).toBe(true)
    expect(Object.values(flags(pairing, T0 + 3))).toEqual([true, true])
    expect(declineAt(pairing, second, T0 + 3)).toBe(true)
    expect(Object.values(flags(pairing, T0 + 4))).toEqual([false])
  })

  // Fix round 1: names are compared by what they look like, not by their code points.
  it('are marked when a Cyrillic letter stands in for a Latin one', () => {
    const pairing = open()
    asked(pairing.request('Codex', T0))
    asked(pairing.request('Сodex', T0 + 1)) // Cyrillic capital Es
    asked(pairing.request('Claude', T0 + 2))
    const rows = pairing.list(T0 + 3).requests
    expect(rows.map((row) => [row.name, row.duplicateName])).toEqual([
      ['Codex', true],
      ['Сodex', true],
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
    asked(pairing.request('claude cоde ', T0 + 10)) // Cyrillic o, trailing space
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

  it('marks two waiting look-alikes of an agent with access as duplicates, and names the agent on both', () => {
    const pairing = open()
    const agent = pairing.verify(pair(pairing, 'Claude Code', T0))!
    asked(pairing.request('Claude Code', T0 + 10))
    asked(pairing.request('claude cоde', T0 + 11)) // Cyrillic o
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
    expect(pairing.claim(requestId, T0 + 2)).toBeNull()
    expect(pairing.list(T0 + 3).requests).toEqual([])
  })

  it('refuses a request id offered as a handle, and a handle offered as a request id', () => {
    const pairing = open()
    const { requestId } = asked(pairing.request('Claude Code', T0))
    const [row] = pairing.list(T0 + 1).requests
    expect(row!.handle).not.toBe(requestId)
    expect(pairing.confirmByHandle(requestId, T0 + 2)).toBe(false)
    expect(pairing.declineByHandle(requestId, T0 + 2)).toBe(false)
    expect(pairing.claim(row!.handle, T0 + 2)).toBeNull()
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
    expect(pairing.claim(requestId, T0 + REQUEST_LIFETIME_MS)).toBeNull()
  })
})
