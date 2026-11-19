/**
 * What the page of Okolos Agent shows (SCR-23 agent pairing, SCR-24 agent activity;
 * N-015, REQ-64, REQ-65), built on the server in the person's language.
 *
 * The page's script only places these strings with `textContent`: no string is
 * written in the script and no markup crosses. Every sentence is a key of the
 * agent catalogue; a missing one shows as `[key]`, so a stale catalogue is seen,
 * never filled in by code. A request id never leaves the daemon: rows carry the
 * handle the page acts by (plan test 2). Verbs and refusal codes are said in words
 * (`verb_*`, `refusal_*`, `rejection_*`), never as identifiers (test 18).
 */
import { refusalKey, BRIDGE_REFUSALS, type BridgeRefusal } from '@okolos/contracts'
import type { Resolver } from '@okolos/i18n'

import type { RecentJournal, RefusalEntry, RejectedLine } from '../journal/journal.js'
import { namesLookAlike } from '../pairing/name.js'
import type { LinkState } from '../extension/link.js'
import type { AgentRecord, PublicRequest } from '../pairing/pairing.js'
import { goalShown, type TaskSnapshot } from '../tasks/tasks.js'

/** How many refusals and door rejections the page lists. */
export const REFUSALS_SHOWN = 20

export interface RequestRow {
  readonly handle: string
  readonly state: PublicRequest['state']
  readonly agent: string
  readonly code: string
  readonly asked: string
  /** What the row says instead of buttons (expired, confirmed, claim_expired), or null with buttons. */
  readonly status: string | null
  readonly duplicate: string | null
  readonly lookalike: { readonly line: string; readonly agents: readonly string[] } | null
}

export interface AgentRow {
  readonly agentId: string
  readonly name: string
  readonly since: string
  readonly tasks: string
}

export interface TaskRow {
  readonly agent: string
  readonly profile: string
  readonly goal: string
  readonly sites: string
  readonly time: string
  readonly steps: string
  readonly window: string
}

export interface PageView {
  readonly strings: Readonly<Record<string, string>>
  readonly pairing:
    | { readonly state: 'error'; readonly error: string }
    | {
        readonly state: 'empty' | 'success'
        readonly requests: readonly RequestRow[]
        readonly agents: readonly AgentRow[]
        /** The store-unwritable state: the last write of the access list failed, in words, or null. */
        readonly unwritable: string | null
      }
  /** The Okolos extension's link (B-218): not connected, a code shown, or connected since when. */
  readonly okolos: {
    readonly state: 'unpaired' | 'code' | 'paired'
    readonly line: string
    /** The six digits to type into Okolos, only in the `code` state. */
    readonly code: string | null
  }
  readonly activity: {
    readonly state: 'empty' | 'success' | 'journal-unreadable' | 'day-full'
    readonly tasks: readonly TaskRow[]
    readonly refusals: readonly string[]
    readonly door: readonly string[]
    /** Shown above the list when it cannot be called complete; then `refusalsEmpty` is never said. */
    readonly notes: readonly string[]
    readonly journalError: string | null
  }
}

/** The page's fixed sentences: headings, buttons, the how-to line. */
const FIXED = [
  'agentPageTitle',
  'agentPageLoading',
  'pairingHeading',
  'pairingCompare',
  'pairingConfirm',
  'pairingDecline',
  'pairingGrants',
  'pairedHeading',
  'agentRevoke',
  'pairingEmpty',
  'tasksHeading',
  'tasksEmpty',
  'refusalsHeading',
  'refusalsEmpty',
  'journalLink',
  'pageSessionExpired',
  'pageStopping',
  'okolosHeading',
  'okolosConnect',
  'okolosDisconnect',
] as const

export interface ViewInput {
  readonly say: Resolver
  readonly now: number
  /** The door's origin, `http://127.0.0.1:<port>`, for the how-to line. */
  readonly doorUrl: string
  readonly pairing: { readonly requests: readonly PublicRequest[]; readonly agents: readonly AgentRecord[] } | { readonly unreadable: string }
  readonly tasks: readonly TaskSnapshot[]
  readonly journal: { readonly recent: RecentJournal } | { readonly failure: string }
  /** The last failed write of the journal, as a reason in words, or null. */
  readonly journalWriteFailure: string | null
  /** Spans in which the journal could not be written, ms since the epoch, oldest first. */
  readonly writeGaps?: readonly { readonly from: number; readonly to: number }[]
  /** The last failed write of the access list, as a reason in words, or null. */
  readonly pairingWriteFailure?: string | null
  readonly format: (at: number) => string
  /** The Okolos extension's link and the code the page shows, if any; absent reads as not connected. */
  readonly okolos?: { readonly link: LinkState; readonly code: { readonly code: string; readonly expiresAt: number } | null }
}

