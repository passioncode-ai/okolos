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
 *
 * Every method that takes `now` (ms since the epoch) throws a TypeError before it acts unless `now` is
 * a safe integer >= 0 (fix round 6): the store refuses any other time at open, so it is never written.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'

import { atomicWrite } from '../fabric/fabric-service.mjs'
import type { ServiceDirs } from '../service/dirs.js'
import { checkAgentName, isStorableName, namesLookAlike, type NameRefusal } from './name.js'

/** The pairing store: the one place a key's SHA-256 lives, in the service data folder. */
export function pairingStoreFile(dirs: ServiceDirs): string {
  return path.join(dirs.data, 'pairings.json')
}

/**
 * The pairing store cannot be read, holds something that is not a pairing store, or cannot be
 * written. A store that cannot be opened pairs and checks nothing until it is fixed (SCR-23, error
 * state), and the file is never overwritten. A write that fails (`unwritable`, `too_large`) changes
 * nothing: the file and the agents in memory stay as they were. A file changed on disk since this
 * pairing last read or wrote it (another daemon, a hand edit, a restore) is read again with the
 * checks of the open (fix round 5): a valid one is taken as it is, an invalid one is refused with
 * the reason the open would give it, and nothing is written over it.
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

export type StoreRefusal = 'unreadable' | 'not_json' | 'not_a_store' | 'bad_record' | 'unwritable' | 'too_large'

/**
 * A store file larger than this is not opened (`not_a_store`, fix round 4): a pairing is about 200
 * bytes, so this holds thousands, and a larger file is not one the daemon wrote. Nor is one written
 * (`too_large`, fix round 5): a write whose text would be larger throws and leaves the file and the
 * agents in memory as they were, so the daemon never writes a store it would refuse to open.
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
  /**
   * Hears that the store was read again because it changed on disk and the pairing took what it
   * holds now (fix round 5), for the service log. No notice is sent for it. A handler that throws is
   * ignored: the reload stands.
   */
  onReload?: () => void
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
  /** What stat said of the file then; null for no file, or when unknown (fix round 5). */
  private seen: StatMark | null
  private readonly onReload: () => void
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

  private constructor(file: string, store: Snapshot, options: PairingOptions) {
    this.file = file
    this.agents = store.agents
    this.onDisk = store.onDisk
    this.seen = store.seen
    const onReload = options.onReload ?? (() => {})
    this.onReload = () => {
      try {
        onReload()
      } catch {
        // A log that cannot take the line does not undo the reload.
      }
    }
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

  /**
   * The agent a key belongs to, or null. Every stored hash is compared, in constant time. First the
   * file is looked at (stat: inode, size, mtime, ctime); when it changed, it is read again like at a
   * write (fix round 5), so a revoke another process wrote is seen here; a store that no longer
   * opens throws PairingStoreError, and no key is taken until it is fixed.
   */
  verify(key: string): AgentRecord | null {
    this.sync(false)
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
   * one is tried a minute later, not on every call of a busy agent (fix round 3). A write runs
   * against the file as it is now (fix round 5); when the agent is no longer in it, the answer is
   * false and nothing is written.
   */
  touch(agentId: string, now: number): boolean {
    checkClock(now, 'touch')
    if (!this.agents.some((a) => a.agentId === agentId)) return false
    this.agents = this.agents.map((a) => (a.agentId === agentId ? { ...a, lastCallAt: now } : a))
    this.callsUnsaved = true
    if (now - (this.lastCallWrite.get(agentId) ?? Number.NEGATIVE_INFINITY) >= LAST_CALL_WRITE_MS) {
      this.lastCallWrite.set(agentId, now)
      this.sync(true)
      if (!this.agents.some((a) => a.agentId === agentId)) return false
      this.save(this.agents)
    }
    return true
  }

  /**
   * Writes every last call that is still in memory only, for the daemon to run before it stops;
   * writes nothing when there is none. A write that fails throws PairingStoreError and keeps them.
   */
  flush(): void {
    if (!this.callsUnsaved) return
    this.sync(true)
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
    checkClock(now, 'close')
    if (!this.closed) {
      this.sweep(now)
      this.closed = true
      for (const entry of [...this.byHandle.values()]) this.end(entry, now, 'stopped')
    }
    this.flush()
  }

  request(agentName: string, now: number): { requestId: string; code: string; expiresAt: number } | { refused: RequestRefusal } {
    checkClock(now, 'request')
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
    checkClock(now, 'confirmByHandle')
    this.sweep(now)
    return this.confirmEntry(this.byHandle.get(handle), now)
  }

  /** The person's decline, by handle only, like the confirm. An ended request stays an expired row. */
  declineByHandle(handle: string, now: number): boolean {
    checkClock(now, 'declineByHandle')
    this.sweep(now)
    return this.declineEntry(this.byHandle.get(handle), now)
  }

  /**
   * The agent's claim, by its request id: the key once the person confirmed, `pending` before that,
   * and otherwise the reason it gets none (`ClaimRefusal`). A claim never makes a new request.
   */
  claim(requestId: string, now: number): { key: string } | { pending: true } | { refused: ClaimRefusal } {
    checkClock(now, 'claim')
    // After a close no request waits, so every id ends in the refusals below (or is unknown).
    this.sweep(now)
    const entry = this.byRequestId.get(requestId)
    if (entry === undefined) return { refused: this.refusals.get(sha256(requestId))?.refused ?? 'unknown' }
    if (entry.confirmedAt === null) return { pending: true }
    this.sync(true)
    // An id or a key already in the store is drawn again: the store would not open with it twice
    // (fix round 5; with real randomness this never repeats, with a seeded source it can).
    let key: string
    do key = this.hex(32)
    while (this.agents.some((a) => a.keyHash === sha256(key)))
    let agentId: string
    do agentId = this.hex(8)
    while (this.agents.some((a) => a.agentId === agentId))
    const agent: StoredAgent = { agentId, name: entry.name, pairedAt: now, lastCallAt: null, keyHash: sha256(key) }
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
    checkClock(now, 'revoke')
    this.sync(true)
    const agent = this.agents.find((a) => a.agentId === agentId)
    if (agent === undefined) return null
    this.save(this.agents.filter((a) => a !== agent))
    this.lastCallWrite.delete(agent.agentId)
    this.notify({ kind: 'revoked', agentId: agent.agentId, name: agent.name, at: now })
    return record(agent)
  }

  /**
   * The page's view. Like `verify`, it first looks at the file and reads it again when it changed
   * (fix round 5), so an agent revoked by another process leaves the page at the next list; a store
   * that no longer opens throws PairingStoreError, and the page shows its error state.
   */
  list(now: number): { requests: PublicRequest[]; agents: AgentRecord[] } {
    checkClock(now, 'list')
    this.sync(false)
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
   * Looks at the file and, when it is not what this pairing last read or wrote, reads it again with
   * the checks of the open (fix round 5). A valid file is taken as it is (`adopt`); an invalid one
   * throws PairingStoreError with the reason the open gives it, and memory stays as it was. `full`,
   * before a write: the bytes are compared even when stat says nothing changed, for a file system
   * whose times are too coarse to tell an edit made within the same tick; a verify trusts stat.
   */
  private sync(full: boolean): void {
    const unchanged = sameMark(statMark(this.file), this.seen) && (!full || sameFingerprint(fingerprintOnDisk(this.file, this.onDisk?.size), this.onDisk))
    if (unchanged) return
    const store = readStore(this.file)
    if (sameFingerprint(store.onDisk, this.onDisk)) {
      this.seen = store.seen
      return
    }
    this.adopt(store)
  }

  /**
   * Takes the agents the file holds now in place of those in memory. A last call held in memory
   * only is kept when it is newer than the file's and the agent is still there under the same key:
   * the file cannot know it, and the next write or `flush` saves it.
   */
  private adopt(store: Snapshot): void {
    const mine = new Map(this.agents.map((agent) => [agent.agentId, agent]))
    let unsaved = false
    this.agents = store.agents.map((agent) => {
      const held = mine.get(agent.agentId)
      if (held === undefined || held.keyHash !== agent.keyHash || held.lastCallAt === null) return agent
      if (agent.lastCallAt !== null && agent.lastCallAt >= held.lastCallAt) return agent
      unsaved = true
      return { ...agent, lastCallAt: held.lastCallAt }
    })
    this.callsUnsaved = unsaved
    this.onDisk = store.onDisk
    this.seen = store.seen
    for (const agentId of [...this.lastCallWrite.keys()]) {
      if (!this.agents.some((agent) => agent.agentId === agentId)) this.lastCallWrite.delete(agentId)
    }
    this.onReload()
  }

  /**
   * Writes `agents` and only then takes them as the agents in memory; throws PairingStoreError. The
   * caller runs `sync(true)` first in the same call and builds `agents` from what it found, so a
   * change made on disk before the operation is kept. The read and the write are two steps, so a
   * change in between them is not seen; the daemon is the store's only writer.
   */
  private save(agents: StoredAgent[]): void {
    // Only the known fields are written, whatever the objects carry (fix round 5).
    const content: StoreFile = {
      schema: SCHEMA,
      agents: agents.map(({ agentId, name, pairedAt, lastCallAt, keyHash }) => ({ agentId, name, pairedAt, lastCallAt, keyHash })),
    }
    const text = `${JSON.stringify(content, null, 2)}\n`
    if (Buffer.byteLength(text, 'utf8') > MAX_STORE_BYTES) throw new PairingStoreError(this.file, 'too_large')
    try {
      atomicWrite(this.file, text, 0o600)
    } catch (error) {
      throw new PairingStoreError(this.file, 'unwritable', { cause: error })
    }
    this.onDisk = fingerprint(Buffer.from(text, 'utf8'))
    try {
      this.seen = statMark(this.file)
    } catch {
      // Unknown: the next look reads the bytes and finds them the same.
      this.seen = null
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

/** What stat says of the file, enough to tell a change without reading it (fix round 5). */
interface StatMark {
  readonly ino: bigint
  readonly size: bigint
  readonly mtimeNs: bigint
  readonly ctimeNs: bigint
}

/** The store as read: its agents, the fingerprint of its bytes and its stat; all empty for no file. */
interface Snapshot {
  readonly agents: StoredAgent[]
  readonly onDisk: Fingerprint | null
  readonly seen: StatMark | null
}

/** The file's stat, null when there is no file; PairingStoreError when it cannot be looked at. */
function statMark(file: string): StatMark | null {
  try {
    const { ino, size, mtimeNs, ctimeNs } = statSync(file, { bigint: true })
    return { ino, size, mtimeNs, ctimeNs }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new PairingStoreError(file, 'unreadable', { cause: error })
  }
}

function sameMark(a: StatMark | null, b: StatMark | null): boolean {
  return a === null || b === null ? a === b : a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs
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
 * that is not JSON (`not_json`) or not a pairing store, a top-level field other than `schema` and
 * `agents` included (`not_a_store`); and (`bad_record`) a record that is not exactly `agentId` (16
 * lowercase hex), `name`, `pairedAt` and `lastCallAt` (non-negative integer ms, `lastCallAt` or
 * null) and `keyHash` (64 lowercase hex), with no other field (a write would drop it, fix round 5);
 * one agent id twice (a revoke would be ambiguous); one key hash twice (one key would open two
 * agents); or a name the store rule refuses (`isStorableName`). The store rule is looser than the
 * request rule on purpose, so an agent paired under an earlier rule keeps its access (fix round 5).
 */
function readStore(file: string): Snapshot {
  const seen = statMark(file)
  if (seen === null) return { agents: [], onDisk: null, seen: null }
  if (seen.size > BigInt(MAX_STORE_BYTES)) throw new PairingStoreError(file, 'not_a_store')
  const bytes = readBytes(file)
  // Removed between the stat and the read: an empty store, looked at again next time.
  if (bytes === null) return { agents: [], onDisk: null, seen: null }
  // The file may have grown between the size check and the read.
  if (bytes.length > MAX_STORE_BYTES) throw new PairingStoreError(file, 'not_a_store')
  const text = bytes.toString('utf8')
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new PairingStoreError(file, 'not_json', { cause: error })
  }
  if (!isRecord(value) || !sameKeys(value, STORE_FIELDS) || value['schema'] !== SCHEMA || !Array.isArray(value['agents'])) {
    throw new PairingStoreError(file, 'not_a_store')
  }
  const agents = value['agents'] as unknown[]
  if (!agents.every(isStoredAgent)) throw new PairingStoreError(file, 'bad_record')
  // One agent id twice would make a revoke and a last call ambiguous (fix round 3).
  if (new Set(agents.map((agent) => agent.agentId)).size !== agents.length) throw new PairingStoreError(file, 'bad_record')
  if (new Set(agents.map((agent) => agent.keyHash)).size !== agents.length) throw new PairingStoreError(file, 'bad_record')
  return { agents, onDisk: fingerprint(bytes), seen }
}

/** The record the page and the door see; the key's hash stays in the store. */
function record({ agentId, name, pairedAt, lastCallAt }: StoredAgent): AgentRecord {
  return { agentId, name, pairedAt, lastCallAt }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const STORE_FIELDS = ['agents', 'schema'] as const
const RECORD_FIELDS = ['agentId', 'keyHash', 'lastCallAt', 'name', 'pairedAt'] as const

/** The object has exactly these fields, no more and no fewer. */
function sameKeys(value: Record<string, unknown>, fields: readonly string[]): boolean {
  const keys = Object.keys(value)
  return keys.length === fields.length && fields.every((field) => Object.hasOwn(value, field))
}

/** A time the store keeps: whole ms since the epoch, not negative. */
function isTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/**
 * Refuses a clock the store would refuse at open (fix round 6): every method that takes `now` runs
 * this first, before it acts, so no time but a whole non-negative ms is ever kept or written.
 */
function checkClock(now: number, method: string): void {
  if (!isTime(now)) throw new TypeError(`Pairing.${method}: now must be a safe integer >= 0, got ${String(now)}`) // i18n-exempt: a programming error in the daemon, thrown to its caller, never shown to a person
}

function isStoredAgent(value: unknown): value is StoredAgent {
  return (
    isRecord(value) &&
    sameKeys(value, RECORD_FIELDS) &&
    typeof value['agentId'] === 'string' &&
    /^[0-9a-f]{16}$/.test(value['agentId']) &&
    isStorableName(value['name']) &&
    isTime(value['pairedAt']) &&
    (value['lastCallAt'] === null || isTime(value['lastCallAt'])) &&
    typeof value['keyHash'] === 'string' &&
    /^[0-9a-f]{64}$/.test(value['keyHash'])
  )
}

function sha256(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex')
}
