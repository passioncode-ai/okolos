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
 * when the key is given out or the request ends. Only its SHA-256 stays in memory after the end, for
 * EXPIRED_SHOWN_MS, so a late claim is told why it gets no key (`ClaimRefusal`, fix round 3). The
 * page's handle is a different random value, so a request id offered to the page's actions finds
 * nothing (audit #9).
 *
 * Requests live in memory only, by design: they last five minutes, and the request id is a secret
 * that should never reach the disk. So a restart of the daemon ends every open request, pending or
 * confirmed: after it list() shows no row for them (not even an expired one), a claim is told
 * `unknown`, and the agent has to ask again with `okolos-agent pair`. SCR-23 says so to the person.
 * Before it stops, the daemon runs `close`, which ends the open requests with their notices (so the
 * journal says how each ended) and flushes. Agents with access live in the store and survive the
 * restart, each with its last call as it was last written: at most a minute older than its newest
 * call (see `touch`), or exactly that call when the daemon ran `close` or `flush` before it stopped.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'

import { atomicWrite } from '../fabric/fabric-service.mjs'
import type { ServiceDirs } from '../service/dirs.js'
import { checkAgentName, namesLookAlike, type NameRefusal } from './name.js'

/** The pairing store: the one place a key's SHA-256 lives, in the service data folder. */
export function pairingStoreFile(dirs: ServiceDirs): string {
  return path.join(dirs.data, 'pairings.json')
}

/**
 * The pairing store cannot be read, holds something that is not a pairing store, or cannot be
 * written. A store that cannot be opened pairs and checks nothing until it is fixed (SCR-23, error
 * state), and the file is never overwritten. A write that fails (`unwritable`, `changed_on_disk`)
 * changes nothing: the file and the agents in memory stay as they were. `changed_on_disk` (fix round
 * 4): the file is not what this pairing last read or wrote (another daemon, a hand edit, a restore),
 * so writing would lose that change; every later write is refused the same way until the daemon
 * opens the store again.
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

export type StoreRefusal = 'unreadable' | 'not_json' | 'not_a_store' | 'bad_record' | 'unwritable' | 'changed_on_disk'

/**
 * A store file larger than this is not opened (`not_a_store`, fix round 4): a pairing is about 200
 * bytes, so this holds thousands, and a larger file is not one the daemon wrote.
 */
export const MAX_STORE_BYTES = 1024 * 1024

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

/** `closed`: the daemon is stopping (`close`), and takes no request any more. */
export type RequestRefusal = NameRefusal | 'too_many_pending' | 'too_many_requests' | 'closed'

/**
 * Why a claim gets no key (fix round 3), so the CLI can tell the person the true reason: the person
 * `declined` the request; it `expired` before anyone confirmed it; it was confirmed but the key was
 * not collected within CLAIM_WINDOW_MS (`claim_expired`); the key was already given out (`claimed`);
 * the daemon was stopping and `close` ended it while it still waited (`stopped`, fix round 5). Each
 * is answered for EXPIRED_SHOWN_MS after the end; after that, and for an id the daemon never gave out
 * or gave out before a restart, the answer is `unknown`.
 */
export type ClaimRefusal = 'declined' | 'expired' | 'claim_expired' | 'claimed' | 'stopped' | 'unknown'

/** Why a waiting request ended unanswered (fix round 5): its time ran out, or `close` ended it. */
export type EndCause = 'timeout' | 'stopped'

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
   * `namesLookAlike`); every such request is marked. Only waiting requests count: a request that
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
 * request id, the code or a key. `at` (ms since the epoch, fix round 3) is when it happened: for
 * `expired` the request's deadline (its creation plus REQUEST_LIFETIME_MS), for `claim_expired` the
 * confirm plus CLAIM_WINDOW_MS, whenever a later call found the end; for the others the `now` of the
 * call that caused it. An end carries its `cause` (fix round 5): `timeout` for a deadline, `stopped`
 * for a request `close` ended, dated by the close.
 */