export function pageView(input: ViewInput): PageView {
  const { say, format } = input
  const strings: Record<string, string> = Object.fromEntries(FIXED.map((key) => [key, say(key)]))
  strings['pairingHow'] = say('pairingHow', [input.doorUrl])
  const agents = 'unreadable' in input.pairing ? [] : input.pairing.agents
  const label = (name: string, agentId: string, pairedAt: number | string): string => {
    const at = typeof pairedAt === 'number' ? pairedAt : Date.parse(pairedAt)
    const live = agents.some((a) => a.agentId === agentId)
    return say(live ? 'agentLabel' : 'agentLabelRevoked', [name, format(at)])
  }

  const pairing: PageView['pairing'] =
    'unreadable' in input.pairing
      ? { state: 'error', error: say('pairingStoreError', [input.pairing.unreadable]) }
      : (() => {
          const { requests } = input.pairing as { requests: readonly PublicRequest[] }
          const rows = requests.map((request): RequestRow => {
            const similar = agents.filter((a) => namesLookAlike(a.name, request.name))
            return {
              handle: request.handle,
              state: request.state,
              agent: say('pairingAgentName', [request.name]),
              code: `${request.code.slice(0, 3)} ${request.code.slice(3)}`,
              asked: `${say('pairingAsked', [format(request.createdAt)])}. ${say('pairingOpenUntil', [format(request.expiresAt)])}`,
              status:
                request.state === 'expired'
                  ? say('pairingExpired')
                  : request.state === 'confirmed'
                    ? say('pairingCollecting', [format(request.expiresAt)])
                    : request.state === 'claim_expired'
                      ? say('pairingClaimExpired')
                      : null,
              duplicate: requests.some((other) => other.handle !== request.handle && namesLookAlike(other.name, request.name))
                ? say('pairingDuplicate')
                : null,
              lookalike:
                similar.length === 0 ? null : { line: say('pairingLooksLikeAgent'), agents: similar.map((a) => label(a.name, a.agentId, a.pairedAt)) },
            }
          })
          const agentRows = agents.map((agent): AgentRow => {
            const held = input.tasks.filter((t) => t.agentId === agent.agentId).length
            return {
              agentId: agent.agentId,
              name: say('pairedAgentName', [agent.name]),
              since:
                agent.lastCallAt === null
                  ? say('pairedSinceNever', [format(agent.pairedAt)])
                  : say('pairedSince', [format(agent.pairedAt), format(agent.lastCallAt)]),
              tasks: say('pairedTasks', [String(held)]),
            }
          })
          return {
            state: rows.length + agentRows.length === 0 ? 'empty' : 'success',
            requests: rows,
            agents: agentRows,
            unwritable: input.pairingWriteFailure == null ? null : say('pairingStoreUnwritable', [input.pairingWriteFailure]),
          }
        })()

  const link = input.okolos?.link ?? { paired: false }
  const code = link.paired ? null : (input.okolos?.code ?? null)
  const okolos: PageView['okolos'] = link.paired
    ? { state: 'paired', line: say('okolosPaired', [format(link.pairedAt)]), code: null }
    : code === null
      ? { state: 'unpaired', line: say('okolosUnpaired'), code: null }
      : { state: 'code', line: say('okolosCode', [format(code.expiresAt)]), code: code.code }

  const nameOf = (agentId: string): AgentRecord | undefined => agents.find((a) => a.agentId === agentId)
  const tasks = [...input.tasks]
    .sort((a, b) => b.openedAt - a.openedAt)
    .map((task): TaskRow => {
      const agent = nameOf(task.agentId)
      const left = task.openedAt + task.scope.ttlSeconds * 1000 - input.now
      return {
        agent: agent === undefined ? say('agentLabelRevoked', ['?', '?']) : label(agent.name, agent.agentId, agent.pairedAt),
        profile: say(task.scope.profile === 'agent' ? 'taskProfileAgent' : 'taskProfileDisposable'),
        goal: say('taskGoal', [goalShown(task.scope.goal)]),
        sites: say('taskSites', [task.scope.origins.read.join(', ')]),
        time: task.expired || left <= 0 ? say('taskTimeOver') : say('taskTimeLeft', [String(Math.ceil(left / 60_000))]),
        steps: say('taskSteps', [String(task.stepsUsed), String(task.scope.stepBudget)]),
        window: say(task.windowOpen ? 'taskWindowOpen' : 'taskWindowClosed'),
      }
    })

  if ('failure' in input.journal) {
    return {
      strings,
      pairing,
      okolos,
      activity: { state: 'journal-unreadable', tasks, refusals: [], door: [], notes: [], journalError: say('journalUnreadable', [input.journal.failure]) },
    }
  }
  const journal = input.journal.recent
  const notes: string[] = []
  const today = utcDay(input.now)
  const fullToday = journal.dayFull.some((line) => utcDay(Date.parse(line.at)) === today)
  if (input.journalWriteFailure !== null || fullToday) notes.push(say('refusalsIncomplete'))
  if (journal.unreadable > 0) notes.push(say('journalLinesSkipped', [String(journal.unreadable)]))
  // A day that filled earlier, and a span the journal could not be written, are gaps the list names (N-006 round 8).
  const gaps = [
    ...journal.dayFull
      .filter((line) => utcDay(Date.parse(line.at)) !== today)
      .map((line) => ({ from: Date.parse(line.at), to: (utcDay(Date.parse(line.at)) + 1) * DAY_MS })),
    ...(input.writeGaps ?? []),
  ].sort((a, b) => a.from - b.from)
  for (const gap of gaps) notes.push(say('refusalsGap', [format(gap.from), format(gap.to)]))
  const refusals = journal.refusals.slice(-REFUSALS_SHOWN).reverse().map((entry) => refusalLine(say, format, entry, label))
  const door = [...journal.rejections.state, ...journal.rejections.request]
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, REFUSALS_SHOWN)
    .map((line) => doorLine(say, format, line))
  return {
    strings,
    pairing,
    okolos,
    activity: {
      state: fullToday ? 'day-full' : tasks.length === 0 ? 'empty' : 'success',
      tasks,
      refusals,
      door,
      notes,
      journalError: fullToday ? say('journalDayFull') : input.journalWriteFailure === null ? null : say('journalError', [input.journalWriteFailure]),
    },
  }
}

