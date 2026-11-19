import { resolveArgs, t } from '@okolos/i18n'
import { buildQueue, diffSince, QUEUE_LIMIT, type JournalEntry, type QueueItem } from '@okolos/core-queue'
import type { FindingRecord, JournalRecord } from '@okolos/storage'
import type { PopupState } from '@okolos/ui'

import { waitingRequests, type LiftRequest } from '../background/agent-requests.js'

/** The popup's ready state — the only one this module can produce. */
type ReadyState = Extract<PopupState, { kind: 'ready' }>

/**
 * Turning what is in storage into the popup's three-second answer.
 *
 * Kept apart from the page wiring so the rules can be tested without a browser:
 * which findings count as outstanding, when a page may be called clean, and how
 * a stored record becomes a sentence.
 */

/** A journal record whose shape we do not recognise is counted, not guessed at. */
export interface MappedJournal {
  readonly entries: readonly JournalEntry[]
  readonly unreadable: number
}

export function toQueueItems(
  findings: readonly FindingRecord[],
  /** `defer:<id>` settings, so "not now" survives the popup closing. */
  deferrals: ReadonlyMap<string, string> = new Map(),
): QueueItem[] {
  return findings
    .filter((finding) => finding.resolvedAt === null)
    .map((finding) => {
      const verdict = finding.verdict
      const snippet = verdict?.evidence.find((item) => item.snippet)?.snippet
      const item: QueueItem = {
        id: finding.id,
        severity: verdict?.severity ?? 'minor',
        createdAt: finding.createdAt,
        summary: snippet
          ? t('popupQueueHidden', hostOf(finding.subject), snippet.slice(0, 80))
          : t('popupQueueFound', hostOf(finding.subject)),
        actionLabel: t('popupQueueOpen'),
        // Absent on purpose when there is no verdict to read it from: the queue
        // then says it is ranking by severity alone rather than implying more.
        ...(verdict ? { fixability: 'one-click' as const } : {}),
        ...(deferrals.has(finding.id) ? { deferredUntil: deferrals.get(finding.id) as string } : {}),
      }
      return item
    })
}

export function mapJournal(records: readonly JournalRecord[]): MappedJournal {
  const entries: JournalEntry[] = []
  let unreadable = 0

  for (const record of records) {
    if (typeof record.createdAt !== 'string' || typeof record.kind !== 'string') {
      unreadable += 1
      continue
    }
    const detail = record.detail ?? {}
    entries.push({
      id: record.id,
      createdAt: record.createdAt,
      kind: record.kind,
      summary: summarise(detail, record.kind),
      // Only when it is there and is text: a record written by an older build has none, and
      // the sentence stands on its own without it.
      ...(typeof detail.diagnostic === 'string' && detail.diagnostic !== ''
        ? { diagnostic: detail.diagnostic }
        : {}),
      // A decision the user made is not the same event as one the product made,
      // and the journal is the place where that difference is legible.
      automatic: detail.reason !== 'user-blocked' && detail.reason !== 'user-allowed' && detail.reason !== 'agent-action',
      ...(detail.reason === 'agent-action' ? { byAgent: true } : {}),
      ...(detail.reason === 'agent-action' && detail.weakens === true
        ? { undo: typeof detail.undoneAt === 'string' ? ('done' as const) : ('available' as const) }
        : {}),
    })
  }

  return { entries, unreadable }
}

/**
 * What a record says when it carries no explanation of its own.
 *
 * `error` used to read "Something went wrong", which the voice forbids by name
 * — it is a refusal to speak. This default appears only when the record has no
 * explanation, so the true statement is that the explanation is missing.
 */
const DEFAULT_SUMMARY_KEY: Record<JournalEntry['kind'], string> = {
  verdict: 'journalDefaultVerdict',
  action: 'journalDefaultAction',
  error: 'journalDefaultError',
}

export interface PopupInputs {
  readonly findings: readonly FindingRecord[]
  readonly journal: readonly JournalRecord[]
  readonly activeUrl: string | null
  readonly lastCheck: string | null
  readonly expanded: boolean
  readonly deferrals?: ReadonlyMap<string, string>
  /** ISO now. Without it the ranker cannot tell a live deferral from a stale one. */
  readonly now?: string
  /** Agents' requests to lift a gate (B-218 wave (d)); only the waiting ones are shown. */
  readonly requests?: readonly LiftRequest[]
}

