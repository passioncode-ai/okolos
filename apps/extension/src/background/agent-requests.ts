import { OKOLOS_GATES, refuse, type BridgeResult, type OkolosGate, type OkolosRequestLiftResult, type OkolosRequestState } from '@okolos/contracts'

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
/** Where the requests live in `storage.local`. */
export const REQUESTS_KEY = 'agent:requests'

export interface LiftRequest {
  readonly id: string
  readonly gate: OkolosGate
  readonly host: string
  readonly agentId: string
  readonly agentName: string
  readonly createdAt: number
  readonly expiresAt: number
  readonly state: 'waiting' | 'allowed' | 'declined'
}

export interface RequestDeps {
  load(): Promise<readonly LiftRequest[]>
  save(requests: readonly LiftRequest[]): Promise<void>
  newId(): string
  now(): number
  journal(explainKey: 'logAgentAsked' | 'logAgentAllowed' | 'logAgentDeclined', args: readonly string[], agentId: string): Promise<void>
  /** Lifts `gate` for `host` as the person's own press on that gate does. */
  lift(gate: OkolosGate, host: string): Promise<void>
}

const HOST = /^[a-z0-9.-]{1,253}$/

/** Its state now: a waiting request past its ten minutes has expired. */
export function stateOf(request: LiftRequest, now: number): OkolosRequestState {
  return request.state === 'waiting' && now > request.expiresAt ? 'expired' : request.state
}

/** The requests the person still has to answer, oldest first. */
export function waitingRequests(requests: readonly LiftRequest[], now: number): LiftRequest[] {
  return requests.filter((request) => stateOf(request, now) === 'waiting').sort((a, b) => a.createdAt - b.createdAt)
}

/** Drops what is over and a day old, so the list never grows without end. */
function kept(requests: readonly LiftRequest[], now: number): LiftRequest[] {
  return requests.filter((request) => stateOf(request, now) === 'waiting' || now - request.createdAt < 86_400_000).slice(-50)
}

function refused(message: string): BridgeResult<unknown> {
  return refuse('internal', message)
}

export async function answerRequest(verb: string, input: unknown, by: unknown, deps: RequestDeps): Promise<BridgeResult<unknown>> {
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
  await deps.journal('logAgentAsked', [request.agentName, host], request.agentId)
  const data: OkolosRequestLiftResult = { requestId: request.id, state: 'waiting' }
  return { success: true, data }
}

/** The person's answer to one request, from the popup. A request already answered or expired stays as it is. */
export async function decideRequest(id: string, allow: boolean, deps: RequestDeps): Promise<{ ok: boolean }> {
  const now = deps.now()
  const requests = await deps.load()
  const request = requests.find((candidate) => candidate.id === id)
  if (request === undefined || stateOf(request, now) !== 'waiting') return { ok: false }
  if (allow) await deps.lift(request.gate, request.host)
  await deps.save(requests.map((candidate) => (candidate.id === id ? { ...candidate, state: allow ? 'allowed' : 'declined' } : candidate)))
  await deps.journal(allow ? 'logAgentAllowed' : 'logAgentDeclined', [request.agentName, request.host], request.agentId)
  return { ok: true }
}
