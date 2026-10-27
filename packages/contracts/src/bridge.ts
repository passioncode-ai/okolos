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

import type { CarrierKind, ConcealmentTechnique } from './snapshot.js'
import type { Confidence, EvidenceKind, Stage, Verdict, VerdictCategory } from './verdict.js'

/**
 * Verbs of the read-only bridge (Б1), the ones a task names. Actions arrive in
 * Б2 with their taxonomy, and so does `screenshot`: pixels bypass the cleaner and
 * show the card numbers and codes a person typed, so it waits for field masking.
 */
export const BRIDGE_VERBS = [
  'open',
  'snapshot',
  'read',
  'get',
  'waitFor',
  'close',
] as const
export type BridgeVerb = (typeof BRIDGE_VERBS)[number]

/**
 * Calls that live outside any task: `session.open` is how a task comes to exist,
 * and the census reads the machine, not a page. A scope cannot name them, so
 * they are a separate list rather than members of `BRIDGE_VERBS`.
 */
export const BRIDGE_SESSION_VERBS = ['session.open', 'hygiene.census'] as const
export type BridgeSessionVerb = (typeof BRIDGE_SESSION_VERBS)[number]

/**
 * The MCP tool name of a verb. Dots become underscores: the Anthropic API takes
 * only `[a-zA-Z0-9_-]` in a tool name, and a client that refuses `session.open`
 * refuses it before the agent ever reaches the bridge. The test holds that no
 * two verbs collapse into one name.
 */
export function toolName(verb: string): string {
  return verb.replaceAll('.', '_')
}

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
  'cleaning_incomplete',
  'stale_cursor',
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
  // The cleaner ran out of budget or lost an element: the agent gets no text at
  // all, and the same page defeats the cleaner the same way on the next call.
  cleaning_incomplete: false,
  // A cursor belongs to one stored snapshot; it never starts naming another.
  stale_cursor: false,
  internal: true,
}

/**
 * The key of the string that tells the person what a refusal means, in
 * `apps/agent/_locales/{ru,en}/messages.json`.
 *
 * A switch and not a template: `refusal_${code}` would compile for a code added
 * tomorrow and leave the page showing a raw key. Here a new code without its
 * branch is a type error at the `never` line, which sends whoever adds it to the
 * locale files before anything ships.
 */
