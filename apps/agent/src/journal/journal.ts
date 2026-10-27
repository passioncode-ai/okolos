/**
 * The agents' journal of Okolos Agent: every answer an agent gets is written here first.
 *
 * ADR-0019 promises the person that everything an agent received through the bridge is in the
 * journal. So an answer is recorded (appended and fsynced) before it is sent, and an answer the
 * journal could not record is not sent at all: the agent gets the `internal` refusal instead.
 * `answerAfterRecord` is the one wrapper that does this; the door (N-008) sends every answer,
 * its own refusals and parse errors included, through it.
 *
 * What an entry holds is closed: who asked (the paired agent and its task), which verb, which
 * origin, how it ended, the refusal code, the size of the answer and the snapshot's verdict
 * level. Never the text of a page and never the value of a field: an entry with any other member
 * is refused by its type and again at run time, before anything is written.
 *
 * Layout: JSON lines under `<data>/journal/`, one file per UTC day (`2026-10-27.jsonl`), each
 * 0600 in a 0700 folder. The retention sweep drops whole days past the window and rewrites the
 * one day that straddles it.
 */
import { mkdirSync } from 'node:fs'
import { open } from 'node:fs/promises'
import path from 'node:path'

import { BRIDGE_REFUSALS, originOf, refuse, type BridgeRefusal, type BridgeVerb } from '@okolos/contracts'

import type { RefusalReason } from '../service/http.js'

/**
 * Calls that live outside any task. Named and spelled as `BridgeSessionVerb` in
 * @okolos/contracts on branch b1/n-023 (node N-023), which this branch does not have yet; when
 * N-023 lands, this alias and the one below become imports of the same names.
 */
export type BridgeSessionVerb = 'session.open' | 'hygiene.census'

/**
 * Every call the bridge answers, in its canonical spelling (`session.open`, with the dot, never
 * the MCP tool name `session_open`). The same name and union as `AnyBridgeVerb` in N-023.
 */
export type AnyBridgeVerb = BridgeVerb | BridgeSessionVerb

/** Why the door turned a request away before reading it: the shell's reasons, plus a body that is not JSON. */
export type DoorRejection = RefusalReason | 'bad_content_type'

/** The level of the snapshot's verdict (`SnapshotVerdict['level']` in N-023); its findings stay out. */
export type JournalVerdict = 'clean' | 'finding'

/** A call a paired agent made: answered, or refused by the bridge's policy. */
interface AgentCall {
  /** When the answer was recorded, ISO 8601. */
  readonly at: string
  /** The paired agent, by the name it was paired under. */
  readonly agent: string
  readonly task?: string
  readonly verb: AnyBridgeVerb
  /** The origin the call reached: scheme, host and port, no path and no query. */
  readonly origin?: string
  /** The size of the answer sent, in bytes. */
  readonly bytes?: number
  readonly verdict?: JournalVerdict
}

export type JournalEntry =
  | (AgentCall & { readonly outcome: 'answered' })
  | (AgentCall & { readonly outcome: 'refused'; readonly code: BridgeRefusal })
  | {
      /** A request the door turned away before it knew the agent or the verb. */
      readonly at: string
      readonly outcome: 'rejected'
      readonly code: DoorRejection | BridgeRefusal
      readonly origin?: string
      readonly bytes?: number
    }

/** Members each outcome may carry, in the order they are written. */
const FIELDS = {
  answered: ['at', 'agent', 'task', 'verb', 'origin', 'outcome', 'bytes', 'verdict'],
  refused: ['at', 'agent', 'task', 'verb', 'origin', 'outcome', 'code', 'bytes', 'verdict'],
  rejected: ['at', 'outcome', 'code', 'origin', 'bytes'],
} as const satisfies Record<JournalEntry['outcome'], readonly string[]>

