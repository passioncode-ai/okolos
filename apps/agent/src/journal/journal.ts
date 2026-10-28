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
 * Volume (decisions 2026-10-27, N-006 rounds 3 and 4; spec section 3): any local page can make the
 * door reject requests, so door rejections are bounded per UTC day and per group (REJECTION_GROUPS):
 * request faults, and key or service state. Each rejection is written and fsynced before its answer,
 * like any entry, until its group holds REJECTED_LINES_PER_DAY lines that day. The next one writes
 * one CAP_REACHED line naming the group (once a day per group); later ones are not written but
 * counted. The count is written as a CAP_REACHED line with `count` when the daemon calls
 * `flushCounts(now)` (once a minute), at the first record a minute (COUNT_INTERVAL_MS) or more after
 * the last count line, at `close()` and at the day roll; `recent()` shows a count not yet written, so
 * the page never shows fewer than were counted. A crash loses at most the count not yet written, a
 * minute's worth. Agent entries (`answered`, `refused`) are bounded too, at AGENT_LINES_PER_DAY a
 * UTC day: past it an agent's answer is refused (JournalError `day_full`, so the agent gets
 * `internal`) and one DAY_FULL line says so. Both caps survive a restart: the first record of a day
 * reads that day's file.
 *
 * One writer (decision 2026-10-27, N-006 round 4): the journal has no lock of its own. It is opened
 * only by the daemon's `setup`, which the service shell (`apps/agent/src/service/http.ts`,
 * `startService`) runs after `holdSingleInstance` holds `<data>/service.lock`: a kernel lock that the
 * kernel drops when the process dies, so an unclean stop leaves nothing to clear and a second daemon
 * stops at that lock before it reaches the journal. The daemon closes the journal before it releases
 * that lock. Two Journals open on one folder would each keep a cap of their own; that is a caller's
 * bug, which this rule keeps out.
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
 * Past a group's cap, how often its count is written by the records themselves: at the first record
 * (an agent's or a door's) this long or more after the last count line, the CAP_REACHED line or the
 * last `flushCounts(now)` that wrote one. Measured on the entries' own times (and that `now`); a time
 * earlier than the last write (a clock stepped back) starts the minute again from it.
 */
export const COUNT_INTERVAL_MS = 60_000

/**
 * The most rejection lines a group holds in one UTC day. The next rejection of that group writes one
 * CAP_REACHED line instead, and later ones are counted.
 *
 * Bound (LC-12, every file bounded; the line sizes are pinned by a test): a rejection line is at
 * most 393 bytes (an origin of MAX_ORIGIN_LENGTH, the largest `bytes`, the newline and a TORN_SEAL
 * before it), a CAP_REACHED line with or without its count at most 127. With a clock that runs
 * forward and `flushCounts` called once a minute (the daemon), a group writes in a day at most
 * 2 000 rejection lines, one CAP_REACHED, 1 440 count lines from `flushCounts`, 1 440 from the
 * records' own minute and one at the day roll, plus one per clean stop. So the door's part of a day
 * file stays under 2 x (2 000 x 393 + 2 882 x 127) = 2 304 028 bytes, about 2.3 MB. The sweep runs at
 * start and once a day and keeps the day its horizon cuts, so the journal holds up to 92 day files
 * (the cut day, 90 days and today, and one more until the next daily sweep): the door's part stays
 * under 212 MB whatever a page sends, plus 254 bytes per clean stop. Day files dated after the clock
 * (one that once ran ahead) are not swept until their day comes, and are outside this number.
 */
export const REJECTED_LINES_PER_DAY = 2_000

/**
 * The most agent entries (`answered` and `refused`, together) one UTC day holds (decision
 * 2026-10-27, N-006 round 4). The next agent entry that day is not written: `record` rejects with
 * JournalError `day_full`, so `answerAfterRecord` sends the `internal` refusal with that cause, and
 * one DAY_FULL line is written once that day for SCR-24. Bound (the line sizes are pinned by a
 * test): an agent line is at most 719 bytes (a 40-code-point name of 4-byte characters, an origin of
 * MAX_ORIGIN_LENGTH, the longest verb and code, the largest `bytes`, the newline and a TORN_SEAL
 * before it), a DAY_FULL line 63. So the agents' part of a day file stays under
 * 5 000 x 719 + 63 = 3 595 063 bytes, about 3.6 MB, and over the 92 day files the journal can hold
 * (see REJECTED_LINES_PER_DAY) under 331 MB; with the door's part, the whole journal stays under
 * 544 MB. 5 000 is ten tasks of the 500-step budget a day (decision 2026-10-27, N-006 round 4).
 */