const DAY_MS = 86_400_000

/** The UTC day an instant falls on, as a day number: the journal's days are UTC days. */
function utcDay(ms: number): number {
  return Math.floor(ms / DAY_MS)
}

const FAILURES: ReadonlySet<string> = new Set(['internal', 'browser_offline', 'cleaning_incomplete'])

/** The key of a verb's phrase: `session.open` is `verb_session_open`; anything else is `verb_unknown`. */
function verbKey(verb: string): string {
  const known = ['open', 'snapshot', 'read', 'get', 'waitFor', 'close', 'session.open', 'hygiene.census', 'okolos.ping']
  return known.includes(verb) ? `verb_${verb.replace('.', '_')}` : 'verb_unknown'
}

function refusalLine(
  say: Resolver,
  format: (at: number) => string,
  entry: RefusalEntry,
  label: (name: string, agentId: string, pairedAt: number | string) => string,
): string {
  const code = entry.code
  const what = (BRIDGE_REFUSALS as readonly string[]).includes(code) ? say(refusalKey(code as BridgeRefusal)) : say(`refusal_${code}`)
  return say(FAILURES.has(code) ? 'refusalFailureLine' : 'refusalLine', [
    format(Date.parse(entry.at)),
    label(entry.agent, entry.agentId, entry.pairedAt),
    say(verbKey(entry.verb)),
    what,
  ])
}

/** A refusal at the door is said by its own key; refusalKey is never asked for these (plan test 7). */
function doorLine(say: Resolver, format: (at: number) => string, line: RejectedLine): string {
  const when = format(Date.parse(line.at))
  if (line.code === 'store_unreadable') return say('refusalDoorFailureLine', [when, say('rejection_store_unreadable')])
  return say('refusalDoorLine', [when, say(`rejection_${line.code}`)])
}