/** Every canonical verb; a key missing here, or one too many, is a type error. */
const VERBS: Readonly<Record<AnyBridgeVerb, true>> = {
  open: true,
  snapshot: true,
  read: true,
  get: true,
  waitFor: true,
  screenshot: true,
  close: true,
  'session.open': true,
  'hygiene.census': true,
}

const DOOR_REJECTIONS: Readonly<Record<DoorRejection, true>> = {
  bad_host: true,
  bad_origin: true,
  cross_site: true,
  bad_request: true,
  stopping: true,
  bad_content_type: true,
}

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
  if (typeof raw.at !== 'string' || Number.isNaN(Date.parse(raw.at))) throw new InvalidJournalEntry('at')
  if (raw.origin !== undefined && (typeof raw.origin !== 'string' || originOf(raw.origin) !== raw.origin)) {
    throw new InvalidJournalEntry('origin')
  }
  if (raw.bytes !== undefined && (!Number.isInteger(raw.bytes) || (raw.bytes as number) < 0)) {
    throw new InvalidJournalEntry('bytes')
  }
  if (outcome === 'rejected') {
    if (!isCode(raw.code, true)) throw new InvalidJournalEntry('code')
  } else {
    if (!isName(raw.agent)) throw new InvalidJournalEntry('agent')
    if (raw.task !== undefined && !isName(raw.task)) throw new InvalidJournalEntry('task')
    if (typeof raw.verb !== 'string' || !Object.hasOwn(VERBS, raw.verb)) throw new InvalidJournalEntry('verb')
    if (raw.verdict !== undefined && raw.verdict !== 'clean' && raw.verdict !== 'finding') {
      throw new InvalidJournalEntry('verdict')
    }
    if (outcome === 'refused' && !isCode(raw.code, false)) throw new InvalidJournalEntry('code')
  }
  const written: Record<string, unknown> = {}
  for (const key of allowed) if (raw[key] !== undefined) written[key] = raw[key]
  return written as unknown as JournalEntry
}

function isName(value: unknown): boolean {
  return typeof value === 'string' && value !== '' && value.length <= MAX_NAME
}

function isCode(value: unknown, door: boolean): boolean {
  if (typeof value !== 'string') return false
  return (BRIDGE_REFUSALS as readonly string[]).includes(value) || (door && Object.hasOwn(DOOR_REJECTIONS, value))
}

export class Journal {
  private constructor(
    readonly dir: string,
    readonly retentionDays: number,
  ) {}

  /** Opens the journal in `dir` (`<data>/journal`), creating the folder 0700 when it is missing. */
  static open(dir: string, options: { retentionDays: number }): Journal {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    return new Journal(dir, options.retentionDays)
  }

  /** Appends the entry and fsyncs it before resolving; rejects when it is not written. */
  async record(entry: JournalEntry): Promise<void> {
    const written = checkEntry(entry)
    const day = new Date(written.at).toISOString().slice(0, 10)
    const handle = await open(path.join(this.dir, `${day}.jsonl`), 'a', 0o600)
    try {
      await handle.write(`${JSON.stringify(written)}\n`)
      await handle.sync()
    } finally {
      await handle.close()
    }
  }
}

/** The envelope an agent gets instead of an answer the journal could not record. */
export type JournalRefusal = ReturnType<typeof refuse>

/**
 * The one way an answer leaves the daemon: the entry is recorded (appended and fsynced) first,
 * and only then is `send()` called to send the answer. When the record fails, `send` is called
 * with the `internal` refusal instead, which the wrapper builds itself and which carries nothing
 * of the page. Resolves whether the entry was recorded, so the caller can log the failure.
 */
export async function answerAfterRecord(
  journal: Journal,
  entry: JournalEntry,
  send: (refusal?: JournalRefusal) => void | Promise<void>,
): Promise<boolean> {
  try {
    await journal.record(entry)
  } catch {
    // i18n-exempt: a refusal read by the agent over MCP, not by the person
    await send(refuse('internal', 'The journal could not record this answer, so it was not sent.'))
    return false
  }
  await send()
  return true
}
