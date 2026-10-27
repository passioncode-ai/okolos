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
 * Requests live in memory only, by design: they last five minutes, and the request id is a secret
 * that should never reach the disk. So a restart of the daemon ends every open request, pending or
 * confirmed: after it list() shows no row for them (not even an expired one), a claim finds
 * nothing, and the agent has to ask again with `okolos-agent pair`. SCR-23 says so to the person.
 * Agents with access live in the store and survive the restart, each with its last call as it was
 * last written: at most a minute older than its newest call (see `touch`), or exactly that call
 * when the daemon ran `flush` before it stopped.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { atomicWrite } from '../fabric/fabric-service.mjs'
import type { ServiceDirs } from '../service/dirs.js'
import { checkAgentName, nameSkeleton, type NameRefusal } from './name.js'

/** The pairing store: the one place a key's SHA-256 lives, in the service data folder. */
export function pairingStoreFile(dirs: ServiceDirs): string {
  return path.join(dirs.data, 'pairings.json')
}

/**
 * The pairing store cannot be read, holds something that is not a pairing store, or cannot be
 * written. A store that cannot be opened pairs and checks nothing until it is fixed (SCR-23, error
 * state), and the file is never overwritten. A write that fails (`unwritable`) changes nothing:
 * the file and the agents in memory stay as they were.
 */
export class PairingStoreError extends Error {
  readonly file: string
  /** A machine code; the page maps it through the catalogue. */
  readonly reason: StoreRefusal
  constructor(file: string, reason: StoreRefusal, options?: { cause?: unknown }) {
    super(`pairing store ${file}: ${reason}`, options)
    this.name = 'PairingStoreError'
    this.file = file
    this.reason = reason
  }
}

export type StoreRefusal = 'unreadable' | 'not_json' | 'not_a_store' | 'bad_record' | 'unwritable'

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
  /** The agent's last call through the door (`touch`), ms since the epoch; null before the first. */
  readonly lastCallAt: number | null
}

/** An agent's last call is written to the store at most this often; the newer value is kept in memory. */
export const LAST_CALL_WRITE_MS = 60_000

/** A request as the page sees it: a handle for its buttons, never the request id. */
export interface PublicRequest {
  readonly handle: string
  /** The name the agent gave itself; nothing verifies it. */
  readonly name: string
  readonly code: string
  readonly createdAt: number
  /** Until the confirm, the request's end; after it, the end of the claim window; once ended, when it ended. */
  readonly expiresAt: number
  /**
   * `expired`: nobody confirmed it within five minutes of its creation. `claim_expired`: the person
   * confirmed it, but the agent did not collect its key within five minutes of the confirm. Both
   * ended rows are shown for EXPIRED_SHOWN_MS with nothing to press; their handles do nothing.
   */
  readonly state: 'pending' | 'confirmed' | 'expired' | 'claim_expired'
  /** When the person confirmed it, kept on a `claim_expired` row; null when never confirmed. */
  readonly confirmedAt: number | null
  /**
   * Another waiting request (pending or confirmed) carries a name that looks the same (see
   * `nameSkeleton`); every such request is marked. Only waiting requests count: a request that
   * looks like an agent with access is told by `sameNameAgents` alone. Never set on an expired row.
   */
  readonly duplicateName: boolean
  /**
   * The agents with access whose name looks the same as this request's; empty when none. Set
   * whether or not `duplicateName` is.
   */
  readonly sameNameAgents: readonly { readonly agentId: string; readonly name: string }[]
}

/**
 * What happened, for the journal and the events. Carries the handle and the agent id, never the
 * request id, the code or a key.
 */
export type PairingNotice =
  | { readonly kind: 'requested' | 'confirmed' | 'declined' | 'expired' | 'claim_expired'; readonly handle: string; readonly name: string }
  | { readonly kind: 'paired'; readonly handle: string; readonly agentId: string; readonly name: string }
  | { readonly kind: 'revoked'; readonly agentId: string; readonly name: string }

export interface PairingOptions {
  random?: RandomSource
  onNotice?: (notice: PairingNotice) => void
  /**
   * Hears a notice the handler threw on. The change the notice describes has already happened and
   * stands: a request keeps its id for the CLI, a stored key is still given out. Without this
   * option the failure goes to `process.emitWarning`.
   */
  onNoticeError?: (error: unknown, notice: PairingNotice) => void
}

