/**
 * The agents' journal of Okolos Agent: every answer an agent gets is written here first.
 *
 * ADR-0019 promises the person that everything an agent received through the bridge is in the
 * journal. So an answer is recorded (appended and fsynced) before it is sent, and an answer the
 * journal could not record is not sent at all: the agent gets the `internal` refusal instead.
 * `answerAfterRecord` is the one wrapper that does this; the door (N-008) sends every answer to
 * a tool call, its own refusals and parse errors included, through it.
 *
 * MCP protocol answers are not journaled (one decision for N-006 and N-008). `initialize`,
 * `tools/list`, `ping` and notifications name no verb of the contract, reach no page and carry
 * nothing of one, so the journal has no protocol verb (`mcp.initialize` and the like are refused
 * as any other unknown verb). Only `tools/call` is journaled, and so is every request the door
 * could not take from a paired agent: a body that does not parse, an unknown tool or wrong
 * arguments is one entry, `refused` with the journal code `bad_call`, its verb `unknown` when
 * the tool is no verb's (`journalVerbOf`). A parse error is written that one way only.
 *
 * What an entry holds is closed: who asked (the paired agent's name, id and the date it was given
 * access, and its task), which verb, which origin, how it ended, the refusal code, the size of
 * the answer and the snapshot's verdict level. Never the text of a page and never the value of a
 * field: an entry with any other member is refused by its type and again at run time, before
 * anything is written.
 *
 * Layout: JSON lines under `<data>/journal/`, one file per UTC day (`2026-10-27.jsonl`), each
 * 0600 in a 0700 folder. The retention sweep drops whole days past the window and rewrites the
 * one day that straddles it.
 *
 * Durability: every append is fsynced, and the folder is fsynced once when a day file is created,
 * so the new file's name survives a power loss too. On macOS fsync(2) does not ask the drive to
 * flush its own cache (that is F_FULLFSYNC, which Node does not expose); the journal relies on
 * fsync as every other store of the daemon does. Appends run one at a time, in the order they were
 * asked for. A write the disk takes only in part is written on until the line is whole; when the
 * disk stops taking it (or the fsync fails), the bytes that reached the file are cut back off, so
 * the journal never holds an entry for an answer that was not sent. A line is an entry only when
 * it ends in a newline: a last line without one was never fsynced whole and is counted unreadable,
 * and the next append seals it (TORN_SEAL) so a newline cannot turn it into an entry afterwards.
 *
 * Volume (decision 2026-10-27, door rejections must be bounded): any local page can make the door
 * reject requests, so `rejected` lines are bounded twice. Repeats of one rejection (same code and
 * origin) within COALESCE_WINDOW_MS of the first are one line plus one `count` line; and a day holds
 * at most REJECTED_LINES_PER_DAY `rejected` lines, after which one `cap_reached` line is written and
 * further rejections that day are dropped and counted in memory (`droppedRejections`). Agent entries
 * (`answered`, `refused`) are never coalesced and never capped.
 */
import { mkdirSync, readdirSync, readFileSync, unlinkSync } from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'
import path from 'node:path'

import {
  BRIDGE_REFUSALS,
  BRIDGE_SESSION_VERBS,
  BRIDGE_VERBS,
  canonicalVerb,
  originOf,
  refuse,
  type AnyBridgeVerb,
  type BridgeRefusal,
} from '@okolos/contracts'

import { atomicWrite } from '../fabric/fabric-service.mjs'
import { isStorableName } from '../pairing/name.js'
import type { RefusalReason } from '../service/http.js'

/**
 * Days an entry is kept: the window of the extension's own journal (`RETENTION_DAYS.journal` in
 * @okolos/storage), so the person is told one number. The daemon does not import the extension's
 * storage package; the test holds the two equal.
 */
export const RETENTION_DAYS_JOURNAL = 90

const DAY_MS = 24 * 60 * 60 * 1000
const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/

/**
 * Repeats of a door rejection (same code, same stored origin) that come within this long of the
 * first are not written one by one: the first is a line at once, and the repeats become one line
 * carrying their `count` when the window closes. The window closes at the next entry that is not
 * such a repeat, at `sweep`, or at `close`.
 */
export const COALESCE_WINDOW_MS = 60_000

/**
 * The most `rejected` lines one UTC day holds (first lines and count lines alike). The next
 * rejection that day writes one `cap_reached` line instead, and every later one is dropped and
 * counted in memory. With origins bounded to MAX_ORIGIN_LENGTH a rejected line is under 400 bytes,
 * so a day of rejections stays under 0.8 MB however many requests a page sends, and the 90 days
 * the journal keeps stay under 72 MB (LC-12: every file bounded; decision 2026-10-27, N-006 round 2).
 */
