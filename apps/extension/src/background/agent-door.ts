import type { BridgeResult, OkolosPingResult } from '@okolos/contracts'
import { request, type RequestDeps } from '@okolos/net'

import { ACTION_VERBS, answerAction, type ActionSinks } from './agent-actions.js'
import { answerRead, READ_VERBS, type ReadSources } from './agent-reads.js'
import { answerRequest, REQUEST_VERBS, type RequestDeps } from './agent-requests.js'

/**
 * Okolos's side of its link to Okolos Agent (B-218 wave (a), ADR-0022, spec
 * `docs/superpowers/specs/2026-11-19-agent-door-wave-a.md`).
 *
 * Okolos Agent cannot call the extension, so the extension calls in: once the person typed the
 * code the Okolos Agent page showed, the background keeps a token and an alarm, and each wake
 * asks for the requests agents left, answers them, and asks again until none are left or the
 * wake's budget is spent. Without a token there is no alarm and no request (WA-1).
 *
 * Every request goes through the network module under the purpose `agent-door`, to 127.0.0.1
 * only, and is written to the outbound log first, like any other.
 */

/** The alarm that wakes the background for Okolos Agent, created only while paired (WA-2). */
export const AGENT_DOOR_ALARM = 'okolos:agent'
/** Minutes between wakes; Okolos Agent tells an agent it waits about this long. */
export const AGENT_DOOR_PERIOD_MINUTES = 1
/** Where the link lives in `storage.local`; removed by disconnecting and by erasing all data. */
export const AGENT_DOOR_KEY = 'agent:link'
/** Okolos Agent's port on this device (`apps/agent`, fabric-service/0.1). */
export const AGENT_PORT = 47871
/** One wake answers requests for at most this long, then waits for the next (WA-2). */
export const WAKE_BUDGET_MS = 20_000

export interface AgentDoorLink {
  readonly token: string
  readonly pairedAt: string
}

export interface AgentDoorDeps {
  /** One POST to Okolos Agent through the network module; resolves with its status and JSON body. */
  post(path: string, body: unknown, token?: string): Promise<{ status: number; body: unknown }>
  load(): Promise<AgentDoorLink | undefined>
  save(link: AgentDoorLink): Promise<void>
  forget(): Promise<void>
  /** Creates the alarm, or clears it with `false`. */
  alarm(on: boolean): Promise<void>
  version(): string
  now(): number
  /** What the read verbs answer from (wave (b)); without it they are refused as unknown. */
  reads?: ReadSources
  /** What the undoable actions call (wave (c)); without it they are refused as unknown. */
  act?: ActionSinks
  /** Where an agent's requests to lift a gate wait for the person (wave (d)). */
  requests?: RequestDeps
}

export type PairOutcome = { readonly ok: true; readonly pairedAt: string } | { readonly ok: false; readonly reason: 'bad_code' | 'expired' | 'unreachable' }

/** The code the person typed; on success the link is kept and the alarm set. */
export async function pairAgentDoor(code: string, deps: AgentDoorDeps): Promise<PairOutcome> {
  let answer: { status: number; body: unknown }
  try {
    answer = await deps.post('/extension/pair', { code: code.trim() })
  } catch {
    return { ok: false, reason: 'unreachable' }
  }
  const body = answer.body as { token?: unknown; error?: unknown } | null
  if (answer.status === 200 && typeof body?.token === 'string' && body.token !== '') {
    const pairedAt = new Date(deps.now()).toISOString()
    await deps.save({ token: body.token, pairedAt })
    await deps.alarm(true)
    return { ok: true, pairedAt }
  }
  return { ok: false, reason: body?.error === 'expired' ? 'expired' : 'bad_code' }
}

/** Disconnects from this side: tells Okolos Agent if it can, and forgets the link either way. */
export async function releaseAgentDoor(deps: AgentDoorDeps): Promise<void> {
  const link = await deps.load()
  if (link !== undefined) await deps.post('/extension/release', {}, link.token).catch(() => undefined)
  await deps.forget()
  await deps.alarm(false)
}

export type WakeOutcome = 'not-paired' | 'answered' | 'idle' | 'disconnected' | 'unreachable'

/**
 * One wake: asks for requests and answers them until none are left or WAKE_BUDGET_MS passed. A
 * 401 means the link was ended on Okolos Agent's side (or its record is gone): it is forgotten
 * here too, with the alarm (WA-4).
 */