export const AGENT_LINES_PER_DAY = 5_000

/**
 * The outcome of the journal's own line for a day whose agent entries reached AGENT_LINES_PER_DAY:
 * `{"at": ..., "outcome": "day_full"}`, `at` being the first agent entry it refused. Written once a
 * day and only by the journal: a caller's entry cannot carry this outcome. It is also the code of the
 * JournalError a refused agent entry gets. The page owes it a line that the journal is full for the
 * day (N-014, N-015).
 */
export const DAY_FULL = 'day_full'

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
 * The two groups door rejections are capped in, each with its own REJECTED_LINES_PER_DAY:
 * `request`, what was wrong with the request itself; `state`, the key or the state of the service.
 * A page flooding the door with bad requests cannot so push a replayed key out of the journal.
 */
export type RejectionGroup = 'request' | 'state'

/**
 * The group of every rejection code. Keyed by RejectionCode, so a code added to RejectionCode (a
 * reason the shell adds to RefusalReason) without a group fails the typecheck, instead of the
 * journal refusing the rejection at run time.
 */
export const REJECTION_GROUPS: Readonly<Record<RejectionCode, RejectionGroup>> = Object.freeze({
  bad_host: 'request',
  bad_origin: 'request',
  cross_site: 'request',
  bad_content_type: 'request',
  bad_request: 'request',
  not_paired: 'state',
  store_unreadable: 'state',
  stopping: 'state',
})

const GROUPS: readonly RejectionGroup[] = ['request', 'state']

/**
 * The code of the journal's own `rejected` lines for a group past its cap: once a day without a
 * `count` (the cap was reached), then with the `count` of the rejections not written since the last
 * such line. Only the journal writes it; a caller that records it is refused. The page owes it a
 * `rejection_cap_reached` line with the count (N-014, N-015).
 */
export const CAP_REACHED = 'cap_reached'

/** What a stored `rejected` line carries: a caller's RejectionCode, or the journal's own CAP_REACHED. */
export type StoredRejectionCode = RejectionCode | typeof CAP_REACHED

/** Every rejection code a caller records; the page has a `rejection_<code>` line for each. */
export const REJECTION_CODES: readonly RejectionCode[] = Object.freeze(Object.keys(REJECTION_GROUPS) as RejectionCode[])

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
 * normalised (code a RejectionCode, no group, no count), or the journal's own CAP_REACHED line
 * (a group, no origin, no bytes; with `count` when it carries a count).
 */
export interface RejectedLine {
  readonly at: string
  readonly outcome: 'rejected'
  readonly code: StoredRejectionCode
  /** On a CAP_REACHED line only: the group whose cap was reached. */
  readonly group?: RejectionGroup
  readonly origin?: string
  readonly bytes?: number
  /**
   * On a CAP_REACHED line only: how many of the group's rejections were not written since the last
   * such line (the first counts the rejection that found the cap full). Its `at` is the last one's.
   */
  readonly count?: number
}

/** The journal's own line for a day whose agent entries reached AGENT_LINES_PER_DAY (see DAY_FULL). */
export interface DayFullLine {
  /** The first agent entry the full day refused. */
  readonly at: string
  readonly outcome: typeof DAY_FULL
}

/** A line of the journal as it is read back: an agent entry, a stored rejected line, or a DAY_FULL line. */
export type JournalLine = Exclude<JournalEntry, { readonly outcome: 'rejected' }> | RejectedLine | DayFullLine

/** Members each outcome may carry, in the order they are written. */
const FIELDS = {
  answered: ['at', 'agent', 'agentId', 'pairedAt', 'task', 'verb', 'origin', 'outcome', 'bytes', 'verdict'],
  refused: ['at', 'agent', 'agentId', 'pairedAt', 'task', 'verb', 'origin', 'outcome', 'code', 'bytes', 'verdict'],
  rejected: ['at', 'outcome', 'code', 'origin', 'bytes'],
} as const satisfies Record<JournalEntry['outcome'], readonly string[]>

/** The members of the journal's own CAP_REACHED line, in the order they are written. */
const CAP_FIELDS: readonly string[] = ['at', 'outcome', 'code', 'group', 'count']