export const REJECTED_LINES_PER_DAY = 2_000

/**
 * The longest origin an entry stores: `https://`, a 253-character host (the most DNS allows) and
 * `:65535`. A door rejection's longer Origin is stored as OPAQUE_ORIGIN; an agent call's is refused.
 */
export const MAX_ORIGIN_LENGTH = 'https://'.length + 253 + ':65535'.length

/**
 * What the next append writes after a last line that has no newline (a write cut short, a crash),
 * before the newline that ends it. It cannot complete a JSON object, inside a string or outside
 * one, so the cut line stays one unreadable line and never becomes an entry.
 */
const TORN_SEAL = ' ~torn~'

/** A task id as the tasks give it: 128 random bits, lower-case hex (SessionOpenResult.sessionId). */
const TASK_ID = /^[0-9a-f]{32}$/

/** An agent id as pairing gives it: 64 random bits, lower-case hex. */
const AGENT_ID = /^[0-9a-f]{16}$/

/**
 * Why the door turned a request away before it knew the agent: the shell's reasons, a body that
 * is not JSON, and an access list that could not be read (so the key was not checked).
 */
export type DoorRejection = RefusalReason | 'bad_content_type' | 'store_unreadable'

/** What a caller records a `rejected` entry with: a door rejection, or a key that matches no paired agent. */
export type RejectionCode = DoorRejection | Extract<BridgeRefusal, 'not_paired'>

/**
 * The line the journal writes, once a UTC day, when that day's REJECTED_LINES_PER_DAY is reached.
 * Only the journal writes it; a caller that records it is refused. The page owes it a
 * `rejection_cap_reached` line.
 */
export const CAP_REACHED = 'cap_reached'

/** What a stored `rejected` line carries: a caller's RejectionCode, or the journal's own CAP_REACHED. */
export type StoredRejectionCode = RejectionCode | typeof CAP_REACHED

/**
 * Keyed by RejectionCode, so a reason the shell adds to RefusalReason later is a missing key here
 * and the build fails, instead of the journal refusing the rejection at run time.
 */
const REJECTION_CODE_SET: Readonly<Record<RejectionCode, true>> = {
  bad_host: true,
  bad_origin: true,
  cross_site: true,
  bad_request: true,
  stopping: true,
  bad_content_type: true,
  store_unreadable: true,
  not_paired: true,
}

/** Every rejection code a caller records; the page has a `rejection_<code>` line for each. */
export const REJECTION_CODES: readonly RejectionCode[] = Object.freeze(Object.keys(REJECTION_CODE_SET) as RejectionCode[])

/** Every code a stored `rejected` line may carry: REJECTION_CODES and CAP_REACHED. */
export const STORED_REJECTION_CODES: readonly StoredRejectionCode[] = Object.freeze([...REJECTION_CODES, CAP_REACHED])

/**
 * What a `rejected` entry stores for an Origin header that is no http(s) origin: `null` (a
 * sandboxed frame, a file), an extension's origin, or anything else. The header itself is never
 * stored: it is whatever the caller sent.
 */
export const OPAQUE_ORIGIN = 'opaque'

/**
 * Codes only the journal has, beside the contract's refusals, in `refused` entries:
 * `bad_call` is a call the door could not take (a body that does not parse, an unknown tool,
 * wrong arguments); `local_answer` is a site in the task that answered from an address on this
 * device or the local network. The page has a `refusal_<code>` line for each.
 */
export const JOURNAL_REFUSAL_CODES = ['bad_call', 'local_answer'] as const
export type JournalRefusalCode = (typeof JOURNAL_REFUSAL_CODES)[number]

/** The verb an entry names: a canonical verb of the contract, or `unknown` for a `bad_call`. */
export type JournalVerb = AnyBridgeVerb | 'unknown'

/**
 * The verb to journal for an MCP tool name: its canonical spelling (`session_open` is
 * `session.open`), or `unknown` for a name that is no verb's tool. The door journals what this
 * returns, so the journal and the page never see a tool name.
 */
export function journalVerbOf(tool: string): JournalVerb {
  return canonicalVerb(tool) ?? 'unknown'
}

/** The level of the snapshot's verdict (`SnapshotVerdict['level']`); its findings stay out. */
export type JournalVerdict = 'clean' | 'finding'

/** A call a paired agent made: answered, or refused by the bridge's policy. */
interface AgentCall {
  /** When the answer was recorded: `journalTime(ms)` (the second-precision `nowIso()` form is taken too). */
  readonly at: string
  /** The paired agent, by the name it was paired under (`isStorableName`). Two agents may share it. */
  readonly agent: string
  /** The paired agent's id, 16 lower-case hex: what tells two agents of the same name apart. */
  readonly agentId: string
  /** When the agent was given access, `journalTime(record.pairedAt)`: the page names a revoked agent by it. */
  readonly pairedAt: string
  /** The task's id, 32 lower-case hex. */
  readonly task?: string
  /** The origin the call reached: scheme, host and port, no path and no query, at most MAX_ORIGIN_LENGTH. */
  readonly origin?: string
  /** The size of the answer sent, in bytes. */
  readonly bytes?: number
  readonly verdict?: JournalVerdict
}

