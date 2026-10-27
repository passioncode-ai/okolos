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
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { skeleton } from '@okolos/core-lookalike'

import { atomicWrite } from '../fabric/fabric-service.mjs'
import type { ServiceDirs } from '../service/dirs.js'
import { checkAgentName, type NameRefusal } from './name.js'

/** The pairing store: the one place a key's SHA-256 lives, in the service data folder. */
export function pairingStoreFile(dirs: ServiceDirs): string {
  return path.join(dirs.data, 'pairings.json')
}

/**
 * The pairing store cannot be read, or holds something that is not a pairing store. Nothing is
 * paired or checked until it is fixed (SCR-23, error state); the file is never overwritten.
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

export type StoreRefusal = 'unreadable' | 'not_json' | 'not_a_store' | 'bad_record'

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
  /**
   * Another waiting request (pending or confirmed) or an agent with access carries a name that
   * looks the same (see `nameSkeleton`); every such request is marked. Never set on an expired row.
   */
  readonly duplicateName: boolean
  /** The agents with access whose name looks the same as this request's; empty when none. */
  readonly sameNameAgents: readonly { readonly agentId: string; readonly name: string }[]
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
    return found === null ? null : { agentId: found.agentId, name: found.name, pairedAt: found.pairedAt }
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
        duplicateName: (perName.get(looks) ?? 0) > 1 || sameNameAgents.length > 0,
        sameNameAgents,
      }
    })
    const gone = [...this.ended.values()].map(
      ({ handle, name, code, createdAt, endedAt }): PublicRequest => ({
        handle,
        name,
        code,
        createdAt,
        expiresAt: endedAt,
        state: 'expired',
        duplicateName: false,
        sameNameAgents: [],
      }),
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStoredAgent(value: unknown): value is StoredAgent {
  return (
    isRecord(value) &&
    typeof value['agentId'] === 'string' &&
    typeof value['name'] === 'string' &&
    typeof value['pairedAt'] === 'number' &&
    typeof value['keyHash'] === 'string' &&
    /^[0-9a-f]{64}$/.test(value['keyHash'])
  )
}

/**
 * What a name looks like, so two names a person would read as one compare equal: NFKC, case folded,
 * reduced by the Latin, Cyrillic and Greek look-alike table of @okolos/core-lookalike (`skeleton`,
 * the same one the link check uses), with runs of white space collapsed and the ends trimmed.
 */
function nameSkeleton(name: string): string {
  return skeleton(name.normalize('NFKC').toLowerCase()).replace(/\s+/gu, ' ').trim()
}

function sha256(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex')
}