/** The members of the journal's own DAY_FULL line, in the order they are written. */
const DAY_FULL_FIELDS: readonly string[] = ['at', 'outcome']

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
 * valid. A caller's entry may not carry `count`, CAP_REACHED or the DAY_FULL outcome: those are
 * the journal's own.
 */
export function checkEntry(input: JournalEntry): JournalLine {
  return checkLine(input, false)
}

/** checkEntry for a caller's entry (`stored` false), or for a line read back from disk (`stored` true). */
function checkLine(input: unknown, stored: boolean): JournalLine {
  const raw = input as Record<string, unknown>
  if (typeof raw !== 'object' || raw === null) throw new InvalidJournalEntry('entry')
  const outcome = raw.outcome
  if (stored && outcome === DAY_FULL) {
    for (const key of Object.keys(raw)) if (!DAY_FULL_FIELDS.includes(key)) throw new InvalidJournalEntry(key)
    const at = journalTimeOf(raw.at)
    if (at === null) throw new InvalidJournalEntry('at')
    return { at, outcome: DAY_FULL }
  }
  if (outcome !== 'answered' && outcome !== 'refused' && outcome !== 'rejected') throw new InvalidJournalEntry('outcome')
  const capLine = stored && outcome === 'rejected' && raw.code === CAP_REACHED
  const allowed: readonly string[] = capLine ? CAP_FIELDS : FIELDS[outcome]
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
  if (capLine) {
    if (!includes(GROUPS, raw.group)) throw new InvalidJournalEntry('group')
    if (raw.count !== undefined && (!Number.isSafeInteger(raw.count) || (raw.count as number) < 1)) {
      throw new InvalidJournalEntry('count')
    }
  } else if (outcome === 'rejected') {
    if (!includes(REJECTION_CODES, raw.code)) throw new InvalidJournalEntry('code')
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

/**
 * Why the journal could not write an entry: from the errno (no_space, no_permission, other), the
 * `$WHAT$` of `journalError`; or `day_full`, an agent entry past AGENT_LINES_PER_DAY, which the page
 * names with its own line (the journal is full for the day), not as a fault of the disk.
 */
export type JournalWriteFailure = 'no_space' | 'no_permission' | 'other' | typeof DAY_FULL

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

/** A refusal the bridge's policy gave a paired agent (or a call it could not take, bad_call). */
export type RefusalEntry = Extract<JournalLine, { readonly outcome: 'refused' }>

/** What the page shows of the journal: lists that each have their own limit, so none evicts another. */
export interface RecentJournal {
  /** The newest answers, oldest first. */
  readonly answers: AnsweredEntry[]
  /** The newest refusals given to paired agents, oldest first. */
  readonly refusals: RefusalEntry[]
  /**
   * The newest door rejections of each group, oldest first, CAP_REACHED lines included (a count not
   * yet written is its group's newest line): a flood of request faults cannot push a `state`
   * rejection such as `not_paired` off, and no rejection can push an agent's refusal off.
   */
  readonly rejections: Readonly<Record<RejectionGroup, RejectedLine[]>>
  /** The newest DAY_FULL lines, oldest first: days whose agent entries reached AGENT_LINES_PER_DAY. */
  readonly dayFull: DayFullLine[]
  /** Lines anywhere in the journal that are not an entry (`journalLinesSkipped`). */
  readonly unreadable: number
}

/** One group's rejections in the current day, as the cap counts them. */
interface GroupState {
  /** Rejection lines of the group in the day file. */
  lines: number
  /** Whether the day file holds the group's CAP_REACHED line. */
  capped: boolean
  /** Rejections past the cap not yet written in a count line. */
  pending: number
  /** The `at` of the last of them: a count line's `at`. */
  lastDropped: string
  /** The time (ms) of the last count or CAP_REACHED line, from which the minute is measured. */
  since: number | undefined
}

/** The day the caps count, read from its file the first time a record falls on it. */
interface DayState {
  readonly day: string
  readonly groups: Record<RejectionGroup, GroupState>
  /** Agent entries (`answered`, `refused`) in the day file. */
  agentLines: number
  /** Whether the day file holds its DAY_FULL line. */
  full: boolean
}

export class Journal {
  /** The tail of the write queue: appends run one at a time, in the order they were asked for. */
  private tail: Promise<void> = Promise.resolve()
  private today: DayState | null = null
  /** Set by `close()`: no record is taken after it. */
  private closing = false
  /** The first `close()`: a later call waits for it and touches nothing. */
  private closed: Promise<void> | null = null

  private constructor(
    readonly dir: string,
    readonly retentionDays: number,
  ) {}

  /**
   * Opens the journal in `dir` (`<data>/journal`), creating the folder 0700 when it is missing. It
   * takes no lock: the caller holds the service shell's `<data>/service.lock` (see the module's
   * "One writer"), and opens one Journal per folder.
   */
  static open(dir: string, options: { retentionDays: number }): Journal {
    // A window of NaN or zero days would make the sweep drop every entry.
    if (!Number.isInteger(options.retentionDays) || options.retentionDays < 1) {
      throw new RangeError(`retentionDays: ${String(options.retentionDays)}`)
    }
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    return new Journal(dir, options.retentionDays)
  }

  /**
   * The newest `limit` answers, the newest `limit` refusals, the newest `limit` DAY_FULL lines and,
   * in a list of their own for each group, the newest `rejectionLimit` door rejections of that group,
   * so neither a stream of answers nor a flood at the door pushes an agent's refusal off the page,
   * and a flood of request faults does not push a `state` rejection off. A group's count not yet
   * written is its newest line, as the CAP_REACHED line `flushCounts` would write now, so the page
   * never shows fewer rejections than were counted. Reads every day, so `unreadable` counts the bad
   * lines of the whole journal, not of the page. Throws JournalError (no_permission, unreadable,
   * other) when the journal cannot be read.
   */
  recent(limit: number, rejectionLimit: number = limit): RecentJournal {
    const answers: AnsweredEntry[] = []
    const refusals: RefusalEntry[] = []
    const dayFull: DayFullLine[] = []
    const rejections: Record<RejectionGroup, RejectedLine[]> = { request: [], state: [] }
    // Newest first while collecting: a count not yet written is newer than any line on disk.
    for (const group of GROUPS) {
      const pending = this.pendingCount(group)
      if (pending !== null) rejections[group].push(pending)
    }
    let unreadable = 0
    for (const day of this.reading(() => this.days()).reverse()) {
      const read = this.reading(() => this.read(day))
      unreadable += read.unreadable
      for (const entry of read.entries.reverse()) {
        if (entry.outcome === 'answered') answers.push(entry)
        else if (entry.outcome === 'refused') refusals.push(entry)
        else if (entry.outcome === DAY_FULL) dayFull.push(entry)
        else rejections[entry.group ?? REJECTION_GROUPS[entry.code as RejectionCode]].push(entry)
      }
    }
    const newest = <T>(list: T[], most: number): T[] => (most <= 0 ? [] : list.slice(0, most).reverse())
    return {
      answers: newest(answers, limit),
      refusals: newest(refusals, limit),
      rejections: { request: newest(rejections.request, rejectionLimit), state: newest(rejections.state, rejectionLimit) },
      dayFull: newest(dayFull, limit),
      unreadable,
    }
  }

  /** The CAP_REACHED line with `count` that would carry the group's count not yet written, or null. */
  private pendingCount(group: RejectionGroup): RejectedLine | null {
    const state = this.today?.groups[group]
    if (state === undefined || state.pending === 0) return null
    return { at: state.lastDropped, outcome: 'rejected', code: CAP_REACHED, group, count: state.pending }
  }

  /**
   * The whole journal as JSON lines, oldest first, for GET /api/journal. Every line is an entry
   * checked again on the way out and written with the journal's members only, so a line edited
   * on disk to carry page text is not exported; such lines are left out, as `recent` counts them.
   * Reads only, so its reasons are a read's: throws JournalError (no_permission, unreadable,
   * other), operation `export`, for `journalExportFailed`. With `day` (YYYY-MM-DD) only that day:
   * the whole journal can be longer than the longest string node allows (round 6), so the page
   * exports by day (`exportDays`).
   */
  export(only?: string): string {
    if (only !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(only)) {
      throw new TypeError(`Journal.export: day must be YYYY-MM-DD, got ${String(only)}`)
    }
    let out = ''
    const days = this.reading(() => this.days(), 'export').filter((name) => only === undefined || name === only)
    for (const day of days) {
      for (const entry of this.reading(() => this.read(day), 'export').entries) out += `${JSON.stringify(entry)}\n`
    }
    return out
  }

  /** The days the journal holds, oldest first, for an export one day at a time. */
  exportDays(): string[] {
    return this.reading(() => this.days(), 'export')
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
   * without its older entries. The daemon calls this at start and once a day. Day files dated
   * after `now` (a clock that once ran ahead) are left as they are.
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
    if (this.closing) throw closedError()
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
   * Records the entry: appended and fsynced before the promise resolves, an agent's entry and a door
   * rejection alike. Two exceptions, each per UTC day. A rejection whose group has reached
   * REJECTED_LINES_PER_DAY: the first writes the group's CAP_REACHED line instead, and later ones are
   * counted (see COUNT_INTERVAL_MS and `flushCounts`). An agent entry once the day holds
   * AGENT_LINES_PER_DAY of them: it is not written and the record rejects with JournalError
   * `day_full`; the first such entry writes the DAY_FULL line first (if that line cannot be written,
   * the record rejects with the disk's reason and the next agent entry tries again). A count that is
   * due, or the last day's at a day roll, is written first. A line counts toward its cap only once
   * it is written. Rejects with InvalidJournalEntry for an entry it will not write, and with
   * JournalError (no_space, no_permission, other) when the disk did not take it or a count written
   * first; a count that failed is kept for the next try. After `close()` every record rejects (other).
   */
  async record(entry: JournalEntry): Promise<void> {
    const line = checkEntry(entry)
    if (this.closing) throw closedError()
    await this.enqueue(() => this.write(line))
  }

  /**
   * Writes every group's count not yet written, now, once every append asked for before it has run,
   * whatever time has passed since the last count line; the daemon calls it once a minute with its
   * clock, so a crash loses at most a minute's count even when no record follows a flood. `now` is
   * where the records' own minute (COUNT_INTERVAL_MS) starts again for a group it wrote. Rejects with
   * a TypeError, before it touches anything, unless `now` is a safe integer >= 0 (like `sweep`); with
   * JournalError (no_space, no_permission, other) when a count could not be written, which is kept
   * for the next try; and after `close()` (other).
   */
  async flushCounts(now: number): Promise<void> {
    if (typeof now !== 'number' || !Number.isSafeInteger(now) || now < 0) {
      throw new TypeError(`Journal.flushCounts: now must be a safe integer >= 0, got ${String(now)}`)
    }
    if (this.closing) throw closedError()
    await this.enqueue(async () => {
      if (this.today !== null) await this.writeCounts(this.today, null, now)
    })
  }

  /**
   * Writes every group's count not yet written, whatever the clock says, once every append asked for
   * before it has run; records and flushes asked for after it are refused. The daemon calls it after
   * the shell's drain and before the shell releases `service.lock`. Rejects with JournalError when a
   * count could not be written. Only the first call writes: a later one resolves once the first has
   * finished, without touching the folder, because by then the shell may have released
   * `service.lock` to another daemon. A count the first call could not write is so lost, as a crash
   * would lose it.
   */
  close(): Promise<void> {
    if (this.closed !== null) return this.closed.catch(() => undefined)
    this.closing = true
    this.closed = this.enqueue(async () => {
      if (this.today !== null) await this.writeCounts(this.today, null)
    })
    return this.closed
  }

  /** Runs `work` after every append asked for before it. */
  private enqueue(work: () => Promise<void>): Promise<void> {
    const run = this.tail.then(work)
    this.tail = run.catch(() => undefined)
    return run
  }

  private async write(line: JournalLine): Promise<void> {
    const at = Date.parse(line.at)
    const today = await this.dayOf(line.at.slice(0, 10))
    if (line.outcome === 'answered' || line.outcome === 'refused') {
      await this.writeCounts(today, at)
      // `close` is always written: the agent may always close its task, and past the cap no
      // task opens, so closes are bounded by the tasks already open (round 6).
      if (today.agentLines >= AGENT_LINES_PER_DAY && line.verb !== 'close') {
        if (!today.full) {
          await this.append({ at: line.at, outcome: DAY_FULL })
          today.full = true
        }
        throw new JournalError(DAY_FULL, 'write')
      }
      await this.append(line)
      today.agentLines += 1
      return
    }
    // A caller's line is an agent entry or a door rejection: checkEntry gives no other.
    if (line.outcome !== 'rejected') throw new InvalidJournalEntry('outcome')
    const group = REJECTION_GROUPS[line.code as RejectionCode]
    const state = today.groups[group]
    if (state.capped) {
      state.pending += 1
      state.lastDropped = line.at
      await this.writeCounts(today, at)
      return
    }
    await this.writeCounts(today, at)
    if (state.lines >= REJECTED_LINES_PER_DAY) {
      await this.append({ at: line.at, outcome: 'rejected', code: CAP_REACHED, group })
      state.capped = true
      state.pending = 1
      state.lastDropped = line.at
      state.since = at
      return
    }
    await this.append(line)
    state.lines += 1
  }

  /**
   * The cap state of `day`. At a day roll the last day's counts are written first (into its own
   * file); when that fails the roll does not happen, so the count is kept for the next try. A day
   * seen for the first time is read from its file, so a restart keeps both caps and their lines.
   */
  private async dayOf(day: string): Promise<DayState> {
    if (this.today?.day === day) return this.today
    if (this.today !== null) await this.writeCounts(this.today, null)
    const { entries } = this.writing(() => this.read(day))
    const groups = {} as Record<RejectionGroup, GroupState>
    for (const group of GROUPS) groups[group] = { lines: 0, capped: false, pending: 0, lastDropped: '', since: undefined }
    let agentLines = 0
    let full = false
    for (const entry of entries) {
      if (entry.outcome === 'answered' || entry.outcome === 'refused') agentLines += 1
      else if (entry.outcome === DAY_FULL) full = true
      else if (entry.code !== CAP_REACHED) groups[REJECTION_GROUPS[entry.code]].lines += 1
      else if (entry.count === undefined && entry.group !== undefined) groups[entry.group].capped = true
    }
    this.today = { day, groups, agentLines, full }
    return this.today
  }

  /**
   * Writes each group's count line that is due at `at` (ms): a minute or more after the group's last
   * count or CAP_REACHED line. `at` null writes every pending count (`flushCounts`, `close`, a day
   * roll); `flushedAt` is then where the group's minute starts again (`flushCounts`' now). A time
   * before the last line (a clock stepped back) starts the minute again from it. A failed write
   * throws and keeps the count.
   */
  private async writeCounts(today: DayState, at: number | null, flushedAt?: number): Promise<void> {
    for (const group of GROUPS) {
      const state = today.groups[group]
      if (state.pending === 0) continue
      if (at !== null) {
        if (state.since === undefined || at < state.since) {
          state.since = at
          continue
        }
        if (at - state.since < COUNT_INTERVAL_MS) continue
      }
      await this.append({ at: state.lastDropped, outcome: 'rejected', code: CAP_REACHED, group, count: state.pending })
      state.pending = 0
      const since = at ?? flushedAt
      if (since !== undefined) state.since = since
    }
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

/** What a record after `close()` gets: the journal no longer holds its folder. */
function closedError(): JournalError {
  return new JournalError('other', 'write', { cause: new Error('journal closed') })
}

/** The envelope an agent gets instead of an answer the journal could not record. */
export type JournalRefusal = ReturnType<typeof refuse>

/**
 * Why answerAfterRecord sent `internal`: the disk's reason (no_space, no_permission, other);
 * `day_full` when the day already holds AGENT_LINES_PER_DAY agent entries (the page says the journal
 * is full for the day); or `invalid` when the journal refused the entry itself (InvalidJournalEntry),
 * which is a bug in the caller and not a fault of the disk, so the page must not send the person to
 * check the disk.
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
 * `day_full` for a day whose agent entries reached AGENT_LINES_PER_DAY, or `invalid` for an entry
 * the journal refused (a bug in the caller, logged, not a disk state).
 */
export async function answerAfterRecord(
  journal: Journal,
  entry: JournalEntry,
  send: (refusal?: JournalRefusal) => void | Promise<void>,
): Promise<AnswerOutcome> {
  try {
    await journal.record(entry)
  } catch (error) {
    const cause = causeOf(error)
    const message =
      cause === DAY_FULL
        ? // i18n-exempt: a refusal read by the agent over MCP, not by the person
          'The journal holds the most entries it keeps for this UTC day, so this answer was not sent.'
        : // i18n-exempt: a refusal read by the agent over MCP, not by the person
          'The journal could not record this answer, so it was not sent.'
    await send(refuse('internal', message))
    return { recorded: false, cause }
  }
  await send()
  return { recorded: true }
}

function causeOf(error: unknown): AnswerFailure {
  if (error instanceof InvalidJournalEntry) return 'invalid'
  if (error instanceof JournalError && error.operation === 'write') return error.code as JournalWriteFailure
  return 'other'
}