export type JournalEntry =
  | (AgentCall & { readonly outcome: 'answered'; readonly verb: AnyBridgeVerb })
  | (AgentCall & {
      readonly outcome: 'refused'
      readonly verb: AnyBridgeVerb
      readonly code: BridgeRefusal | JournalRefusalCode
    })
  | (AgentCall & { readonly outcome: 'refused'; readonly verb: 'unknown'; readonly code: 'bad_call' })
  | {
      /** A request the door turned away before it knew the agent or the verb. */
      readonly at: string
      readonly outcome: 'rejected'
      readonly code: RejectionCode
      /**
       * The request's Origin header as the door got it. It is stored through `originOf` (scheme
       * and host lower-cased, no path), or as OPAQUE_ORIGIN when it is no http(s) origin or longer
       * than MAX_ORIGIN_LENGTH, so a rejection is journaled whatever the header held. Read back, it
       * is always one of the two.
       */
      readonly origin?: string | null
      readonly bytes?: number
    }

/**
 * A `rejected` line as the journal stores it and reads it back: the caller's entry with its origin
 * normalised, a line carrying the `count` of repeats a coalescing window took in (its `at` is the
 * last repeat's), or the journal's own CAP_REACHED line.
 */
export interface RejectedLine {
  readonly at: string
  readonly outcome: 'rejected'
  readonly code: StoredRejectionCode
  readonly origin?: string
  readonly bytes?: number
  /** How many rejections this line stands for, when it closes a coalescing window; a line without it stands for one. */
  readonly count?: number
}

/** A line of the journal as it is read back: an agent entry, or a stored rejected line. */
export type JournalLine = Exclude<JournalEntry, { readonly outcome: 'rejected' }> | RejectedLine

/** Members each outcome may carry, in the order they are written. */
const FIELDS = {
  answered: ['at', 'agent', 'agentId', 'pairedAt', 'task', 'verb', 'origin', 'outcome', 'bytes', 'verdict'],
  refused: ['at', 'agent', 'agentId', 'pairedAt', 'task', 'verb', 'origin', 'outcome', 'code', 'bytes', 'verdict'],
  rejected: ['at', 'outcome', 'code', 'origin', 'bytes'],
} as const satisfies Record<JournalEntry['outcome'], readonly string[]>

/** What a stored `rejected` line may carry beside a caller's members: the journal's own count. */
const STORED_REJECTED_FIELDS: readonly string[] = [...FIELDS.rejected, 'count']

/**
 * An entry the journal will not write. The message names the member that is wrong or not allowed
 * (`text`, `origin`, `outcome`), never its value: the value may be the very page text the journal
 * keeps out.
 */
export class InvalidJournalEntry extends TypeError {
  constructor(readonly field: string) {
    // i18n-exempt: a programming error inside the daemon, read in its log by a developer, never shown to the person
    super(`journal entry refused at field: ${field}`)
    this.name = 'InvalidJournalEntry'
  }
}

/**
 * The entry as it is written, with its members in a fixed order and its times in the one form
 * `journalTime` gives, or InvalidJournalEntry naming the first member that is not allowed or not
 * valid. A caller's entry may not carry `count` or CAP_REACHED: those are the journal's own.
 */
export function checkEntry(input: JournalEntry): JournalLine {
  return checkLine(input, false)
}

