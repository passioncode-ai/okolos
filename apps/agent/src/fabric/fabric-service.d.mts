/**
 * Types for the part of the vendored Fabric service kit (fabric-service.mjs) that apps/agent uses.
 *
 * The kit beside this file is vendored code: `fabric_kit.py install <dir> --lang node --module
 * fabric-service` copies it from the fabric-agent-adapter plugin, and `fabric_kit.py status <dir>`
 * says whether each copy is still current. It is JavaScript with no declarations of its own, so this
 * file is ours, not the kit's: it declares only what the service calls, and a member the service
 * starts to use is added here first. Signatures follow the kit at 0.52.0.
 */

export const DRAIN_SECONDS: number
export const EXIT_ALREADY_RUNNING: number
export const SESSION_COOKIE: string

export class ServiceError extends Error {}

export function nowIso(): string

/** Temporary file, fsync, rename: the file is either the old bytes or the new ones. */
export function atomicWrite(file: string, data: string | Uint8Array, mode?: number): void

/** A sentence for a 403 when the request is not this service's, else null. */
export function checkRequest(
  port: number,
  host: string | undefined,
  origin: string | undefined,
  secFetchSite: string | undefined,
): string | null

/** Constant-time comparison of a presented header against the token. */
export function tokenMatches(presented: string | undefined, token: string, scheme?: string): boolean

export interface InstanceLock {
  readonly path: string
  release(): void
}

/**
 * Takes `<dataDir>/service.lock` or calls `exit(75)` with one sentence on stderr naming the holder.
 * With a test's `exit` that returns, it resolves undefined.
 */
export function holdSingleInstance(
  dataDir: string,
  options?: {
    waitSeconds?: number
    exit?: (code: number) => void
    env?: Record<string, string | undefined>
    argv?: readonly string[]
  },
): Promise<InstanceLock | undefined>

/** Creates the token file (0600, atomic) on first use, then reads it, refusing a symlink or a readable file. */
export function ensureToken(file: string): string

export interface WellKnownSurfaces {
  events: { path: string }
  dashboard?: { path: string; login: boolean }
  mcp?: {
    path: string
    transport: 'streamable-http'
    auth?: 'descriptor' | 'own' | 'delegation'
    capabilities?: readonly string[]
  }
}

/** extensions/actions/0.1 (DEC-0121): its key in `extensions`. */
export const ACTIONS_EXTENSION_KEY: string

export interface DegradedSource {
  source: string
  reason: string
  setup?: boolean
}

export type ServiceStatus = 'starting' | 'ready' | 'degraded' | 'stopping'

export interface WellKnownDocument {
  protocol: string
  service: {
    id: string
    instance: string
    name: string
    version: string
    build: { commit?: string; digest?: string; dirty?: boolean }
  }
  process: { pid: number; startedAt: string }
  status: ServiceStatus
  degraded: DegradedSource[]
  surfaces: WellKnownSurfaces
  update: { available: unknown }
  extensions?: Record<string, unknown>
}

export function buildWellKnown(input: {
  id: string
  instance: string
  name: string
  version: string
  build: { commit?: string; digest?: string; dirty?: boolean }
  startedAt: string
  status: ServiceStatus
  degraded?: readonly DegradedSource[]
  surfaces: WellKnownSurfaces
  pid?: number
  /** The action table (DEC-0121 AP-1), written under extensions/actions/0.1; refused when invalid. */
  actions?: readonly unknown[]
  /** Extensions by key (dashboard, connections, …); a known key the kit finds invalid is refused. */
  extensions?: Readonly<Record<string, unknown>>
}): WellKnownDocument

export class LoginCodes {
  constructor(
    stateDir: string | null,
    ttlSeconds?: number,
    options?: { token?: string | (() => string) },
  )
  issue(): { url: string; expiresAt: string }
  /** Burns the code before honouring it; a session cookie value, or null. */
  redeem(code: string | null | undefined): string | null
  sessionValid(value: unknown): boolean
}

export function sessionCookieHeader(value: string, maxAge?: number): string
export function cookieValue(header: string | undefined, name?: string): string | null

export interface FabricEvent {
  id: string
  at: string
  kind: string
  level: 'info' | 'notice' | 'warning' | 'error'
  text: string
  subject?: { type: string; id: string; label?: string }
  link?: string
  notify?: boolean
}

export function makeEvent(
  id: string,
  at: string,
  kind: string,
  level: FabricEvent['level'],
  text: string,
  options?: { subject?: FabricEvent['subject']; link?: string; notify?: boolean },
): FabricEvent

export function parseLimit(raw: string | null | undefined): number

export function eventsPage<E extends { id: string }>(
  fetch: (after: string | null, limit: number) => E[] | Promise<E[]>,
  after: string | null,
  limit: number,
): Promise<{ events: E[]; cursor: string | null }>

export class RotatingLog {
  constructor(file: string, options?: { maxBytes?: number; backups?: number })
  readonly file: string
  write(level: string, message: string, fields?: Record<string, unknown>): void
}

export function capStdoutLog(file: string, maxBytes?: number): boolean

export class Stopping extends ServiceError {}

export class Drain {
  constructor(options?: { deadline?: number; grace?: number })
  readonly stopping: boolean
  readonly inflight: number
  work<T>(fn: () => Promise<T>): Promise<T>
  requestStop(): boolean
  wait(timeoutSeconds: number): Promise<boolean>
  install(
    onStop: (drained: boolean) => unknown,
    options?: { onStopping?: () => unknown; signals?: readonly string[] },
  ): this
}
