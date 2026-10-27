/**
 * Agent pairing for Okolos Agent (K3, REQ-58; spec §11 F5, F12, F13).
 *
 * An agent's CLI asks to pair under a name it gives itself and gets a request id and a six-digit
 * code. The daemon's page lists the request with the same code and a handle of its own; the person
 * compares the two codes and confirms or declines by that handle. After the confirm the CLI claims
 * a 256-bit key, once. The daemon keeps only the key's SHA-256, in its own pairing store (0600,
 * written atomically); there is no second store (no keychain in Б1, F13).
 *
 * The request id is the CLI's secret for the claim. It is never listed for the page, never stored
 * and never in a notice, which is all the journal and the events are written from; it is forgotten
 * when the key is given out or the request ends. The page's handle is a different random value, so
 * a request id offered to the page's actions finds nothing (audit #9).
 *
 * Requests live in memory only: they last five minutes, and a restart ends them.
 */
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'

import { atomicWrite } from '../fabric/fabric-service.mjs'
import { checkAgentName, type NameRefusal } from './name.js'

/** A request lives this long from its creation, unless it is confirmed. */
export const REQUEST_LIFETIME_MS = 5 * 60_000
/** After the confirm, the key can be claimed for this long. */
export const CLAIM_WINDOW_MS = 5 * 60_000
/**
 * An ended request stays on the page this long as "expired", with nothing to press (SCR-23), then
 * leaves the list. Its request id is forgotten at the end itself, not after this.
 */
export const EXPIRED_SHOWN_MS = 5 * 60_000
/** At most this many requests wait at once: for the person's decision, or confirmed for the claim. */
export const MAX_PENDING = 3
/** At most this many new requests in any minute. */
export const MAX_NEW_PER_MINUTE = 6

/** Gives `size` random bytes; tests pass a seeded one. */
export type RandomSource = (size: number) => Buffer

export type RequestRefusal = NameRefusal | 'too_many_pending' | 'too_many_requests'

/** A paired agent as the page and the door see it. The key's hash stays inside this module. */
export interface AgentRecord {
  readonly agentId: string
  readonly name: string
  /** When the key was claimed, ms since the epoch. */
  readonly pairedAt: number
}

/** A request as the page sees it: a handle for its buttons, never the request id. */
export interface PublicRequest {
  readonly handle: string
  /** The name the agent gave itself; nothing verifies it. */
  readonly name: string
  readonly code: string
  readonly createdAt: number
  /** Until the confirm, the request's end; after it, the end of the claim window; once expired, when it ended. */
  readonly expiresAt: number
  /** An expired row is shown for EXPIRED_SHOWN_MS with nothing to press; its handle does nothing. */
  readonly state: 'pending' | 'confirmed' | 'expired'
}

/**
 * What happened, for the journal and the events. Carries the handle and the agent id, never the
 * request id, the code or a key.
 */
export type PairingNotice =
  | { readonly kind: 'requested' | 'confirmed' | 'declined' | 'expired'; readonly handle: string; readonly name: string }
  | { readonly kind: 'paired'; readonly handle: string; readonly agentId: string; readonly name: string }
  | { readonly kind: 'revoked'; readonly agentId: string; readonly name: string }

export interface PairingOptions {
  random?: RandomSource
  onNotice?: (notice: PairingNotice) => void
}

interface Entry {
  readonly requestId: string
  readonly handle: string
  readonly name: string
  readonly code: string
  readonly createdAt: number
  confirmedAt: number | null
}

/** What the page still shows of an expired request: no request id, nothing to act on. */
interface Ended {
  readonly handle: string
  readonly name: string
  readonly code: string
  readonly createdAt: number
  readonly endedAt: number
}

interface StoredAgent extends AgentRecord {
  /** SHA-256 of the key, hex. */
  readonly keyHash: string
}

interface StoreFile {
  readonly schema: typeof SCHEMA
  readonly agents: readonly StoredAgent[]
}

const SCHEMA = 'okolos-agent/pairings/1'

export class Pairing {
  readonly file: string
  private readonly random: RandomSource
  private readonly notify: (notice: PairingNotice) => void
  private agents: StoredAgent[]
  private readonly byRequestId = new Map<string, Entry>()
  private readonly byHandle = new Map<string, Entry>()
  private readonly ended = new Map<string, Ended>()
  /** When each request of the last minute was created. */
  private created: number[] = []

  private constructor(file: string, agents: StoredAgent[], options: PairingOptions) {
    this.file = file
    this.agents = agents
    this.random = options.random ?? randomBytes
    this.notify = options.onNotice ?? (() => {})
  }