/** checkEntry for a caller's entry (`stored` false), or for a line read back from disk (`stored` true). */
function checkLine(input: unknown, stored: boolean): JournalLine {
  const raw = input as Record<string, unknown>
  if (typeof raw !== 'object' || raw === null) throw new InvalidJournalEntry('entry')
  const outcome = raw.outcome
  if (outcome !== 'answered' && outcome !== 'refused' && outcome !== 'rejected') throw new InvalidJournalEntry('outcome')
  const allowed: readonly string[] = stored && outcome === 'rejected' ? STORED_REJECTED_FIELDS : FIELDS[outcome]
  for (const key of Object.keys(raw)) if (!allowed.includes(key)) throw new InvalidJournalEntry(key)
  const at = journalTimeOf(raw.at)
  if (at === null) throw new InvalidJournalEntry('at')
  // A door rejection is journaled whatever Origin it carried, so its origin is normalised; an
  // agent call's origin comes from the bridge's own checks and must already be in originOf form.
  const origin = outcome === 'rejected' && raw.origin !== undefined ? rejectedOrigin(raw.origin) : raw.origin
  if (
    outcome !== 'rejected' &&
    origin !== undefined &&
    (typeof origin !== 'string' || origin.length > MAX_ORIGIN_LENGTH || originOf(origin) !== origin)
  ) {
    throw new InvalidJournalEntry('origin')
  }
  if (raw.bytes !== undefined && (!Number.isSafeInteger(raw.bytes) || (raw.bytes as number) < 0)) {
    throw new InvalidJournalEntry('bytes')
  }
  const fixed: Record<string, unknown> = { at, origin }
  if (outcome === 'rejected') {
    if (!includes(stored ? STORED_REJECTION_CODES : REJECTION_CODES, raw.code)) throw new InvalidJournalEntry('code')
    if (raw.count !== undefined && (!Number.isSafeInteger(raw.count) || (raw.count as number) < 1)) {
      throw new InvalidJournalEntry('count')
    }
  } else {
    if (!isStorableName(raw.agent)) throw new InvalidJournalEntry('agent')
    if (typeof raw.agentId !== 'string' || !AGENT_ID.test(raw.agentId)) throw new InvalidJournalEntry('agentId')
    const pairedAt = journalTimeOf(raw.pairedAt)
    if (pairedAt === null) throw new InvalidJournalEntry('pairedAt')
    fixed.pairedAt = pairedAt
    if (raw.task !== undefined && (typeof raw.task !== 'string' || !TASK_ID.test(raw.task))) throw new InvalidJournalEntry('task')
    if (raw.verdict !== undefined && raw.verdict !== 'clean' && raw.verdict !== 'finding') {
      throw new InvalidJournalEntry('verdict')
    }
    if (outcome === 'refused' && !includes(BRIDGE_REFUSALS, raw.code) && !includes(JOURNAL_REFUSAL_CODES, raw.code)) {
      throw new InvalidJournalEntry('code')
    }
    // `unknown` is the verb of a call the door could not take, and of nothing else.
    const known = includes(BRIDGE_VERBS, raw.verb) || includes(BRIDGE_SESSION_VERBS, raw.verb)
    if (!known && !(raw.verb === 'unknown' && raw.code === 'bad_call')) throw new InvalidJournalEntry('verb')
  }
  const written: Record<string, unknown> = {}
  for (const key of allowed) {
    const value = key in fixed ? fixed[key] : raw[key]
    if (value !== undefined) written[key] = value
  }
  return written as unknown as JournalLine
}

/**
 * The origin a `rejected` entry stores: `originOf` the header (the contract's one rule), or
 * OPAQUE_ORIGIN for a header that is no http(s) origin. Both map to themselves, so a line read
 * back is checked the same way it was written.
 */
function rejectedOrigin(header: unknown): string {
  if (typeof header !== 'string') return OPAQUE_ORIGIN
  const origin = originOf(header)
  return origin === null || origin.length > MAX_ORIGIN_LENGTH ? OPAQUE_ORIGIN : origin
}

/** The last instant the journal can name a day file for: 9999-12-31T23:59:59.999Z. */
const LAST_MS = 253_402_300_799_999

/**
 * The one form `at` and `pairedAt` are written in: `new Date(ms).toISOString()`
 * (`2026-10-27T10:00:00.000Z`). Callers stamp entries with this, never with a time they format
 * themselves. Throws a TypeError unless `ms` is a safe integer from 0 (1970) to the last
 * millisecond of the year 9999, so a broken clock is caught at the caller and not as an entry.
 */
export function journalTime(ms: number): string {
  if (typeof ms !== 'number' || !Number.isSafeInteger(ms) || ms < 0 || ms > LAST_MS) {
    // i18n-exempt: a programming error inside the daemon, read in its log by a developer, never shown to the person
    throw new TypeError(`journalTime: ms must be a safe integer from 0 to ${LAST_MS}, got ${String(ms)}`)
  }
  return new Date(ms).toISOString()
}

/**
 * `value` in the form journalTime gives, or null. Taken: that form, and the second-precision UTC
 * form `nowIso()` gives the rest of the daemon (`2026-10-27T10:00:00Z`). Each is parsed,
 * re-serialised in its own form and compared, so no free text passes as a date, no impossible day
 * (`02-30`) is rolled over, and every entry lands in a day file the journal lists (1970 to 9999; a
 * year past 9999 would be `+010000-01-01.jsonl`).
 */
function journalTimeOf(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const seconds = SECONDS_TIME.test(value)
  if (!seconds && !MILLIS_TIME.test(value)) return null
  const ms = Date.parse(value)
  if (!(ms >= 0 && ms <= LAST_MS)) return null
  const iso = new Date(ms).toISOString()
  return (seconds ? iso.replace(/\.000Z$/, 'Z') : iso) === value ? iso : null
}

