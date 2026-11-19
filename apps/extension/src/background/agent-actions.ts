import { refuse, type BridgeResult, type OkolosActionResult } from '@okolos/contracts'

/**
 * What an agent does in Okolos that the person can undo (B-218 wave (c), spec
 * `docs/superpowers/specs/2026-11-19-agent-door-wave-c.md`).
 *
 * Each action calls the same function the person's button calls (WC-3), only after checking that
 * what it names is there (WC-4), and is journaled with the agent's name (WC-1). Three of the four
 * weaken protection, so their journal entry says so (`weakens`), for the popup and the undo.
 */

export const ACTION_VERBS = ['okolos.trust.revoke', 'okolos.finding.resolve', 'okolos.finding.defer', 'okolos.extension.accept'] as const

export interface ActionAgent {
  readonly agentId: string
  readonly name: string
}

export interface AgentActionEntry {
  readonly explainKey: 'logAgentResolved' | 'logAgentDeferred' | 'logAgentAccepted' | 'logAgentUntrusted'
  readonly explainArgs: readonly string[]
  readonly agentId: string
  readonly verb: (typeof ACTION_VERBS)[number]
  /** What the action named: a finding's id, an extension's id or a domain. */
  readonly ref: string
  /** It lowered a protection, and the person can undo it (WC-2). */
  readonly weakens: boolean
  /** What the undo puts back, when the action replaced something: an extension's earlier snapshot. */
  readonly previous?: string
}

export interface ActionSinks {
  /** An open finding's host, or null when there is no open finding with this id. */
  openFinding(id: string): Promise<{ readonly host: string | null } | null>
  /** Whether Okolos lists a change of this extension waiting for the person. */
  changedExtension(id: string): Promise<boolean>
  trusted(domain: string): Promise<boolean>
  resolve(id: string): Promise<void>
  defer(id: string, until: string): Promise<void>
  /** Accepts the change and answers what it replaced, for the undo (JSON, or null when there was none). */
  accept(id: string): Promise<string | null>
  untrust(domain: string): Promise<void>
  journal(entry: AgentActionEntry): Promise<void>
  now(): number
}

const DAY_MS = 86_400_000

/** A name the daemon checked when the agent paired (`apps/agent/src/pairing/name.ts`); kept short here too. */
function nameOf(by: unknown): ActionAgent | null {
  const agent = by as { agentId?: unknown; name?: unknown } | null
  if (typeof agent?.agentId !== 'string' || typeof agent.name !== 'string') return null
  return { agentId: agent.agentId.slice(0, 64), name: agent.name.slice(0, 40) }
}

function done(): BridgeResult<unknown> {
  const data: OkolosActionResult = { done: true }
  return { success: true, data }
}

function refused(message: string): BridgeResult<unknown> {
  return refuse('internal', message)
}

export async function answerAction(verb: string, input: unknown, by: unknown, sinks: ActionSinks): Promise<BridgeResult<unknown>> {
  const agent = nameOf(by)
  // i18n-exempt: read by the agent through Okolos Agent, not by the person
  if (agent === null) return refused('This version of Okolos Agent does not say which agent asked.')
  const args = (input ?? {}) as { id?: unknown; days?: unknown; domain?: unknown }

  switch (verb) {
    case 'okolos.finding.resolve':
    case 'okolos.finding.defer': {
      const id = String(args.id ?? '')
      const finding = await sinks.openFinding(id)
      // i18n-exempt: read by the agent through Okolos Agent, not by the person
      if (finding === null) return refused('There is no open finding with that id.')
      const host = finding.host ?? '?'
      if (verb === 'okolos.finding.resolve') {
        await sinks.resolve(id)
        await sinks.journal({ explainKey: 'logAgentResolved', explainArgs: [agent.name, host], agentId: agent.agentId, verb, ref: id, weakens: true })
        return done()
      }
      const days = Number(args.days)
      // i18n-exempt: read by the agent through Okolos Agent, not by the person
      if (!Number.isInteger(days) || days < 1 || days > 30) return refused('A finding is put off for 1 to 30 days.')
      const until = new Date(sinks.now() + days * DAY_MS).toISOString()
      await sinks.defer(id, until)
      await sinks.journal({ explainKey: 'logAgentDeferred', explainArgs: [agent.name, host, until.slice(0, 10)], agentId: agent.agentId, verb, ref: id, weakens: true })
      return done()
    }
    case 'okolos.extension.accept': {
      const id = String(args.id ?? '')
      // i18n-exempt: read by the agent through Okolos Agent, not by the person
      if (!(await sinks.changedExtension(id))) return refused('Okolos lists no change of an extension with that id.')
      const previous = await sinks.accept(id)
      await sinks.journal({
        explainKey: 'logAgentAccepted',
        explainArgs: [agent.name, id],
        agentId: agent.agentId,
        verb,
        ref: id,
        weakens: true,
        ...(previous === null ? {} : { previous }),
      })
      return done()
    }
    case 'okolos.trust.revoke': {
      const domain = String(args.domain ?? '').toLowerCase()
      // i18n-exempt: read by the agent through Okolos Agent, not by the person
      if (!(await sinks.trusted(domain))) return refused('That site is not among the trusted ones.')
      await sinks.untrust(domain)
      await sinks.journal({ explainKey: 'logAgentUntrusted', explainArgs: [agent.name, domain], agentId: agent.agentId, verb, ref: domain, weakens: false })
      return done()
    }
    default:
      // i18n-exempt: read by the agent through Okolos Agent, not by the person
      return refused('This version of Okolos does not do that.')
  }
}
