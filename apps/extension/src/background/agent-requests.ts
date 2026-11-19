import { OKOLOS_GATES, refuse, type BridgeResult, type OkolosGate, type OkolosRequestLiftResult } from '@okolos/contracts'

import { stateOf, type LiftRequest } from './agent-request-state.js'

export { REQUESTS_KEY, stateOf, waitingRequests, type LiftRequest } from './agent-request-state.js'

/**
 * An agent asks to lift a gate, and only the person lifts it (B-218 wave (d), spec
 * `docs/superpowers/specs/2026-11-19-agent-door-wave-d.md`).
 *
 * The request holds the agent's name (checked by Okolos Agent when it paired), the gate and the
 * host: no words of the agent's (WD-2). It waits ten minutes (WD-3); the popup shows it, and the
 * person's «Разрешить» does what «Всё равно продолжить» does for that host. The gate on an agent's
 * own action is not lifted from here: it waits on the page, for the press on the page (О-8).
 */

export const REQUEST_VERBS = ['okolos.request.lift', 'okolos.request.state'] as const
export const REQUEST_LIFETIME_MS = 10 * 60_000
/** The journal's sentences for a request, by what happened. */
export const REQUEST_LOG_KEY = { asked: 'logAgentAsked', allowed: 'logAgentAllowed', declined: 'logAgentDeclined' } as const

export interface AgentRequestDeps {
  load(): Promise<readonly LiftRequest[]>
  save(requests: readonly LiftRequest[]): Promise<void>
  newId(): string
  now(): number
  journal(explainKey: (typeof REQUEST_LOG_KEY)[keyof typeof REQUEST_LOG_KEY], args: readonly string[], agentId: string): Promise<void>
  /** Lifts `gate` for `host` as the person's own press on that gate does. */
  lift(gate: OkolosGate, host: string): Promise<void>
}

const HOST = /^[a-z0-9.-]{1,253}$/

/** Drops what is over and a day old, so the list never grows without end. */
function kept(requests: readonly LiftRequest[], now: number): LiftRequest[] {
  return requests.filter((request) => stateOf(request, now) === 'waiting' || now - request.createdAt < 86_400_000).slice(-50)
}

function refused(message: string): BridgeResult<unknown> {
  return refuse('internal', message)
}

export async function answerRequest(verb: string, input: unknown, by: unknown, deps: AgentRequestDeps): Promise<BridgeResult<unknown>> {
  const now = deps.now()
  const requests = await deps.load()
  if (verb === 'okolos.request.state') {
    const id = String((input as { requestId?: unknown } | null)?.requestId ?? '')
    const request = requests.find((candidate) => candidate.id === id)
    // i18n-exempt: read by the agent through Okolos Agent, not by the person
    if (request === undefined) return refused('There is no request with that id.')
    return { success: true, data: { state: stateOf(request, now) } }
  }
  // i18n-exempt: read by the agent through Okolos Agent, not by the person
  if (verb !== 'okolos.request.lift') return refused('This version of Okolos does not do that.')

  const agent = by as { agentId?: unknown; name?: unknown } | null
  if (typeof agent?.agentId !== 'string' || typeof agent.name !== 'string') {
    // i18n-exempt: read by the agent through Okolos Agent, not by the person
    return refused('This version of Okolos Agent does not say which agent asked.')
  }
  const args = (input ?? {}) as { gate?: unknown; host?: unknown }
  const gate = args.gate as OkolosGate
  const host = String(args.host ?? '').toLowerCase()
  // i18n-exempt: read by the agent through Okolos Agent, not by the person
  if (!(OKOLOS_GATES as readonly unknown[]).includes(gate) || !HOST.test(host)) return refused('A request names a gate Okolos has and a host.')
  if (gate === 'agent-action') {
    // i18n-exempt: read by the agent through Okolos Agent, not by the person
    return refused('The gate on an agent action is lifted only by the press on the page it stops.')
  }
  const same = requests.find((request) => request.gate === gate && request.host === host && stateOf(request, now) === 'waiting')
  if (same !== undefined) {
    const data: OkolosRequestLiftResult = { requestId: same.id, state: 'waiting' }
    return { success: true, data }
  }
  const request: LiftRequest = {
    id: deps.newId(),
    gate,
    host,
    agentId: agent.agentId.slice(0, 64),
    agentName: agent.name.slice(0, 40),
    createdAt: now,
    expiresAt: now + REQUEST_LIFETIME_MS,
    state: 'waiting',
  }
  await deps.save([...kept(requests, now), request])
  await deps.journal(REQUEST_LOG_KEY.asked, [request.agentName, host], request.agentId)
  const data: OkolosRequestLiftResult = { requestId: request.id, state: 'waiting' }
  return { success: true, data }
}

/** The person's answer to one request, from the popup. A request already answered or expired stays as it is. */
export async function decideRequest(id: string, allow: boolean, deps: AgentRequestDeps): Promise<{ ok: boolean }> {
  const now = deps.now()
  const requests = await deps.load()
  const request = requests.find((candidate) => candidate.id === id)
  if (request === undefined || stateOf(request, now) !== 'waiting') return { ok: false }
  if (allow) await deps.lift(request.gate, request.host)
  await deps.save(requests.map((candidate) => (candidate.id === id ? { ...candidate, state: allow ? 'allowed' : 'declined' } : candidate)))
  await deps.journal(allow ? REQUEST_LOG_KEY.allowed : REQUEST_LOG_KEY.declined, [request.agentName, request.host], request.agentId)
  return { ok: true }
}
