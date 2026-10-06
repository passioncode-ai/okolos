/**
 * The contract between an agent and Okolos Bridge (spec 2026-10-06, Б1 §2).
 *
 * An agent never gets "the browser". It opens a task that names what it may
 * reach, and every call after that is checked against the task. The types here
 * are the whole vocabulary of that conversation: the verbs, the task, the answer
 * envelope and the closed set of refusals. A refusal is a policy answer, not a
 * failure — an agent that reads it as an error retries it, so every code says
 * which kind of "no" it is and whether trying again could change it.
 */

/** Verbs of the read-only bridge (Б1). Actions arrive in Б2 with their taxonomy. */
export const BRIDGE_VERBS = [
  'open',
  'snapshot',
  'read',
  'get',
  'waitFor',
  'screenshot',
  'close',
] as const
export type BridgeVerb = (typeof BRIDGE_VERBS)[number]

/** Every way the bridge says no. Closed: an unlisted refusal is a bug. */
export const BRIDGE_REFUSALS = [
  'not_paired',
  'invalid_scope',
  'no_such_task',
  'origin_not_in_task',
  'verb_not_in_task',
  'budget_exhausted',
  'task_expired',
  'tab_gone',
  'busy',
  'in_use_by_person',
  'browser_offline',
  'blocked_by_shield',
  'internal',
] as const
export type BridgeRefusal = (typeof BRIDGE_REFUSALS)[number]

/**
 * Whether asking again can change the answer. Policy refusals are final for the
 * task; only a browser that is not there yet, or a slot another holder will
 * release, may answer differently later.
 */
export const REFUSAL_RETRYABLE: Readonly<Record<BridgeRefusal, boolean>> = {
  not_paired: false,
  invalid_scope: false,
  no_such_task: false,
  origin_not_in_task: false,
  verb_not_in_task: false,
  budget_exhausted: false,
  task_expired: false,
  tab_gone: false,
  busy: true,
  in_use_by_person: true,
  browser_offline: true,
  blocked_by_shield: false,
  internal: true,
}

export interface BridgeError {
  readonly code: BridgeRefusal
  readonly message: string
  readonly retryable: boolean
}

export type BridgeResult<T> =
  | { readonly success: true; readonly data: T }
  | { readonly success: false; readonly error: BridgeError }

export function refuse(code: BridgeRefusal, message: string): { success: false; error: BridgeError } {
  return { success: false, error: { code, message, retryable: REFUSAL_RETRYABLE[code] } }
}

/** `agent` carries the person's logins; `disposable` is a fresh profile with none. */
export type TaskProfile = 'agent' | 'disposable'

export interface TaskScope {
  /** The person's goal in the agent's words; read by the drift guard (Б3). */
  readonly goal: string
  /** Exact origins — scheme, host and port, no path. `write` must be a subset of `read`. */
  readonly origins: { readonly read: readonly string[]; readonly write: readonly string[] }
  readonly verbs: readonly BridgeVerb[]
  readonly ttlSeconds: number
  readonly stepBudget: number
  readonly profile: TaskProfile
}

export const SCOPE_LIMITS = {
  maxTtlSeconds: 3600,
  maxStepBudget: 500,
  maxOrigins: 32,
  maxGoalChars: 2000,
} as const

/**
 * The origin of a URL string, or `null` when it has none a task could name.
 *
 * Only http(s) is reachable: a task naming `file:`, `chrome:` or `javascript:`
 * names something the bridge never opens.
 */
export function originOf(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
  return parsed.origin
}

/**
 * Checks a scope an agent sent and returns it normalised, or the first reason it
 * cannot be accepted. Pure: the caller owns the clock and the task table.
 */
