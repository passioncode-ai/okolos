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
    expect(pairing.decline(requestId, T0)).toBe(true)
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
    expect(pairing.decline(third.requestId, T0 + 7)).toBe(true)
    asked(pairing.request('Agent five', T0 + 8))
    // An expired request waits for nothing.
    asked(pairing.request('Agent six', T0 + 8 + REQUEST_LIFETIME_MS))
  })

  it('refuses a seventh new request within a minute, and takes one again when the minute moves on', () => {
    expect(MAX_NEW_PER_MINUTE).toBe(6)
    const pairing = open()
    for (let n = 0; n < 6; n++) {
      const { requestId } = asked(pairing.request(`Agent ${n}`, T0 + n * 1000))
      pairing.decline(requestId, T0 + n * 1000)
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

/** Pairs `name` from request to claim and gives back the key. */
function pair(pairing: Pairing, name: string, now: number): string {
  const { requestId } = asked(pairing.request(name, now))
  expect(pairing.confirm(requestId, now + 1)).toBe(true)
  const claimed = pairing.claim(requestId, now + 2)
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
    const { requestId } = asked(pairing.request('Claude Code', T0))
    pairing.confirm(requestId, T0 + 1)
    chmodSync(path.dirname(file), 0o500)
    expect(() => pairing.claim(requestId, T0 + 2)).toThrow()
    chmodSync(path.dirname(file), 0o700)
    expect(pairing.list(T0 + 3).agents).toEqual([])
    expect(pairing.claim(requestId, T0 + 4)).toHaveProperty('key')
    expect(pairing.list(T0 + 5).agents).toHaveLength(1)
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
    const { requestId } = asked(pairing.request('Claude Code', T0))
    expect(pairing.confirm(requestId, T0 + 1)).toBe(true)
    const claimed = pairing.claim(requestId, T0 + 2)
    expect(claimed).toEqual({ key: expect.stringMatching(/^[0-9a-f]{64}$/) })
    expect(pairing.verify((claimed as { key: string }).key)).toMatchObject({ name: 'Claude Code' })
    expect(reported.map(([, notice]) => notice.kind)).toEqual(['requested', 'confirmed', 'paired'])
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
    expect(pairing.decline(second.requestId, T0 + 3)).toBe(true)
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

  it('marks a request named like an agent that already has access, and says which agent', () => {
    const pairing = open()
    const key = pair(pairing, 'Claude Code', T0)
    const agent = pairing.verify(key)!
    asked(pairing.request('claude cоde ', T0 + 10)) // Cyrillic o, trailing space
    asked(pairing.request('Codex', T0 + 11))
    const rows = pairing.list(T0 + 12).requests
    expect(rows[0]).toMatchObject({ duplicateName: true, sameNameAgents: [{ agentId: agent.agentId, name: 'Claude Code' }] })
    expect(rows[1]).toMatchObject({ duplicateName: false, sameNameAgents: [] })
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
    expect(pairing.confirm(row!.handle, T0 + 2)).toBe(false)
    expect(pairing.decline(row!.handle, T0 + 2)).toBe(false)
    expect(pairing.claim(requestId, T0 + 3)).toEqual({ pending: true })
    expect(pairing.list(T0 + 3).requests[0]).toMatchObject({ state: 'pending' })
  })

  it('does not decline a request whose five minutes are over: it stays an expired row (fix round 1)', () => {
    const notices: PairingNotice[] = []
    const pairing = open(storeFile(), notices)
    const byId = asked(pairing.request('Claude Code', T0))
    asked(pairing.request('Codex', T0 + 1))
    const rows = pairing.list(T0 + 2).requests
    const codex = rows.find((row) => row.name === 'Codex')!
    expect(pairing.decline(byId.requestId, T0 + REQUEST_LIFETIME_MS)).toBe(false)
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