const MILLIS_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const SECONDS_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/

function includes(list: readonly string[], value: unknown): boolean {
  return typeof value === 'string' && list.includes(value)
}

/** Why the journal could not write an entry, from the errno: the `$WHAT$` of `journalError`. */
export type JournalWriteFailure = 'no_space' | 'no_permission' | 'other'

/** Why the journal could not be read, from the errno: the `$WHAT$` of `journalUnreadable`. */
export type JournalReadFailure = 'no_permission' | 'unreadable' | 'other'

export type JournalFailure = JournalWriteFailure | JournalReadFailure

/**
 * The journal could not write or read. `code` is the closed reason the page names; the message
 * names the operation and the code, never a path or an entry, and the errno stays in `cause` for
 * the daemon's log.
 */
export class JournalError<C extends JournalFailure = JournalFailure> extends Error {
  constructor(
    readonly code: C,
    readonly operation: 'write' | 'read' | 'export',
    options?: { cause?: unknown },
  ) {
    super(`journal ${operation} failed: ${code}`, options)
    this.name = 'JournalError'
  }
}

function errnoOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : undefined
}

function writeFailure(error: unknown): JournalWriteFailure {
  switch (errnoOf(error)) {
    case 'ENOSPC':
    case 'EDQUOT':
      return 'no_space'
    case 'EACCES':
    case 'EPERM':
    case 'EROFS':
      return 'no_permission'
    default:
      return 'other'
  }
}

function readFailure(error: unknown): JournalReadFailure {
  switch (errnoOf(error)) {
    case 'EACCES':
    case 'EPERM':
      return 'no_permission'
    case 'ENOENT':
    case 'ENOTDIR':
    case 'EISDIR':
    case 'EIO':
    case 'ELOOP':
      return 'unreadable'
    default:
      return 'other'
  }
}

/** What a sweep removed: entries past the window, and unreadable lines dropped with them. */
export interface SweepResult {
  readonly removed: number
  readonly unreadable: number
}

/** An answer the agent got. */
export type AnsweredEntry = Extract<JournalLine, { readonly outcome: 'answered' }>

/**
 * A refusal: the bridge's policy said no to a paired agent, or the door turned a request away (a
 * RejectedLine, which may carry a `count` or be the day's CAP_REACHED line).
 */
export type RefusalEntry = Exclude<JournalLine, { readonly outcome: 'answered' }>

/** What the page shows of the journal. */
export interface RecentJournal {
  /** The newest answers, oldest first. */
  readonly answers: AnsweredEntry[]
  /** The newest refusals (`refused` and `rejected`), oldest first, counted apart from the answers. */
  readonly refusals: RefusalEntry[]
  /** Lines anywhere in the journal that are not an entry (`journalLinesSkipped`). */
  readonly unreadable: number
}

/** Door rejections dropped in memory after the day's cap was reached: never written anywhere. */
export interface DroppedRejections {
  readonly day: string
  readonly count: number
}

/** An open coalescing window: the first rejection is on disk, `count` repeats are not yet. */
interface Window {
  readonly code: StoredRejectionCode
  readonly origin: string | undefined
  readonly first: number
  last: string
  count: number
}

/** The `rejected` lines of one UTC day, as the cap counts them. */
interface CapDay {
  readonly day: string
  lines: number
  capped: boolean
  dropped: number
}

export class Journal {
  /** The tail of the write queue: appends run one at a time, in the order they were asked for. */
  private tail: Promise<void> = Promise.resolve()
  private window: Window | null = null
  private capDay: CapDay | null = null

  private constructor(
    readonly dir: string,
    readonly retentionDays: number,
  ) {}

  /** Opens the journal in `dir` (`<data>/journal`), creating the folder 0700 when it is missing. */
  static open(dir: string, options: { retentionDays: number }): Journal {
    // A window of NaN or zero days would make the sweep drop every entry.
    if (!Number.isInteger(options.retentionDays) || options.retentionDays < 1) {
      throw new RangeError(`retentionDays: ${String(options.retentionDays)}`)
    }
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    return new Journal(dir, options.retentionDays)
  }

  /**
   * The newest `limit` answers and, apart from them, the newest `limit` refusals, so a stream of
   * answers never pushes a refusal off the page. Reads every day, so `unreadable` counts the bad
   * lines of the whole journal, not of the page. Throws JournalError (no_permission, unreadable,
   * other) when the journal cannot be read. A coalescing window's count is not in it until the
   * window closes.
   */
  recent(limit: number): RecentJournal {
    const answers: AnsweredEntry[] = []
    const refusals: RefusalEntry[] = []
    let unreadable = 0
    for (const day of this.reading(() => this.days()).reverse()) {
      const read = this.reading(() => this.read(day))
      unreadable += read.unreadable
      for (const entry of read.entries.reverse()) {
        if (entry.outcome === 'answered') answers.push(entry)
        else refusals.push(entry)
      }
    }
    const newest = <T>(list: T[]): T[] => (limit <= 0 ? [] : list.slice(0, limit).reverse())
    return { answers: newest(answers), refusals: newest(refusals), unreadable }
  }