export type PairingNotice =
  | {
      readonly kind: 'requested' | 'confirmed' | 'declined'
      readonly handle: string
      readonly name: string
      readonly at: number
    }
  | {
      readonly kind: 'expired' | 'claim_expired'
      readonly handle: string
      readonly name: string
      readonly at: number
      readonly cause: EndCause
    }
  | { readonly kind: 'paired'; readonly handle: string; readonly agentId: string; readonly name: string; readonly at: number }
  | { readonly kind: 'revoked'; readonly agentId: string; readonly name: string; readonly at: number }

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
  /** What the file held when this pairing last read or wrote it; null for no file (fix round 4). */
  private onDisk: Fingerprint | null
  private readonly byRequestId = new Map<string, Entry>()
  private readonly byHandle = new Map<string, Entry>()
  private readonly ended = new Map<string, Ended>()
  /** Why each recently ended request gets no key, by the SHA-256 of its request id, never the id. */
  private readonly refusals = new Map<string, { readonly refused: Exclude<ClaimRefusal, 'unknown'>; readonly endedAt: number }>()
  /** When each request of the last minute was created. */
  private created: number[] = []
  /** Per agent, when `touch` last wrote the store for that agent's call. */
  private readonly lastCallWrite = new Map<string, number>()
  /** Some agent's last call is in memory only; `flush` writes it. Any write of the store clears it. */
  private callsUnsaved = false
  /** `close` ran: no request, confirm, decline or claim any more. */
  private closed = false

  private constructor(file: string, store: { agents: StoredAgent[]; onDisk: Fingerprint | null }, options: PairingOptions) {
    this.file = file
    this.agents = store.agents
    this.onDisk = store.onDisk
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
   * the other agents do. A write that fails throws PairingStoreError once; the call stays in memory
   * for the next write or `flush`, and the failed attempt counts as that agent's write, so the next
   * one is tried a minute later, not on every call of a busy agent (fix round 3).
   */
  touch(agentId: string, now: number): boolean {
    if (!this.agents.some((a) => a.agentId === agentId)) return false
    this.agents = this.agents.map((a) => (a.agentId === agentId ? { ...a, lastCallAt: now } : a))
    this.callsUnsaved = true
    if (now - (this.lastCallWrite.get(agentId) ?? Number.NEGATIVE_INFINITY) >= LAST_CALL_WRITE_MS) {
      this.lastCallWrite.set(agentId, now)
      this.save(this.agents)
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

  /**
   * Ends the pairing, for the daemon to run before it stops (fix round 4). Every request still open
   * ends at `now`: a pending one as `expired`, a confirmed one as `claim_expired`, each with its
   * notice dated `now` with the cause `stopped`, and its row kept for the page like any ended one (a
   * request already past its deadline ends at that deadline, as always, with the cause `timeout`).
   * Then the last calls are flushed; a flush that fails throws PairingStoreError, and the requests
   * stay ended. After the close a request is refused as `closed`; a claim for a request the close
   * ended is told `stopped` (fix round 5), one that ended before keeps its own reason, and both turn
   * `unknown` after EXPIRED_SHOWN_MS; a confirm and a decline find nothing; list, verify, touch,
   * revoke and flush still work. A second close only flushes.
   */
  close(now: number): void {
    if (!this.closed) {
      this.sweep(now)
      this.closed = true
      for (const entry of [...this.byHandle.values()]) this.end(entry, now, 'stopped')
    }
    this.flush()
  }

  request(agentName: string, now: number): { requestId: string; code: string; expiresAt: number } | { refused: RequestRefusal } {
    if (this.closed) return { refused: 'closed' }
    const refused = checkAgentName(agentName)
    if (refused !== null) return { refused }
    // The name the page shows, the notices carry and the store keeps is the NFC form the rules checked.
    const name = agentName.normalize('NFC')
    this.sweep(now)
    if (this.byHandle.size >= MAX_PENDING) return { refused: 'too_many_pending' }
    this.created = this.created.filter((at) => now - at < 60_000)
    if (this.created.length >= MAX_NEW_PER_MINUTE) return { refused: 'too_many_requests' }
    this.created.push(now)
    const entry: Entry = {
      requestId: this.hex(16),
      handle: this.hex(8),
      name,
      code: this.code(),
      createdAt: now,
      confirmedAt: null,
    }
    this.byRequestId.set(entry.requestId, entry)
    this.byHandle.set(entry.handle, entry)
    this.notify({ kind: 'requested', handle: entry.handle, name: entry.name, at: now })
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
    return this.declineEntry(this.byHandle.get(handle), now)
  }

  /**
   * The agent's claim, by its request id: the key once the person confirmed, `pending` before that,
   * and otherwise the reason it gets none (`ClaimRefusal`). A claim never makes a new request.
   */
  claim(requestId: string, now: number): { key: string } | { pending: true } | { refused: ClaimRefusal } {
    // After a close no request waits, so every id ends in the refusals below (or is unknown).
    this.sweep(now)
    const entry = this.byRequestId.get(requestId)
    if (entry === undefined) return { refused: this.refusals.get(sha256(requestId))?.refused ?? 'unknown' }
    if (entry.confirmedAt === null) return { pending: true }
    const key = this.hex(32)
    const agent: StoredAgent = { agentId: this.hex(8), name: entry.name, pairedAt: now, lastCallAt: null, keyHash: sha256(key) }
    // The key is given out only once the store holds its hash.
    this.save([...this.agents, agent])
    this.forget(entry, 'claimed', now)
    this.notify({ kind: 'paired', handle: entry.handle, agentId: agent.agentId, name: agent.name, at: now })
    return { key }
  }

  /**
   * Removes the agent's access and gives back the record it removed, or null when there was none;
   * the 'revoked' notice carries the same agent id, so the daemon can close its tasks and windows,
   * and `now` as its time.
   */
  revoke(agentId: string, now: number): AgentRecord | null {
    const agent = this.agents.find((a) => a.agentId === agentId)
    if (agent === undefined) return null
    this.save(this.agents.filter((a) => a !== agent))
    this.lastCallWrite.delete(agent.agentId)
    this.notify({ kind: 'revoked', agentId: agent.agentId, name: agent.name, at: now })
    return record(agent)
  }

  list(now: number): { requests: PublicRequest[]; agents: AgentRecord[] } {
    this.sweep(now)
    const waiting = [...this.byHandle.values()]
    const live = waiting.map((entry): PublicRequest => {
      const sameNameAgents = this.agents
        .filter((agent) => namesLookAlike(agent.name, entry.name))
        .map(({ agentId, name }) => ({ agentId, name }))
      return {
        handle: entry.handle,
        name: entry.name,
        code: entry.code,
        createdAt: entry.createdAt,
        expiresAt: deadline(entry),
        state: entry.confirmedAt === null ? 'pending' : 'confirmed',
        confirmedAt: entry.confirmedAt,
        duplicateName: waiting.some((other) => other !== entry && namesLookAlike(other.name, entry.name)),
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
    this.notify({ kind: 'confirmed', handle: entry.handle, name: entry.name, at: now })
    return true
  }

  private declineEntry(entry: Entry | undefined, now: number): boolean {
    if (entry === undefined) return false
    this.forget(entry, 'declined', now)
    this.notify({ kind: 'declined', handle: entry.handle, name: entry.name, at: now })
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
      this.end(entry, endedAt, 'timeout')
    }
    for (const row of [...this.ended.values()]) {
      if (now - row.endedAt >= EXPIRED_SHOWN_MS) this.ended.delete(row.handle)
    }
    for (const [idHash, { endedAt }] of [...this.refusals]) {
      if (now - endedAt >= EXPIRED_SHOWN_MS) this.refusals.delete(idHash)
    }
  }

  /**
   * Ends a waiting request at `endedAt`, nobody having declined or claimed it: `expired` when never
   * confirmed, `claim_expired` when confirmed. The page keeps a row without the request id. A claim
   * is told the kind for a timeout and `stopped` for a close.
   */
  private end(entry: Entry, endedAt: number, cause: EndCause): void {
    const kind = entry.confirmedAt === null ? 'expired' : 'claim_expired'
    this.forget(entry, cause === 'stopped' ? 'stopped' : kind, endedAt)
    const { handle, name, code, createdAt, confirmedAt } = entry
    this.ended.set(handle, { handle, name, code, createdAt, confirmedAt, endedAt })
    this.notify({ kind, handle, name, at: endedAt, cause })
  }

  /** Ends a request: its id is dropped, and only the id's SHA-256 is kept with why it ended. */
  private forget(entry: Entry, refused: Exclude<ClaimRefusal, 'unknown'>, endedAt: number): void {
    this.byRequestId.delete(entry.requestId)
    this.byHandle.delete(entry.handle)
    this.refusals.set(sha256(entry.requestId), { refused, endedAt })
  }

  /**
   * Writes `agents` and only then takes them as the agents in memory; throws PairingStoreError.
   * First the file is checked against what this pairing last read or wrote: a file that changed
   * since is not written over (`changed_on_disk`). The check and the write are two steps, so a
   * change in between them is not seen; the daemon is the store's only writer, and this catches a
   * second daemon or a hand edit made between two operations.
   */
  private save(agents: StoredAgent[]): void {
    if (!sameFingerprint(fingerprintOnDisk(this.file, this.onDisk?.size), this.onDisk)) throw new PairingStoreError(this.file, 'changed_on_disk')
    const content: StoreFile = { schema: SCHEMA, agents }
    const text = `${JSON.stringify(content, null, 2)}\n`
    try {
      atomicWrite(this.file, text, 0o600)
    } catch (error) {
      throw new PairingStoreError(this.file, 'unwritable', { cause: error })
    }
    this.onDisk = fingerprint(Buffer.from(text, 'utf8'))
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

/** The size and SHA-256 of the store's bytes. */
interface Fingerprint {
  readonly size: number
  readonly sha256: string
}

function fingerprint(bytes: Buffer): Fingerprint {
  return { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
}

function sameFingerprint(a: Fingerprint | null, b: Fingerprint | null): boolean {
  return a === null || b === null ? a === b : a.size === b.size && a.sha256 === b.sha256
}

/** The file's bytes, or null when there is no file; PairingStoreError when it cannot be read. */
function readBytes(file: string): Buffer | null {
  try {
    return readFileSync(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new PairingStoreError(file, 'unreadable', { cause: error })
  }
}

/**
 * The fingerprint of what the file holds now, null for no file. A size other than the one last
 * seen is told from the file's metadata alone, without reading what may be a large file.
 */
function fingerprintOnDisk(file: string, expectedSize?: number): Fingerprint | null {
  try {
    const { size } = statSync(file)
    if (expectedSize !== undefined && size !== expectedSize) return { size, sha256: '' }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new PairingStoreError(file, 'unreadable', { cause: error })
  }
  const bytes = readBytes(file)
  return bytes === null ? null : fingerprint(bytes)
}

/**
 * Reads and checks the store. Refused, with the file left as it is: a file that cannot be read
 * (`unreadable`); one over MAX_STORE_BYTES, told by its size before it is read (`not_a_store`); one
 * that is not JSON (`not_json`) or not a pairing store (`not_a_store`); and (`bad_record`) a record of
 * the wrong shape, one agent id twice (a revoke would be ambiguous), one key hash twice (one key
 * would open two agents), or a name `checkAgentName` refuses. That last one also covers names stored
 * under the rules of an earlier round of N-007 that the allowlist of round 4 refuses: this is
 * pre-release code, no store has been installed anywhere, so there is no migration (fix round 4).
 */
function readStore(file: string): { agents: StoredAgent[]; onDisk: Fingerprint | null } {
  let size: number
  try {
    size = statSync(file).size
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { agents: [], onDisk: null }
    throw new PairingStoreError(file, 'unreadable', { cause: error })
  }
  if (size > MAX_STORE_BYTES) throw new PairingStoreError(file, 'not_a_store')
  const bytes = readBytes(file)
  if (bytes === null) return { agents: [], onDisk: null }
  // The file may have grown between the size check and the read.
  if (bytes.length > MAX_STORE_BYTES) throw new PairingStoreError(file, 'not_a_store')
  const text = bytes.toString('utf8')
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
  // One agent id twice would make a revoke and a last call ambiguous (fix round 3).
  if (new Set(agents.map((agent) => agent.agentId)).size !== agents.length) throw new PairingStoreError(file, 'bad_record')
  if (new Set(agents.map((agent) => agent.keyHash)).size !== agents.length) throw new PairingStoreError(file, 'bad_record')
  if (agents.some((agent) => checkAgentName(agent.name) !== null)) throw new PairingStoreError(file, 'bad_record')
  return { agents, onDisk: fingerprint(bytes) }
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