export function refusalKey(code: BridgeRefusal): string {
  switch (code) {
    case 'not_paired':
      return 'refusal_not_paired'
    case 'invalid_scope':
      return 'refusal_invalid_scope'
    case 'no_such_task':
      return 'refusal_no_such_task'
    case 'origin_not_in_task':
      return 'refusal_origin_not_in_task'
    case 'verb_not_in_task':
      return 'refusal_verb_not_in_task'
    case 'budget_exhausted':
      return 'refusal_budget_exhausted'
    case 'task_expired':
      return 'refusal_task_expired'
    case 'tab_gone':
      return 'refusal_tab_gone'
    case 'busy':
      return 'refusal_busy'
    case 'in_use_by_person':
      return 'refusal_in_use_by_person'
    case 'browser_offline':
      return 'refusal_browser_offline'
    case 'blocked_by_shield':
      return 'refusal_blocked_by_shield'
    case 'cleaning_incomplete':
      return 'refusal_cleaning_incomplete'
    case 'stale_cursor':
      return 'refusal_stale_cursor'
    case 'internal':
      return 'refusal_internal'
    default: {
      const unhandled: never = code
      throw new Error(`no string for refusal ${String(unhandled)}`) // i18n-exempt: a programming error that the type check makes unreachable
    }
  }
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

/*
 * What the verbs answer (spec §2.2). Page text enters these types only through
 * `text`, which the daemon fills from cleaned snapshot lines; a finding names
 * how the removed text hid in closed sets and carries none of it; a URL is
 * written without its fragment. The types hold the finding's shape; the other
 * two are the daemon's duty, checked by its tests.
 */

/**
 * `sessionId` is 128 random bits; the task belongs to the agent that opened it.
 * `windowId` is the CDP targetId of the task's window, which is a string.
 */
export interface SessionOpenResult {
  readonly sessionId: string
  readonly windowId: string
}

/** The URL the tab actually landed on after navigation, without its fragment. */
export interface OpenResult {
  readonly url: string
}

/**
 * Evidence as the bridge sends it: closed sets only. `Evidence` itself cannot
 * travel: its `snippet` holds up to 200 characters of the very instruction the
 * cleaner removed, `locator` is a CSS path built from the page's own ids and
 * classes, and `detail` is free-form. Handing any of them to the agent would
 * deliver the injection inside the report that it was removed.
 */
export interface SnapshotEvidence {
  readonly kind: EvidenceKind
  readonly stage: Stage
  readonly concealment: readonly ConcealmentTechnique[]
  readonly carrier: CarrierKind | null
}

/** One thing the engine cut from the snapshot, and how it was hidden. Never what it said. */
export interface SnapshotFinding {
  readonly kind: VerdictCategory
  readonly confidence: Confidence
  readonly evidence: readonly SnapshotEvidence[]
}

/*
 * Records rather than arrays so that a technique or carrier added to its type
 * without a line here is a compile error, not a value silently dropped.
 */
const CONCEALMENT_TECHNIQUES: Readonly<Record<ConcealmentTechnique, true>> = {
  'color-on-color': true,
  'display-none': true,
  'visibility-hidden': true,
  'opacity-zero': true,
  clip: true,
  offscreen: true,
  'font-size-zero': true,
  'aria-hidden': true,
  'non-rendered': true,
}
const CARRIER_KINDS: Readonly<Record<CarrierKind, true>> = {
  'text-node': true,
  'html-comment': true,
  meta: true,
  alt: true,
  title: true,
  'aria-label': true,
  'data-attr': true,
  'json-ld': true,
  template: true,
}

function isConcealment(value: string): value is ConcealmentTechnique {
  return Object.hasOwn(CONCEALMENT_TECHNIQUES, value)
}

function isCarrier(value: unknown): value is CarrierKind {
  return typeof value === 'string' && Object.hasOwn(CARRIER_KINDS, value)
}

/**
 * The finding the agent may see for a verdict. Copies only the closed fields:
 * the detectors write `concealment` and `carrier` into `detail` as strings, so
 * each is kept only when it names a member of its set, and anything else in
 * `detail`, with `snippet` and `locator`, stays in the daemon.
 */
export function toSnapshotFinding(verdict: Verdict): SnapshotFinding {
  return {
    kind: verdict.category,
    confidence: verdict.confidence,
    evidence: verdict.evidence.map((e) => {
      const concealment = e.detail['concealment']
      return {
        kind: e.kind,
        stage: e.stage,
        concealment: typeof concealment === 'string' ? concealment.split(',').filter(isConcealment) : [],
        carrier: isCarrier(e.detail['carrier']) ? e.detail['carrier'] : null,
      }
    }),
  }
}

/**
 * The verdict on a whole snapshot, sent with every page of it. There is no
 * third level for "partly cleaned": a page the cleaner could not finish is a
 * `cleaning_incomplete` refusal with no text at all.
 */
export interface SnapshotVerdict {
  readonly level: 'clean' | 'finding'
  readonly findings: readonly SnapshotFinding[]
}

/**
 * One page of a snapshot. `refs` are opaque, keyed to the task; `cursor` names
 * the next page of this stored snapshot and is absent on the last one.
 */
export interface SnapshotResult {
  readonly text: string
  readonly refs: readonly string[]
  readonly verdict: SnapshotVerdict
  readonly cursor?: string
  readonly partial: boolean
}

/**
 * Page text with the boundary that marks it as quoted page content: the nonce
 * is the daemon's, not the page's, so text on the page cannot forge the end of
 * the quote, and `origin` says whose page it is.
 */
export interface ReadResult {
  readonly text: string
  readonly boundary: { readonly nonce: string; readonly origin: string }
}

/**
 * One process in the hygiene census (K5). It names the executable and only the
 * flags the classifier reads, never the command line: argv of other programs
 * carries their tokens (ревью F11). `keep` marks what must not be touched, an OS
 * service, a live session or the person's browser, and `reason` says why.
 */
export interface CensusEntry {
  readonly pid: number
  readonly ppid: number
  readonly executable: string
  readonly owner: string | null
  readonly ageSeconds: number
  readonly flags: readonly string[]
  readonly keep: boolean
  readonly reason: string
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
  // Required, no default: the default would be `agent`, the profile with the
  // person's logins, and a task should reach them only by saying so (ревью F26).
  const profile = raw.profile
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
    if (isLocalHost(new URL(origin).hostname)) return { ok: false, reason: `not a public origin: ${origin}` } // i18n-exempt: a refusal read by the agent over MCP, not by the person
    if (!list.includes(origin)) list.push(origin)
  }
  return { ok: true, list }
}