export function validateScope(input: unknown): { ok: true; scope: TaskScope } | { ok: false; reason: string } {
  if (typeof input !== 'object' || input === null) return { ok: false, reason: 'scope must be an object' } // i18n-exempt: a refusal read by the agent over MCP, not by the person
  const raw = input as Record<string, unknown>

  const goal = raw.goal
  if (typeof goal !== 'string' || goal.trim() === '') return { ok: false, reason: 'goal is required' } // i18n-exempt: a refusal read by the agent over MCP, not by the person
  if (goal.length > SCOPE_LIMITS.maxGoalChars) return { ok: false, reason: `goal is longer than ${SCOPE_LIMITS.maxGoalChars} characters` } // i18n-exempt: a refusal read by the agent over MCP, not by the person

  const origins = raw.origins as Record<string, unknown> | undefined
  if (typeof origins !== 'object' || origins === null) return { ok: false, reason: 'origins is required' } // i18n-exempt: a refusal read by the agent over MCP, not by the person
  const read = normaliseOrigins(origins.read)
  const write = normaliseOrigins(origins.write ?? [])
  if (!read.ok) return { ok: false, reason: `origins.read: ${read.reason}` }
  if (!write.ok) return { ok: false, reason: `origins.write: ${write.reason}` }
  if (read.list.length === 0) return { ok: false, reason: 'origins.read must name at least one origin' }
  if (read.list.length + write.list.length > SCOPE_LIMITS.maxOrigins) {
    return { ok: false, reason: `a task may name at most ${SCOPE_LIMITS.maxOrigins} origins` } // i18n-exempt: a refusal read by the agent over MCP, not by the person
  }
  const outside = write.list.filter((o) => !read.list.includes(o))
  if (outside.length > 0) return { ok: false, reason: `origins.write must be a subset of origins.read: ${outside.join(', ')}` }

  const verbs = raw.verbs
  if (!Array.isArray(verbs) || verbs.length === 0) return { ok: false, reason: 'verbs must name at least one verb' } // i18n-exempt: a refusal read by the agent over MCP, not by the person
  const unknown = verbs.filter((v) => !(BRIDGE_VERBS as readonly unknown[]).includes(v))
  if (unknown.length > 0) return { ok: false, reason: `unknown verbs: ${unknown.map(String).join(', ')}` }

  const ttl = raw.ttlSeconds
  if (typeof ttl !== 'number' || !Number.isInteger(ttl) || ttl < 1 || ttl > SCOPE_LIMITS.maxTtlSeconds) {
    return { ok: false, reason: `ttlSeconds must be an integer from 1 to ${SCOPE_LIMITS.maxTtlSeconds}` } // i18n-exempt: a refusal read by the agent over MCP, not by the person
  }
  const budget = raw.stepBudget
  if (typeof budget !== 'number' || !Number.isInteger(budget) || budget < 1 || budget > SCOPE_LIMITS.maxStepBudget) {
    return { ok: false, reason: `stepBudget must be an integer from 1 to ${SCOPE_LIMITS.maxStepBudget}` } // i18n-exempt: a refusal read by the agent over MCP, not by the person
  }
  const profile = raw.profile ?? 'agent'
  if (profile !== 'agent' && profile !== 'disposable') return { ok: false, reason: "profile must be 'agent' or 'disposable'" } // i18n-exempt: a refusal read by the agent over MCP, not by the person

  return {
    ok: true,
    scope: {
      goal: goal.trim(),
      origins: { read: read.list, write: write.list },
      verbs: [...new Set(verbs as BridgeVerb[])],
      ttlSeconds: ttl,
      stepBudget: budget,
      profile,
    },
  }
}

function normaliseOrigins(value: unknown): { ok: true; list: string[] } | { ok: false; reason: string } {
  if (!Array.isArray(value)) return { ok: false, reason: 'must be a list of origins' } // i18n-exempt: a refusal read by the agent over MCP, not by the person
  const list: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') return { ok: false, reason: 'every origin must be a string' } // i18n-exempt: a refusal read by the agent over MCP, not by the person
    const origin = originOf(item)
    if (origin === null) return { ok: false, reason: `not an http(s) origin: ${item}` } // i18n-exempt: a refusal read by the agent over MCP, not by the person
    if (!list.includes(origin)) list.push(origin)
  }
  return { ok: true, list }
}

/** Whether a URL the task wants to open is inside what it named for reading. */
export function inScope(scope: TaskScope, url: string): boolean {
  const origin = originOf(url)
  return origin !== null && scope.origins.read.includes(origin)
}