function warn(error: unknown, notice: PairingNotice): void {
  process.emitWarning(error instanceof Error ? error : String(error), { code: 'OKOLOS_PAIRING_NOTICE', detail: notice.kind })
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
  readonly confirmedAt: number | null
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
  /** Per agent, when `touch` last wrote the store for that agent's call. */
  private readonly lastCallWrite = new Map<string, number>()
  /** Some agent's last call is in memory only; `flush` writes it. Any write of the store clears it. */
  private callsUnsaved = false

  private constructor(file: string, agents: StoredAgent[], options: PairingOptions) {
    this.file = file
    this.agents = agents
    this.random = options.random ?? randomBytes
    const onNotice = options.onNotice ?? (() => {})
    const onNoticeError = options.onNoticeError ?? warn
    this.notify = (notice) => {
      try {
        onNotice(notice)
      } catch (error) {
        try {
          onNoticeError(error, notice)
        } catch {
          // The reporter failed too; there is nowhere left to say it, and the change stands.
        }
      }
    }
  }

  /**
   * Opens the pairing store at `file`; a missing file is an empty store, written on first change.
   * A file that cannot be read or is not a pairing store throws PairingStoreError.
   */
  static open(file: string, options: PairingOptions = {}): Pairing {
    return new Pairing(file, readStore(file), options)
  }

  /** The agent a key belongs to, or null. Every stored hash is compared, in constant time. */
  verify(key: string): AgentRecord | null {
    const presented = createHash('sha256').update(key, 'utf8').digest()
    let found: StoredAgent | null = null
    for (const agent of this.agents) {
      if (timingSafeEqual(presented, Buffer.from(agent.keyHash, 'hex')) && found === null) found = agent
    }
    return found === null ? null : record(found)
  }

  /**
   * Records the agent's last call; false when no such agent has access. The value is kept in
   * memory and written to the store (atomically, like every write) at most once a minute per agent,
   * so each agent's stored call is at most LAST_CALL_WRITE_MS older than its newest one, whatever
   * the other agents do. A write that fails throws PairingStoreError; the call stays in memory for
   * the next write or `flush`.
   */
  touch(agentId: string, now: number): boolean {
    if (!this.agents.some((a) => a.agentId === agentId)) return false
    this.agents = this.agents.map((a) => (a.agentId === agentId ? { ...a, lastCallAt: now } : a))
    this.callsUnsaved = true
    if (now - (this.lastCallWrite.get(agentId) ?? Number.NEGATIVE_INFINITY) >= LAST_CALL_WRITE_MS) {
      this.save(this.agents)
      this.lastCallWrite.set(agentId, now)
    }
    return true
  }

  /**
   * Writes every last call that is still in memory only, for the daemon to run before it stops;
   * writes nothing when there is none. A write that fails throws PairingStoreError and keeps them.
   */
  flush(): void {
    if (this.callsUnsaved) this.save(this.agents)
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

  /**
   * The person's confirm, by the handle list() gave the page. There is no confirm by request id: the
   * request id is the agent's own secret, and a door that took it for a confirm would let an agent
   * pair itself. Confirming a confirmed request again is true and keeps the first confirm time.
   */
  confirmByHandle(handle: string, now: number): boolean {
    this.sweep(now)
    return this.confirmEntry(this.byHandle.get(handle), now)
  }

  /** The person's decline, by handle only, like the confirm. An ended request stays an expired row. */
  declineByHandle(handle: string, now: number): boolean {
    this.sweep(now)
    return this.declineEntry(this.byHandle.get(handle))
  }

  claim(requestId: string, now: number): { key: string } | { pending: true } | null {
    this.sweep(now)
    const entry = this.byRequestId.get(requestId)
    if (entry === undefined) return null
    if (entry.confirmedAt === null) return { pending: true }
    const key = this.hex(32)
    const agent: StoredAgent = { agentId: this.hex(8), name: entry.name, pairedAt: now, lastCallAt: null, keyHash: sha256(key) }
    // The key is given out only once the store holds its hash.
    this.save([...this.agents, agent])
    this.forget(entry)
    this.notify({ kind: 'paired', handle: entry.handle, agentId: agent.agentId, name: agent.name })
    return { key }
  }

  /**
   * Removes the agent's access and gives back the record it removed, or null when there was none;
   * the 'revoked' notice carries the same agent id, so the daemon can close its tasks and windows.
   */
  revoke(agentId: string): AgentRecord | null {
    const agent = this.agents.find((a) => a.agentId === agentId)
    if (agent === undefined) return null
    this.save(this.agents.filter((a) => a !== agent))
    this.lastCallWrite.delete(agent.agentId)
    this.notify({ kind: 'revoked', agentId: agent.agentId, name: agent.name })
    return record(agent)
  }

  list(now: number): { requests: PublicRequest[]; agents: AgentRecord[] } {
    this.sweep(now)
    const waiting = [...this.byHandle.values()]
    const perName = new Map<string, number>()
    for (const entry of waiting) perName.set(nameSkeleton(entry.name), (perName.get(nameSkeleton(entry.name)) ?? 0) + 1)
    const live = waiting.map((entry): PublicRequest => {
      const looks = nameSkeleton(entry.name)
      const sameNameAgents = this.agents
        .filter((agent) => nameSkeleton(agent.name) === looks)
        .map(({ agentId, name }) => ({ agentId, name }))
      return {
        handle: entry.handle,
        name: entry.name,
        code: entry.code,
        createdAt: entry.createdAt,
        expiresAt: deadline(entry),
        state: entry.confirmedAt === null ? 'pending' : 'confirmed',
        confirmedAt: entry.confirmedAt,
        duplicateName: (perName.get(looks) ?? 0) > 1,
        sameNameAgents,
      }
    })
    const gone = [...this.ended.values()].map(
      ({ handle, name, code, createdAt, confirmedAt, endedAt }): PublicRequest => ({
        handle,
        name,
        code,
        createdAt,
        expiresAt: endedAt,
        state: confirmedAt === null ? 'expired' : 'claim_expired',
        confirmedAt,
        duplicateName: false,
        sameNameAgents: [],
      }),
    )
    const requests = [...live, ...gone]
    const agents = this.agents.map(record)
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
      const { handle, name, code, createdAt, confirmedAt } = entry
      this.ended.set(handle, { handle, name, code, createdAt, confirmedAt, endedAt })
      this.notify({ kind: confirmedAt === null ? 'expired' : 'claim_expired', handle, name })
    }
    for (const row of [...this.ended.values()]) {
      if (now - row.endedAt >= EXPIRED_SHOWN_MS) this.ended.delete(row.handle)
    }
  }

  private forget(entry: Entry): void {
    this.byRequestId.delete(entry.requestId)
    this.byHandle.delete(entry.handle)
  }

  /** Writes `agents` and only then takes them as the agents in memory; throws PairingStoreError. */
  private save(agents: StoredAgent[]): void {
    const content: StoreFile = { schema: SCHEMA, agents }
    try {
      atomicWrite(this.file, `${JSON.stringify(content, null, 2)}\n`, 0o600)
    } catch (error) {
      throw new PairingStoreError(this.file, 'unwritable', { cause: error })
    }
    this.agents = agents
    // The file now holds every agent as it is in memory, last calls included.
    this.callsUnsaved = false
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

function readStore(file: string): StoredAgent[] {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw new PairingStoreError(file, 'unreadable', { cause: error })
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new PairingStoreError(file, 'not_json', { cause: error })
  }
  if (!isRecord(value) || value['schema'] !== SCHEMA || !Array.isArray(value['agents'])) {
    throw new PairingStoreError(file, 'not_a_store')
  }
  const agents = value['agents'] as unknown[]
  if (!agents.every(isStoredAgent)) throw new PairingStoreError(file, 'bad_record')
  return agents
}

/** The record the page and the door see; the key's hash stays in the store. */
function record({ agentId, name, pairedAt, lastCallAt }: StoredAgent): AgentRecord {
  return { agentId, name, pairedAt, lastCallAt }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStoredAgent(value: unknown): value is StoredAgent {
  return (
    isRecord(value) &&
    typeof value['agentId'] === 'string' &&
    typeof value['name'] === 'string' &&
    typeof value['pairedAt'] === 'number' &&
    (value['lastCallAt'] === null || typeof value['lastCallAt'] === 'number') &&
    typeof value['keyHash'] === 'string' &&
    /^[0-9a-f]{64}$/.test(value['keyHash'])
  )
}

function sha256(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex')
}