  /**
   * The whole journal as JSON lines, oldest first, for GET /api/journal. Every line is an entry
   * checked again on the way out and written with the journal's members only, so a line edited
   * on disk to carry page text is not exported; such lines are left out, as `recent` counts them.
   * Reads only, so its reasons are a read's: throws JournalError (no_permission, unreadable,
   * other), operation `export`, for `journalExportFailed`.
   */
  export(): string {
    let out = ''
    for (const day of this.reading(() => this.days(), 'export')) {
      for (const entry of this.reading(() => this.read(day), 'export').entries) out += `${JSON.stringify(entry)}\n`
    }
    return out
  }

  /**
   * The door rejections dropped since the cap of the day they fell on was reached, or null when
   * none was. Held in memory only, for the current cap day: a restart or a new day starts at zero.
   */
  droppedRejections(): DroppedRejections | null {
    const cap = this.capDay
    return cap === null || cap.dropped === 0 ? null : { day: cap.day, count: cap.dropped }
  }

  /** Runs a read of the journal, turning a failure into a JournalError with its reason. */
  private reading<T>(read: () => T, operation: 'read' | 'export' = 'read'): T {
    try {
      return read()
    } catch (error) {
      throw new JournalError(readFailure(error), operation, { cause: error })
    }
  }

  /**
   * Drops every entry older than the retention window at `now` (ms since the epoch). A day wholly
   * past the window is deleted; the day the window's edge falls in is rewritten atomically
   * without its older entries. The daemon calls this at start and once a day. It also closes an
   * open coalescing window: its count is queued behind the appends already asked for, and a
   * failure to write it keeps the count for the next entry or `close` (it is never thrown here).
   *
   * Returns how many entries went and how many unreadable lines went with them: a deleted day's,
   * and the edge day's when it is rewritten (a line that is not an entry has no time to keep it
   * by). `recent().unreadable` shrinks by exactly that number. Throws a TypeError, before it
   * touches anything, unless `now` is a safe integer >= 0, so a broken clock (NaN) cannot empty
   * the journal; and JournalError when the disk fails: a read's reasons with operation `read`, a
   * delete's or rewrite's with operation `write`.
   */
  sweep(now: number): SweepResult {
    if (typeof now !== 'number' || !Number.isSafeInteger(now) || now < 0) {
      throw new TypeError(`Journal.sweep: now must be a safe integer >= 0, got ${String(now)}`)
    }
    if (this.window !== null) {
      this.enqueue(() => this.closeWindow()).catch(() => undefined)
    }
    const horizon = now - this.retentionDays * DAY_MS
    let removed = 0
    let unreadable = 0
    for (const day of this.reading(() => this.days())) {
      const start = Date.parse(`${day}T00:00:00.000Z`)
      if (start >= horizon) continue
      const read = this.reading(() => this.read(day))
      const file = path.join(this.dir, `${day}.jsonl`)
      if (start + DAY_MS <= horizon) {
        this.writing(() => unlinkSync(file))
        removed += read.entries.length
        unreadable += read.unreadable
        continue
      }
      const kept = read.entries.filter((entry) => Date.parse(entry.at) >= horizon)
      if (kept.length === read.entries.length) continue
      this.writing(() => atomicWrite(file, kept.map((entry) => `${JSON.stringify(entry)}\n`).join(''), 0o600))
      removed += read.entries.length - kept.length
      unreadable += read.unreadable
    }
    return { removed, unreadable }
  }

  /** Runs a change to the journal's files, turning a failure into a JournalError with its reason. */
  private writing<T>(write: () => T): T {
    try {
      return write()
    } catch (error) {
      throw new JournalError(writeFailure(error), 'write', { cause: error })
    }
  }

  /** The days this journal holds a file for, oldest first. */
  private days(): string[] {
    return readdirSync(this.dir)
      .map((name) => DAY_FILE.exec(name)?.[1])
      .filter((day): day is string => day !== undefined)
      .sort()
  }

