import type { OkolosGate, OkolosRequestState } from '@okolos/contracts'

/**
 * An agent's request to lift a gate, as it is kept (B-218 wave (d)). Apart from the background's
 * handling in `agent-requests.ts`, so the popup reads the waiting ones without carrying it.
 */

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

/** Its state now: a waiting request past its ten minutes has expired. */
export function stateOf(request: LiftRequest, now: number): OkolosRequestState {
  return request.state === 'waiting' && now > request.expiresAt ? 'expired' : request.state
}

/** The requests the person still has to answer, oldest first. */
export function waitingRequests(requests: readonly LiftRequest[], now: number): LiftRequest[] {
  return requests.filter((request) => stateOf(request, now) === 'waiting').sort((a, b) => a.createdAt - b.createdAt)
}
