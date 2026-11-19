import {
  OKOLOS_READ_LIMIT,
  refuse,
  type AuditEntry,
  type BridgeResult,
  type OkolosAuditResult,
  type OkolosExtensionsResult,
  type OkolosJournalResult,
  type OkolosQueueItem,
  type OkolosQueueResult,
  type OkolosVerdictResult,
  type Severity,
} from '@okolos/contracts'

/**
 * What Okolos answers to an agent's read through Okolos Agent (B-218 wave (b), spec
 * `docs/superpowers/specs/2026-11-19-agent-door-wave-b.md`).
 *
 * **No page content crosses (WB-1).** A finding holds the hidden instruction Okolos found, and
 * the journal's explanations carry their arguments; either, handed to an agent, is the very text
 * Okolos protects it from. So each answer is built field by field from enumerations, numbers,
 * times and hosts, and never by copying a record: a field a later build adds to a record does not
 * cross until someone adds it here.
 */

export interface ReadFinding {
  readonly id: string
  readonly createdAt: string
  readonly subject: string
  readonly resolvedAt: string | null
  readonly verdict?: { readonly category: string; readonly severity: Severity }
}

export interface ReadJournalEntry {
  readonly createdAt: string
  readonly kind: string
  readonly detail?: Readonly<Record<string, unknown>>
}

export interface ReadChange {
  readonly id: string
  readonly kind: string
  readonly severity: Severity
}

/** Where the answers are read from; the background passes the store, a test passes arrays. */
export interface ReadSources {
  findings(): Promise<readonly ReadFinding[]>
  journal(): Promise<readonly ReadJournalEntry[]>
  outbound(): Promise<readonly AuditEntry[]>
  /** The block list `url` is on, in the words the person reads it in, or null. */
  blockedBy(url: string): Promise<{ readonly list: string; readonly entryDate: string | null } | null>
  trusted(): Promise<readonly string[]>
  extensionChanges(): Promise<readonly ReadChange[]>
}

export const READ_VERBS = ['okolos.queue', 'okolos.verdict', 'okolos.journal', 'okolos.audit', 'okolos.extensions'] as const

const SEVERITIES: readonly Severity[] = ['critical', 'major', 'minor', 'info']
/** An identifier-like word: what the journal's `outcome` and a category are. */
const WORD = /^[a-z][a-z0-9-]{0,39}$/
/** A host, and nothing else: no path, no query, no credentials. */
const HOST = /^[a-z0-9.-]{1,253}$/i

function limitOf(input: unknown): number {
  const limit = (input as { limit?: unknown } | null)?.limit
  return typeof limit === 'number' && Number.isInteger(limit) && limit >= 1 && limit <= OKOLOS_READ_LIMIT ? limit : 20
}

/** The host of a finding's subject (`page:https://host/…`), or null. */
function hostOf(subject: string): string | null {
  try {
    const host = new URL(subject.replace(/^page:/, '')).hostname
    return HOST.test(host) ? host : null
  } catch {
    return null
  }
}

const newestFirst = <T extends { readonly createdAt: string }>(rows: readonly T[]): T[] =>
  [...rows].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))

function word(value: unknown): string | null {
  return typeof value === 'string' && WORD.test(value) ? value : null
}

function severity(value: unknown): Severity {
  return SEVERITIES.includes(value as Severity) ? (value as Severity) : 'info'
}

/** The answer to one read verb, or a refusal for a verb or input this build does not take. */
export async function answerRead(verb: string, input: unknown, sources: ReadSources): Promise<BridgeResult<unknown>> {
  switch (verb) {
    case 'okolos.queue': {
      const open = (await sources.findings()).filter((finding) => finding.resolvedAt === null)
      const items = newestFirst(open)
        .slice(0, limitOf(input))
        .map(
          (finding): OkolosQueueItem => ({
            id: finding.id,
            category: word(finding.verdict?.category) ?? 'unknown',
            severity: severity(finding.verdict?.severity),
            host: hostOf(finding.subject),
            foundAt: finding.createdAt,
          }),
        )
      const data: OkolosQueueResult = { items, open: open.length }
      return { success: true, data }
    }
    case 'okolos.verdict': {
      const url = (input as { url?: unknown } | null)?.url
      let host: string
      try {
        const parsed = new URL(String(url))
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new TypeError('scheme')
        host = parsed.hostname
      } catch {
        // i18n-exempt: read by the agent through Okolos Agent, not by the person
        return refuse('internal', 'okolos.verdict takes an http or https address.')
      }
      const findings: Record<string, number> = {}
      for (const finding of await sources.findings()) {
        if (finding.resolvedAt !== null || hostOf(finding.subject) !== host) continue
        const category = word(finding.verdict?.category) ?? 'unknown'
        findings[category] = (findings[category] ?? 0) + 1
      }
      const trusted = (await sources.trusted()).some((domain) => host === domain || host.endsWith(`.${domain}`))
      const data: OkolosVerdictResult = { host, blocked: await sources.blockedBy(`https://${host}/`), findings, trusted }
      return { success: true, data }
    }
    case 'okolos.journal': {
      const entries = newestFirst(await sources.journal())
        .slice(0, limitOf(input))
        .map((entry) => {
          const host = entry.detail?.['host']
          return {
            at: entry.createdAt,
            kind: word(entry.kind) ?? 'unknown',
            outcome: word(entry.detail?.['outcome']),
            host: typeof host === 'string' && HOST.test(host) ? host : null,
          }
        })
      const data: OkolosJournalResult = { entries }
      return { success: true, data }
    }
    case 'okolos.audit': {
      const rows = newestFirst(await sources.outbound())
        .slice(0, limitOf(input))
        .map((row) => ({
          at: row.createdAt,
          destination: HOST.test(String(row.destination)) ? String(row.destination) : 'unknown',
          purpose: word(row.purpose) ?? 'unknown',
          payloadKind: word(String(row.payloadShape ?? '').split(':')[0]) ?? 'unknown',
          outcome: word(row.outcome) ?? 'unknown',
        }))
      const data: OkolosAuditResult = { rows }
      return { success: true, data }
    }
    case 'okolos.extensions': {
      const changes = (await sources.extensionChanges()).map((change) => ({
        id: /^[a-z0-9@._{}-]{1,128}$/i.test(change.id) ? change.id : 'unknown',
        change: word(change.kind) ?? 'unknown',
        severity: severity(change.severity),
      }))
      const data: OkolosExtensionsResult = { changes }
      return { success: true, data }
    }
    default:
      // i18n-exempt: read by the agent through Okolos Agent, not by the person
      return refuse('internal', 'This version of Okolos does not answer that verb.')
  }
}