  /** Opens the pairing store at `file`; a missing file is an empty store, written on first change. */
  static open(file: string, options: PairingOptions = {}): Pairing {
    const agents = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as StoreFile).agents : []
    return new Pairing(file, [...agents], options)
  }

  request(agentName: string, now: number): { requestId: string; code: string; expiresAt: number } | { refused: RequestRefusal } {
    const refused = checkAgentName(agentName)
    if (refused !== null) return { refused }
    this.sweep(now)
    if (this.byHandle.size >= MAX_PENDING) return { refused: 'too_many_pending' }
    this.created = this.created.filter((at) => now - at < 60_000)
    if (this.created.length >= MAX_NEW_PER_MINUTE) return { refused: 'too_many_requests' }
    this.created.push(now)
    const entry: Entry = {
      requestId: this.hex(16),
      handle: this.hex(8),
      name: agentName,
      code: this.code(),
      createdAt: now,
      confirmedAt: null,
    }
    this.byRequestId.set(entry.requestId, entry)
    this.byHandle.set(entry.handle, entry)
    this.notify({ kind: 'requested', handle: entry.handle, name: entry.name })
    return { requestId: entry.requestId, code: entry.code, expiresAt: entry.createdAt + REQUEST_LIFETIME_MS }
  }

  confirm(requestId: string, now: number): boolean {
    this.sweep(now)
    return this.confirmEntry(this.byRequestId.get(requestId), now)
  }

  confirmByHandle(handle: string, now: number): boolean {
    this.sweep(now)
    return this.confirmEntry(this.byHandle.get(handle), now)
  }

  decline(requestId: string): boolean {
    return this.declineEntry(this.byRequestId.get(requestId))
  }

  declineByHandle(handle: string): boolean {
    return this.declineEntry(this.byHandle.get(handle))
  }

  claim(requestId: string, now: number): { key: string } | { pending: true } | null {
    this.sweep(now)
    const entry = this.byRequestId.get(requestId)
    if (entry === undefined) return null
    if (entry.confirmedAt === null) return { pending: true }
    const key = this.hex(32)
    const agent: StoredAgent = { agentId: this.hex(8), name: entry.name, pairedAt: now, keyHash: sha256(key) }
    // The key is given out only once the store holds its hash.
    this.save([...this.agents, agent])
    this.forget(entry)
    this.notify({ kind: 'paired', handle: entry.handle, agentId: agent.agentId, name: agent.name })
    return { key }
  }

  revoke(agentId: string): boolean {
    const agent = this.agents.find((a) => a.agentId === agentId)
    if (agent === undefined) return false
    this.save(this.agents.filter((a) => a !== agent))
    this.notify({ kind: 'revoked', agentId: agent.agentId, name: agent.name })
    return true
  }

  list(now: number): { requests: PublicRequest[]; agents: AgentRecord[] } {
    this.sweep(now)
    const live = [...this.byHandle.values()].map((entry): PublicRequest => ({
      handle: entry.handle,
      name: entry.name,
      code: entry.code,
      createdAt: entry.createdAt,
      expiresAt: deadline(entry),
      state: entry.confirmedAt === null ? 'pending' : 'confirmed',
    }))
    const gone = [...this.ended.values()].map(
      ({ handle, name, code, createdAt, endedAt }): PublicRequest => ({ handle, name, code, createdAt, expiresAt: endedAt, state: 'expired' }),
    )
    const requests = [...live, ...gone]
    const agents = this.agents.map(({ agentId, name, pairedAt }) => ({ agentId, name, pairedAt }))
    return { requests, agents }
  }

  private confirmEntry(entry: Entry | undefined, now: number): boolean {
    if (entry === undefined) return false
    if (entry.confirmedAt !== null) return true
    entry.confirmedAt = now
    this.notify({ kind: 'confirmed', handle: entry.handle, name: entry.name })
    return true
  }

  private declineEntry(entry: Entry | undefined): boolean {
    if (entry === undefined) return false
    this.forget(entry)
    this.notify({ kind: 'declined', handle: entry.handle, name: entry.name })
    return true
  }

  /**
   * Ends every request past its deadline: its request id is forgotten there and then, and the page
   * keeps a row without it for EXPIRED_SHOWN_MS.
   */
  private sweep(now: number): void {
    for (const entry of [...this.byHandle.values()]) {
      const endedAt = deadline(entry)
      if (now < endedAt) continue
      this.forget(entry)
      const { handle, name, code, createdAt } = entry
      this.ended.set(handle, { handle, name, code, createdAt, endedAt })
      this.notify({ kind: 'expired', handle, name })
    }
    for (const row of [...this.ended.values()]) {
      if (now - row.endedAt >= EXPIRED_SHOWN_MS) this.ended.delete(row.handle)
    }
  }

  private forget(entry: Entry): void {
    this.byRequestId.delete(entry.requestId)
    this.byHandle.delete(entry.handle)
  }

  private save(agents: StoredAgent[]): void {
    const content: StoreFile = { schema: SCHEMA, agents }
    atomicWrite(this.file, `${JSON.stringify(content, null, 2)}\n`, 0o600)
    this.agents = agents
  }

  private hex(bytes: number): string {
    return this.random(bytes).toString('hex')
  }

  /** Six digits, uniform: four random bytes, redrawn above the last whole million. */
  private code(): string {
    const limit = Math.floor(0x1_0000_0000 / 1_000_000) * 1_000_000
    for (;;) {
      const value = this.random(4).readUInt32BE(0)
      if (value < limit) return String(value % 1_000_000).padStart(6, '0')
    }
  }
}

function deadline(entry: Entry): number {
  return entry.confirmedAt === null ? entry.createdAt + REQUEST_LIFETIME_MS : entry.confirmedAt + CLAIM_WINDOW_MS
}

function sha256(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex')
}