export async function wakeAgentDoor(deps: AgentDoorDeps): Promise<WakeOutcome> {
  const link = await deps.load()
  if (link === undefined) {
    await deps.alarm(false)
    return 'not-paired'
  }
  const started = deps.now()
  let answered = false
  while (deps.now() - started < WAKE_BUDGET_MS) {
    let next: { status: number; body: unknown }
    try {
      next = await deps.post('/extension/next', {}, link.token)
    } catch {
      return 'unreachable'
    }
    if (next.status === 401 || next.status === 403) {
      await deps.forget()
      await deps.alarm(false)
      return 'disconnected'
    }
    const requests = ((next.body as { requests?: unknown } | null)?.requests ?? []) as { id?: unknown; verb?: unknown }[]
    if (!Array.isArray(requests) || requests.length === 0) return answered ? 'answered' : 'idle'
    for (const request of requests) {
      if (typeof request.id !== 'string') continue
      const asked = request as { input?: unknown; by?: unknown }
      const result = await answer(request.verb, asked.input, asked.by, link, deps).catch(() => ({
        success: false as const,
        // i18n-exempt: read by the agent through Okolos Agent, not by the person
        error: { code: 'internal' as const, message: 'Okolos could not read what was asked.', retryable: true },
      }))
      // The verb rides beside the answer so the outbound log can name what was answered (WB-3).
      const verb = typeof request.verb === 'string' ? request.verb : 'unknown'
      await deps.post('/extension/answer', { id: request.id, verb, result }, link.token).catch(() => undefined)
      answered = true
    }
  }
  return answered ? 'answered' : 'idle'
}

/** What Okolos answers to one verb: `okolos.ping` (wave (a)), the reads (wave (b)) and the undoable actions (wave (c)). */
async function answer(verb: unknown, input: unknown, by: unknown, link: AgentDoorLink, deps: AgentDoorDeps): Promise<BridgeResult<unknown>> {
  if (verb === 'okolos.ping') {
    const data: OkolosPingResult = { extensionVersion: deps.version(), connectedSince: link.pairedAt }
    return { success: true, data }
  }
  if (deps.reads !== undefined && (READ_VERBS as readonly unknown[]).includes(verb)) return answerRead(String(verb), input, deps.reads)
  if (deps.act !== undefined && (ACTION_VERBS as readonly unknown[]).includes(verb)) return answerAction(String(verb), input, by, deps.act)
  if (deps.requests !== undefined && (REQUEST_VERBS as readonly unknown[]).includes(verb)) return answerRequest(String(verb), input, by, deps.requests)
  // i18n-exempt: read by the agent through Okolos Agent, not by the person
  return { success: false, error: { code: 'internal', message: 'This version of Okolos does not answer that verb.', retryable: false } }
}

/**
 * `AgentDoorDeps.post` through the network module: purpose `agent-door`, 127.0.0.1 only, the
 * outbound log first. The token rides in a header and never in the address or the body, so the
 * log row and the redactor see neither.
 */
export function agentDoorPost(audit: () => Promise<RequestDeps>, port: number | (() => Promise<number>) = AGENT_PORT): AgentDoorDeps['post'] {
  return async (path, body, token) => {
    const text = JSON.stringify(body)
    const at = typeof port === 'number' ? port : await port()
    const response = await request(
      {
        url: `http://127.0.0.1:${at}${path}`,
        method: 'POST',
        purpose: 'agent-door',
        // The path names what was asked; nothing of the person's is in any of the four.
        payloadShape: `agent-door:${path.slice('/extension/'.length)}${answeredVerb(path, body)}`,
        triggeredBy: path === '/extension/pair' || path === '/extension/release' ? 'user:settings' : `alarm:${AGENT_DOOR_ALARM}`,
        body: text,
        headers: { 'Content-Type': 'application/json', ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }) },
      },
      await audit(),
    )
    let parsed: unknown = null
    try {
      parsed = await response.json()
    } catch {
      // An answer that is not JSON reads as an empty one; the status still says what happened.
    }
    return { status: response.status, body: parsed }
  }
}

/** `:okolos.queue` for an answer, so the outbound log names what was answered (WB-3); else nothing. */
function answeredVerb(path: string, body: unknown): string {
  const verb = (body as { verb?: unknown } | null)?.verb
  return path === '/extension/answer' && typeof verb === 'string' && /^okolos(\.[a-z]{1,20}){1,2}$/.test(verb) ? `:${verb}` : ''
}