  /**
   * The entries of one day, and how many of its lines are not one: a line cut short by a power
   * loss or edited by hand is not fatal, and it is counted, not dropped silently. A last line with
   * no newline is never an entry, even when it parses: an append writes its newline last and
   * fsyncs it, so such a line is one whose append did not finish. A day whose file went between
   * listing and reading (the sweep took it) is an empty day.
   */
  private read(day: string): { entries: JournalLine[]; unreadable: number } {
    let text: string
    try {
      text = readFileSync(path.join(this.dir, `${day}.jsonl`), 'utf8')
    } catch (error) {
      if (errnoOf(error) === 'ENOENT') return { entries: [], unreadable: 0 }
      throw error
    }
    const lines = text.split('\n')
    // What follows the last newline: '' for a whole file, else a line whose append did not finish.
    let unreadable = lines.pop() === '' ? 0 : 1
    const entries: JournalLine[] = []
    for (const line of lines) {
      if (line === '') continue
      try {
        entries.push(checkLine(JSON.parse(line), true))
      } catch {
        unreadable += 1
      }
    }
    return { entries, unreadable }
  }

  /**
   * Records the entry. An agent entry (`answered`, `refused`) is appended and fsynced before the
   * promise resolves. A door rejection is too when it is the first of its kind; a repeat within
   * COALESCE_WINDOW_MS of that first is counted in memory and resolves at once (its count is
   * written when the window closes); past the day's REJECTED_LINES_PER_DAY it is dropped and
   * counted. Rejects with InvalidJournalEntry for an entry it will not write, and with JournalError
   * (no_space, no_permission, other) when the disk did not take it, a coalesced count it had to
   * write first included.
   */
  async record(entry: JournalEntry): Promise<void> {
    const line = checkEntry(entry)
    await this.enqueue(() => (line.outcome === 'rejected' ? this.reject(line) : this.agentLine(line)))
  }

  /**
   * Writes the count of an open coalescing window, so a clean stop loses none of it. Resolves
   * once every append asked for before it has run. The journal stays usable after it.
   */
  async close(): Promise<void> {
    await this.enqueue(() => this.closeWindow())
  }

  /** Runs `work` after every append asked for before it. */
  private enqueue(work: () => Promise<void>): Promise<void> {
    const run = this.tail.then(work)
    this.tail = run.catch(() => undefined)
    return run
  }

  private async agentLine(line: JournalLine): Promise<void> {
    await this.closeWindow()
    await this.append(line)
  }

  private async reject(line: RejectedLine): Promise<void> {
    const at = Date.parse(line.at)
    const open = this.window
    if (open !== null && open.code === line.code && open.origin === line.origin && at >= open.first && at - open.first < COALESCE_WINDOW_MS) {
      open.count += 1
      open.last = line.at
      return
    }
    await this.closeWindow()
    if (await this.appendRejected(line, 1)) {
      this.window = { code: line.code, origin: line.origin, first: at, last: line.at, count: 0 }
    }
  }

  /**
   * Writes the open window's count, if it took in any repeat, and closes it. When the write fails
   * the window stays open with its count, so the next entry or `close` tries again.
   */
  private async closeWindow(): Promise<void> {
    const open = this.window
    if (open === null) return
    if (open.count > 0) {
      const line: RejectedLine = {
        at: open.last,
        outcome: 'rejected',
        code: open.code,
        ...(open.origin === undefined ? {} : { origin: open.origin }),
        count: open.count,
      }
      await this.appendRejected(line, open.count)
    }
    this.window = null
  }

  /**
   * Appends a `rejected` line under the day's cap: true when it was written. At the cap, the
   * day's one CAP_REACHED line is written instead and the `stands` rejections the line stood for
   * are counted as dropped; past it, they are only counted.
   */
  private async appendRejected(line: RejectedLine, stands: number): Promise<boolean> {
    const cap = this.capOf(line.at.slice(0, 10))
    if (cap.capped) {
      cap.dropped += stands
      return false
    }
    if (cap.lines >= REJECTED_LINES_PER_DAY) {
      await this.append({ at: line.at, outcome: 'rejected', code: CAP_REACHED })
      cap.capped = true
      cap.dropped += stands
      return false
    }
    await this.append(line)
    cap.lines += 1
    return true
  }

  /** The cap count of `day`, read from its file the first time the day is seen. */
  private capOf(day: string): CapDay {
    if (this.capDay?.day === day) return this.capDay
    const { entries } = this.writing(() => this.read(day))
    let lines = 0
    let capped = false
    for (const entry of entries) {
      if (entry.outcome !== 'rejected') continue
      if (entry.code === CAP_REACHED) capped = true
      else lines += 1
    }
    this.capDay = { day, lines, capped, dropped: 0 }
    return this.capDay
  }