/**
 * Whether a hostname is this machine or the local network (ревью F9).
 *
 * The bridge drives the person's browser, which sits inside their network: a
 * task that may read `localhost` or `192.168.1.1` reaches the router, the dev
 * server and the cloud metadata endpoint, none of which a page on the web can
 * reach. The hostname comes from the URL parser, which already turned `127.1`,
 * `2130706433` and `0x7f000001` into `127.0.0.1` and wrote IPv6 in its one
 * compressed form, so each range has a single spelling to recognise.
 *
 * Beyond the ranges the review named, `0.0.0.0/8` and `::` (both answer as this
 * machine on macOS and Linux), `*.localhost` (Chrome resolves it to loopback),
 * IPv4-mapped IPv6 of any refused address and `fc00::/7` (the IPv6 private range)
 * are refused too: each is a second spelling of a refused place.
 */
function isLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true
  if (host.startsWith('[') && host.endsWith(']')) return isLocalIPv6(host.slice(1, -1))
  const v4 = ipv4Octets(host)
  return v4 !== null && isLocalIPv4(v4)
}

function ipv4Octets(host: string): readonly number[] | null {
  const parts = host.split('.')
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p))) return null
  const octets = parts.map(Number)
  return octets.every((o) => o <= 255) ? octets : null
}

function isLocalIPv4(octets: readonly number[]): boolean {
  const [a = -1, b = -1] = octets
  return (
    a === 0 || // 0.0.0.0/8, "this network"
    a === 10 || // 10/8
    a === 127 || // 127/8, loopback
    (a === 169 && b === 254) || // 169.254/16, link-local and the cloud metadata address
    (a === 172 && b >= 16 && b <= 31) || // 172.16/12
    (a === 192 && b === 168) // 192.168/16
  )
}

/** `address` is the parser's compressed, lower-case form, without brackets. */
function isLocalIPv6(address: string): boolean {
  if (address === '::' || address === '::1') return true
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(address)
  if (mapped) {
    const hi = parseInt(mapped[1] ?? '', 16)
    const lo = parseInt(mapped[2] ?? '', 16)
    return isLocalIPv4([hi >> 8, hi & 0xff, lo >> 8, lo & 0xff])
  }
  const first = address.startsWith('::') ? 0 : parseInt(address.split(':')[0] ?? '', 16)
  return (
    (first & 0xffc0) === 0xfe80 || // fe80::/10, link-local
    (first & 0xfe00) === 0xfc00 // fc00::/7, unique local
  )
}

/**
 * Whether a task may call a verb. `close` always may: it only gives back the
 * window and the processes the task holds, and refusing it would leave them
 * running until the TTL to punish an agent that forgot to list it.
 */
export function verbAllowed(scope: TaskScope, verb: BridgeVerb): boolean {
  return verb === 'close' || scope.verbs.includes(verb)
}

/** Whether a URL the task wants to open is inside what it named for reading. */
export function inScope(scope: TaskScope, url: string): boolean {
  const origin = originOf(url)
  return origin !== null && scope.origins.read.includes(origin)
}
