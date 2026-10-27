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
 */
import { mkdirSync, readdirSync, readFileSync, unlinkSync } from 'node:fs'
import { open } from 'node:fs/promises'
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
 * Why the door turned a request away before it knew the agent: the shell's reasons, a body that
 * is not JSON, and an access list that could not be read (so the key was not checked).
 */
export type DoorRejection = RefusalReason | 'bad_content_type' | 'store_unreadable'

/** What a `rejected` entry may carry: a door rejection, or a key that matches no paired agent. */
export type RejectionCode = DoorRejection | Extract<BridgeRefusal, 'not_paired'>

/** Every rejection code; the page has a `rejection_<code>` line for each. */
export const REJECTION_CODES = [
  'bad_host',
  'bad_origin',
  'cross_site',
  'bad_request',
  'stopping',
  'bad_content_type',
  'store_unreadable',
  'not_paired',
] as const satisfies readonly RejectionCode[]

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
  /** When the answer was recorded, ISO 8601. */
  readonly at: string
  /** The paired agent, by the name it was paired under. Two agents may share it. */
  readonly agent: string
  /** The paired agent's id: what tells two agents of the same name apart. */
  readonly agentId: string
  /** When the agent was given access, ISO 8601: the page names a revoked agent by it. */
  readonly pairedAt: string
  readonly task?: string
  /** The origin the call reached: scheme, host and port, no path and no query. */
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
      readonly origin?: string
      readonly bytes?: number
    }

/** Members each outcome may carry, in the order they are written. */
const FIELDS = {
  answered: ['at', 'agent', 'agentId', 'pairedAt', 'task', 'verb', 'origin', 'outcome', 'bytes', 'verdict'],
  refused: ['at', 'agent', 'agentId', 'pairedAt', 'task', 'verb', 'origin', 'outcome', 'code', 'bytes', 'verdict'],
  rejected: ['at', 'outcome', 'code', 'origin', 'bytes'],
} as const satisfies Record<JournalEntry['outcome'], readonly string[]>

/** Longer than any agent name or task id; a page's text would not fit. */
const MAX_NAME = 256

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
 * The entry as it is written, with its members in a fixed order, or InvalidJournalEntry naming
 * the first member that is not allowed or not valid.
 */
export function checkEntry(input: JournalEntry): JournalEntry {
  const raw = input as unknown as Record<string, unknown>
  if (typeof raw !== 'object' || raw === null) throw new InvalidJournalEntry('entry')
  const outcome = raw.outcome
  if (outcome !== 'answered' && outcome !== 'refused' && outcome !== 'rejected') throw new InvalidJournalEntry('outcome')
  const allowed: readonly string[] = FIELDS[outcome]
  for (const key of Object.keys(raw)) if (!allowed.includes(key)) throw new InvalidJournalEntry(key)
  if (!isDate(raw.at)) throw new InvalidJournalEntry('at')
  if (raw.origin !== undefined && (typeof raw.origin !== 'string' || originOf(raw.origin) !== raw.origin)) {
    throw new InvalidJournalEntry('origin')
  }
  if (raw.bytes !== undefined && (!Number.isInteger(raw.bytes) || (raw.bytes as number) < 0)) {
    throw new InvalidJournalEntry('bytes')
  }
  if (outcome === 'rejected') {
    if (!includes(REJECTION_CODES, raw.code)) throw new InvalidJournalEntry('code')
  } else {
    if (!isName(raw.agent)) throw new InvalidJournalEntry('agent')
    if (!isName(raw.agentId)) throw new InvalidJournalEntry('agentId')
    if (!isDate(raw.pairedAt)) throw new InvalidJournalEntry('pairedAt')
    if (raw.task !== undefined && !isName(raw.task)) throw new InvalidJournalEntry('task')
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
  for (const key of allowed) if (raw[key] !== undefined) written[key] = raw[key]
  return written as unknown as JournalEntry
}

function isName(value: unknown): boolean {
  return typeof value === 'string' && value !== '' && value.length <= MAX_NAME
}

function isDate(value: unknown): boolean {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value))
}

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
    // i18n-exempt: read in the daemon's log by a developer; the page names `code` through its catalogue
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

/** An answer the agent got. */
export type AnsweredEntry = Extract<JournalEntry, { readonly outcome: 'answered' }>

/** A refusal: the bridge's policy said no to a paired agent, or the door turned a request away. */
export type RefusalEntry = Exclude<JournalEntry, { readonly outcome: 'answered' }>