export function buildPopupState(inputs: PopupInputs): ReadyState {
  const items = toQueueItems(inputs.findings, inputs.deferrals)
  const queue = buildQueue(
    items,
    inputs.expanded ? Math.max(items.length, QUEUE_LIMIT) : QUEUE_LIMIT,
    inputs.now ?? '',
  )
  const { entries, unreadable } = mapJournal(inputs.journal)

  return {
    kind: 'ready',
    page: pageVerdict(inputs.activeUrl, inputs.findings),
    queue,
    changed: diffSince(entries, inputs.lastCheck, { unreadable }).total,
    lastCheck: inputs.lastCheck,
    // The sentence is the agent's checked name, the gate in the catalogue's words and the host:
    // never a word the agent wrote (WD-2).
    requests: waitingRequests(inputs.requests ?? [], Date.parse(inputs.now ?? '') || Date.now()).map((request) => ({
      id: request.id,
      line: t(request.gate === 'lookalike' ? 'agentRequestLookalike' : 'agentRequestBlock', request.agentName, request.host),
    })),
  }
}

function pageVerdict(
  activeUrl: string | null,
  findings: readonly FindingRecord[],
): { verdict: 'clean' | 'finding' | 'unknown'; reason: string } {
  if (activeUrl === null) {
    // Not knowing which page this is means not being able to say it is clean.
    return { verdict: 'unknown', reason: t('popupPageUnknown') }
  }

  const subject = subjectOf(activeUrl)
  if (subject === null) {
    return { verdict: 'unknown', reason: t('popupPageUnknown') }
  }

  const open = findings.filter(
    (finding) => finding.resolvedAt === null && finding.subject === subject,
  )
  return open.length === 0
    ? { verdict: 'clean', reason: t('popupPageClean') }
    : {
        verdict: 'finding',
        // The count goes in as a number the catalogue places, because English
        // pluralises with an -s and Russian does not pluralise that way at all.
        reason: t('popupPageFinding', String(open.length)),
      }
}

/** The same key the background writes: `page:<origin><path>`. */
export function subjectOf(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    return `page:${parsed.origin}${parsed.pathname}`
  } catch {
    return null
  }
}

function hostOf(subject: string): string {
  try {
    return new URL(subject.replace(/^page:/, '')).host
  } catch {
    return 'this page'
  }
}

/**
 * The one place a stored record becomes a sentence.
 *
 * Three sources, in order, and the order is the whole design:
 *
 *   1. `explainKey` (+ `explainArgs`, and `explainArgKeys` for the arguments that
 *      are messages rather than data) — written by everything that has been
 *      moved to the catalogue. Resolved **now**, so the reader's language
 *      decides, not the language in force when the event happened.
 *   2. `explain` — a sentence stored before that move. It stays English, and
 *      that is honest: it is what was recorded. Rewriting history to look
 *      translated would be the lie.
 *   3. the default for its kind, when the record explains nothing at all.
 *
 * No migration, deliberately. A migration would have to invent which key an old
 * sentence came from, and inventing it is how a journal stops being evidence.
 */
function summarise(detail: Record<string, unknown>, kind: JournalEntry['kind']): string {
  const key = typeof detail.explainKey === 'string' ? detail.explainKey : null
  if (key !== null) {
    const args = Array.isArray(detail.explainArgs)
      ? detail.explainArgs.filter((arg): arg is string => typeof arg === 'string')
      : []
    /**
     * An argument can be a message of ours rather than data — a feed's name, "an unnamed
     * party" — and those were stored resolved, in the language of the write. A reader who
     * switched language got their own sentence with one word of the old one inside it
     * (B-77). `explainArgKeys` says which positions to resolve again; a row written before
     * the convention has none, and falls back to the words it was written with.
     */
    const argKeys = Array.isArray(detail.explainArgKeys) ? detail.explainArgKeys : []
    return t(key, ...resolveArgs(args, argKeys))
  }
  if (typeof detail.explain === 'string') return detail.explain
  /**
   * A kind this build does not know still gets a sentence.
   *
   * The union shrank on 2026-08-20 — `detector-disabled` was removed as vocabulary for a
   * state the product cannot reach — and a shrinking union is exactly when a stored row
   * can name something the reader has no entry for. Without the fallback, the lookup is
   * `undefined` and `t(undefined)` renders nothing: a row that exists, is displayed, and
   * says **nothing at all**, which is the one failure a journal must not have. The kind
   * itself is shown instead, bracketed by the resolver like any unknown key.
   */
  return t(DEFAULT_SUMMARY_KEY[kind] ?? kind)
}