  /**
   * Appends one line to its day's file and fsyncs it, writing on until the disk has taken every
   * byte. When the disk stops taking it, makes no progress, or the fsync of the file or of a new
   * day's folder fails, the bytes that reached the file are cut back off (truncated to the size it
   * had, then fsynced), so the journal holds no entry for an answer that was not sent. If cutting
   * them off fails too, a line cut short stays without its newline: every reader counts it as one
   * unreadable line and the next append seals it. A line that reached the file whole before a
   * failed fsync then stays an entry: the journal may hold an answer the agent did not get, never
   * miss one it did.
   */
  private async append(line: JournalLine): Promise<void> {
    const file = path.join(this.dir, `${line.at.slice(0, 10)}.jsonl`)
    let handle: FileHandle
    try {
      handle = await open(file, 'a+', 0o600)
    } catch (error) {
      throw new JournalError(writeFailure(error), 'write', { cause: error })
    }
    let size = 0
    let reached = false
    try {
      size = (await handle.stat()).size
      // A last line cut short (a crash, a write the disk did not finish) is sealed and ended first,
      // so it stays unreadable and this entry is a line of its own.
      const last = Buffer.alloc(1)
      if (size > 0) await handle.read(last, 0, 1, size - 1)
      const torn = size > 0 && last[0] !== 0x0a
      const bytes = Buffer.from(`${torn ? `${TORN_SEAL}\n` : ''}${JSON.stringify(line)}\n`, 'utf8')
      let offset = 0
      while (offset < bytes.length) {
        const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset)
        if (!(bytesWritten > 0)) throw new NoProgress()
        reached = true
        offset += bytesWritten
      }
      await handle.sync()
      // An empty file before this append is a day file just created: its name is an entry of
      // the folder, which needs an fsync of its own to survive a power loss. Once per new day.
      if (size === 0) await this.syncFolder()
    } catch (error) {
      if (reached) await takeBack(handle, size)
      await handle.close().catch(() => undefined)
      throw new JournalError(writeFailure(error), 'write', { cause: error })
    }
    try {
      await handle.close()
    } catch (error) {
      throw new JournalError(writeFailure(error), 'write', { cause: error })
    }
  }

  /**
   * Fsyncs the journal's folder. Windows has no folder handle to fsync (Node cannot open one)
   * and NTFS journals the folder's entries itself, so there it is skipped.
   */
  private async syncFolder(): Promise<void> {
    if (process.platform === 'win32') return
    const folder = await open(this.dir, 'r')
    try {
      await folder.sync()
    } finally {
      await folder.close()
    }
  }
}

/** A write that took no byte and named no error: the line cannot be finished, so it is a failed write (`other`). */
class NoProgress extends Error {
  constructor() {
    // i18n-exempt: a cause kept for the daemon's log, never shown to the person
    super('write made no progress')
    this.name = 'NoProgress'
  }
}

/** Cuts the file back to `size` and fsyncs that; a failure is left to the readers (see `append`). */
async function takeBack(handle: FileHandle, size: number): Promise<void> {
  try {
    await handle.truncate(size)
    await handle.sync()
  } catch {
    // The cut line stays without its newline: unreadable to every reader, sealed by the next append.
  }
}

/** The envelope an agent gets instead of an answer the journal could not record. */
export type JournalRefusal = ReturnType<typeof refuse>

/**
 * Why answerAfterRecord sent `internal`: the disk's reason (no_space, no_permission, other), or
 * `invalid` when the journal refused the entry itself (InvalidJournalEntry), which is a bug in the
 * caller and not a fault of the disk, so the page must not send the person to check the disk.
 */
export type AnswerFailure = JournalWriteFailure | 'invalid'

/** What answerAfterRecord did: recorded and sent the answer, or sent `internal` and why. */
export type AnswerOutcome =
  | { readonly recorded: true }
  | { readonly recorded: false; readonly cause: AnswerFailure }

/**
 * The one way an answer leaves the daemon: the entry is recorded (appended and fsynced) first,
 * and only then is `send()` called to send the answer. When the record fails, `send` is called
 * with the `internal` refusal instead, which the wrapper builds itself and which carries nothing
 * of the page, and the caller gets the cause: no_space, no_permission or other for `journalError`,
 * or `invalid` for an entry the journal refused (a bug in the caller, logged, not a disk state).
 */
export async function answerAfterRecord(
  journal: Journal,
  entry: JournalEntry,
  send: (refusal?: JournalRefusal) => void | Promise<void>,
): Promise<AnswerOutcome> {
  try {
    await journal.record(entry)
  } catch (error) {
    // i18n-exempt: a refusal read by the agent over MCP, not by the person
    await send(refuse('internal', 'The journal could not record this answer, so it was not sent.'))
    return { recorded: false, cause: causeOf(error) }
  }
  await send()
  return { recorded: true }
}

function causeOf(error: unknown): AnswerFailure {
  if (error instanceof InvalidJournalEntry) return 'invalid'
  if (error instanceof JournalError && error.operation === 'write') return error.code as JournalWriteFailure
  return 'other'
}