/** What the page shows of the journal. */
export interface RecentJournal {
  /** The newest answers, oldest first. */
  readonly answers: AnsweredEntry[]
  /** The newest refusals (`refused` and `rejected`), oldest first, counted apart from the answers. */
  readonly refusals: RefusalEntry[]
  /** Lines anywhere in the journal that are not an entry (`journalLinesSkipped`). */
  readonly unreadable: number
}

export class Journal {
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
   * other) when the journal cannot be read.
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

  /** Runs a read of the journal, turning a failure into a JournalError with its reason. */
  private reading<T>(read: () => T, operation: 'read' | 'export' = 'read'): T {
    try {
      return read()
    } catch (error) {
      throw new JournalError(readFailure(error), operation, { cause: error })
    }
  }

  /**
   * Drops every entry older than the retention window at `now` (ms since the epoch) and returns
   * how many went. A day wholly past the window is deleted; the day the window's edge falls in is
   * rewritten atomically without its older entries. The daemon calls this at start and once a day.
   */
  sweep(now: number): number {
    const horizon = now - this.retentionDays * DAY_MS
    let removed = 0
    for (const day of this.days()) {
      const start = Date.parse(`${day}T00:00:00.000Z`)
      if (start >= horizon) continue
      const { entries } = this.read(day)
      if (start + DAY_MS <= horizon) {
        unlinkSync(path.join(this.dir, `${day}.jsonl`))
        removed += entries.length
        continue
      }
      const kept = entries.filter((entry) => Date.parse(entry.at) >= horizon)
      if (kept.length === entries.length) continue
      atomicWrite(path.join(this.dir, `${day}.jsonl`), kept.map((entry) => `${JSON.stringify(entry)}\n`).join(''), 0o600)
      removed += entries.length - kept.length
    }
    return removed
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
   * loss or edited by hand is not fatal, and it is counted, not dropped silently. A day whose file
   * went between listing and reading (the sweep took it) is an empty day.
   */
  private read(day: string): { entries: JournalEntry[]; unreadable: number } {
    let text: string
    try {
      text = readFileSync(path.join(this.dir, `${day}.jsonl`), 'utf8')
    } catch (error) {
      if (errnoOf(error) === 'ENOENT') return { entries: [], unreadable: 0 }
      throw error
    }
    const entries: JournalEntry[] = []
    let unreadable = 0
    for (const line of text.split('\n')) {
      if (line === '') continue
      try {
        entries.push(checkEntry(JSON.parse(line) as JournalEntry))
      } catch {
        unreadable += 1
      }
    }
    return { entries, unreadable }
  }

  /**
   * Appends the entry and fsyncs it before resolving. Rejects with InvalidJournalEntry for an
   * entry it will not write, and with JournalError (no_space, no_permission, other) when the disk
   * did not take it.
   */
  async record(entry: JournalEntry): Promise<void> {
    const written = checkEntry(entry)
    const day = new Date(written.at).toISOString().slice(0, 10)
    try {
      const handle = await open(path.join(this.dir, `${day}.jsonl`), 'a+', 0o600)
      try {
        // A last line cut short by a crash gets its newline first, so this entry is a line of its own.
        const { size } = await handle.stat()
        const last = Buffer.alloc(1)
        if (size > 0) await handle.read(last, 0, 1, size - 1)
        const torn = size > 0 && last[0] !== 0x0a
        await handle.write(`${torn ? '\n' : ''}${JSON.stringify(written)}\n`)
        await handle.sync()
      } finally {
        await handle.close()
      }
    } catch (error) {
      throw new JournalError(writeFailure(error), 'write', { cause: error })
    }
  }
}

/** The envelope an agent gets instead of an answer the journal could not record. */
export type JournalRefusal = ReturnType<typeof refuse>

/** What answerAfterRecord did: recorded and sent the answer, or sent `internal` and why. */
export type AnswerOutcome =
  | { readonly recorded: true }
  | { readonly recorded: false; readonly cause: JournalWriteFailure }

/**
 * The one way an answer leaves the daemon: the entry is recorded (appended and fsynced) first,
 * and only then is `send()` called to send the answer. When the record fails, `send` is called
 * with the `internal` refusal instead, which the wrapper builds itself and which carries nothing
 * of the page, and the caller gets the cause (no_space, no_permission, other) for `journalError`.
 * An entry the journal refuses as invalid is a bug in the caller, so its cause is `other`.
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
    return { recorded: false, cause: error instanceof JournalError ? (error.code as JournalWriteFailure) : 'other' }
  }
  await send()
  return { recorded: true }
}
