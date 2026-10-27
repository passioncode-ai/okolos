/**
 * The service shell of Okolos Agent: fabric-service/0.1 on 127.0.0.1.
 *
 * Startup order is the part that goes wrong, so it is fixed here and nowhere else:
 *
 *   1. the single-instance lock on `<data>/service.lock` (held: one sentence naming the holder, exit 75);
 *   2. only then the host token (0600), the log, the login codes and the events;
 *   3. only then the bind, on 127.0.0.1 and nothing else.
 *
 * Every request passes the kit's `checkRequest` before anything else runs, the well-known route
 * included: a Host that is not this service on this port, a foreign Origin or `Sec-Fetch-Site:
 * cross-site` is a 403 (a page that rebinds a name to 127.0.0.1 is the attack this stops). Then the
 * protocol's four routes, then the routes later nodes add (`/mcp`, `/pair`, `/dashboard`).
 *
 * SIGTERM drains: new work is refused with 503, work in flight finishes, the lock is released, exit 0.
 * The log records method, path and status. Never a query string (a login code travels in one), a
 * header, a cookie or a body.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import process from 'node:process'

import {
  checkRequest,
  cookieValue,
  Drain,
  DRAIN_SECONDS,
  ensureToken,
  eventsPage,
  holdSingleInstance,
  LoginCodes,
  nowIso,
  parseLimit,
  RotatingLog,
  ServiceError,
  sessionCookieHeader,
  Stopping,
  tokenMatches,
  type DegradedSource,
  type ServiceStatus,
} from '../fabric/fabric-service.mjs'
import { servicePaths, type ServiceDirs, type ServicePaths } from './dirs.js'
import { EventLog } from './events.js'
import { buildIdentity, wellKnown } from './wellknown.js'

/** What a route is handed besides the request: the parsed URL and the service's own checks. */
export interface RouteContext {
  readonly url: URL
  readonly port: number
  readonly dirs: ServiceDirs
  readonly log: RotatingLog
  readonly events: EventLog
  /** The request carries the host token (the descriptor's, for Fabric's host). */
  hostAuthorized(req: IncomingMessage): boolean
  /** The request carries a live operator session cookie. */
  operatorSession(req: IncomingMessage): boolean
}

/**
 * A route answers the request and resolves true, or leaves it alone and resolves false. `paths`
 * names what it serves: the well-known document declares `/mcp` and `/dashboard` only when a
 * route claims them, so a host never opens a page nothing answers.
 */
export type Route = ((req: IncomingMessage, res: ServerResponse, ctx: RouteContext) => Promise<boolean>) & {
  readonly paths?: readonly string[]
}

/** The language of the sentences a person reads: events in Fabric Dashboards, the refusal while stopping. */
export type Locale = 'ru' | 'en'

/** What `setup` is handed: the service's state, opened after the lock and before the bind. */
export interface SetupContext {
  readonly dirs: ServiceDirs
  readonly paths: ServicePaths
  readonly events: EventLog
  readonly codes: LoginCodes
  readonly log: RotatingLog
  readonly locale: Locale
}

export interface RunningService {
  /** The port actually bound (the one asked for, or the free one the system gave for 0). */
  readonly port: number
  address(): AddressInfo
  /** The events feed; its `trim(now)` is the daily trim. */
  readonly events: EventLog
  /** Sign-in codes of this running instance. */
  readonly codes: LoginCodes
  /** Whether a request carries a live operator session of this instance. */
  operatorSession(req: { readonly headers: { readonly cookie?: string | undefined } }): boolean
  /** Drain, stop listening, release the lock. Safe to call more than once. */
  close(): Promise<void>
}

export interface StartOptions {
  readonly port: number
  readonly dirs: ServiceDirs
  /** The package version the well-known document names (the entry point reads it, not this module). */
  readonly version: string
  /** The code's root: the commit when it is this checkout, a digest of its files otherwise. */
  readonly buildRoot: string
  /** Routes known before the start; built-in routes run first, then these, then setup's. */
  readonly routes?: readonly Route[]
  /**
   * Builds routes that need state of their own (a journal, the access list, the agent window),
   * called after the lock, the token and the events exist and before the bind. A second copy never
   * reaches it; a throw fails the start and lets the lock go.
   */
  readonly setup?: (ctx: SetupContext) => Promise<readonly Route[]>
  /** Defaults to 'ru', the language Fabric's interface speaks to the operator. */
  readonly locale?: Locale
  /** The owner's degraded sources, merged into the well-known document on every request. */
  readonly degraded?: () => readonly DegradedSource[]
  /** The owner's action table and extensions for the well-known document. */
  readonly wellKnownExtras?: () => {
    readonly actions?: readonly unknown[]
    readonly extensions?: Readonly<Record<string, unknown>>
  }
  /** How a copy that finds the lock held leaves; the process's exit unless a test passes its own. */
  readonly exit?: (code: number) => void
  /** Install the SIGTERM/SIGINT drain (the daemon does; in-process tests do not). */
  readonly handleSignals?: boolean
  /**
   * Told of every request the shell refuses before a route sees it (a foreign Host or Origin, a
   * cross-site fetch, a target that is not a URL), and awaited before the 403 or 400 is written,
   * so the daemon can journal the refusal first. A hook that throws makes the answer a 500 with no body.
   */
  readonly onRefused?: (req: IncomingMessage, url: URL | null, reason: RefusalReason) => Promise<void>
}

const HOST = '127.0.0.1'

/** Headers on every answer, refusals included (fabric-service/0.1, surfaces and auth). */
const COMMON_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'self'",
} as const

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

export async function startService(options: StartOptions): Promise<RunningService> {
  const { dirs } = options
  const exit = options.exit ?? ((code: number) => process.exit(code))

  // 1. The lock, before any side effect.
  const lock = await holdSingleInstance(dirs.data, { exit })
  // i18n-exempt: reached only when a test's exit returns; the daemon has already exited 75 with the kit's sentence
  if (!lock) throw new ServiceError('Another copy of Okolos Agent holds the lock; this one did not start.')

  // 2. State, only after the lock. Whatever fails from here to the bind lets the lock go.
  const paths = servicePaths(dirs)
  const locale: Locale = options.locale ?? 'ru'
  let token: string
  let log: RotatingLog
  let codes: LoginCodes
  let events: EventLog
  let added: readonly Route[]
  try {
    token = ensureToken(paths.hostToken)
    log = new RotatingLog(paths.serviceLog)
    codes = new LoginCodes(paths.sessions, 120, { token })
    events = new EventLog(paths.events)
    added = (await options.setup?.({ dirs, paths, events, codes, log, locale })) ?? []
  } catch (error) {
    lock.release()
    throw error
  }
  const build = buildIdentity(options.buildRoot)
  const startedAt = nowIso()
  const drain = new Drain()
  let status: ServiceStatus = 'starting'
  let port = options.port

  const hostAuthorized = (req: IncomingMessage) => tokenMatches(req.headers.authorization, token)
  const sessionOf = (req: { readonly headers: { readonly cookie?: string | undefined } }) => operatorSession(codes, req)

  const builtIn: Route = async (req, res, ctx) => {
    const { pathname } = ctx.url
    if (pathname === '/fabric/v1/events') {
      if (req.method !== 'GET') return methodNotAllowed(res, 'GET')
      if (!hostAuthorized(req)) return unauthorized(res)
      let limit: number
      try {
        limit = parseLimit(ctx.url.searchParams.get('limit'))
      } catch {
        // i18n-exempt: a protocol answer to Fabric's host (fabric-service/0.1 events page), read by its code, not a person
        json(res, 400, { error: 'bad_request', message: 'limit must be an integer.' })
        return true
      }
      json(res, 200, await eventsPage((after, n) => events.read(after, n), ctx.url.searchParams.get('after'), limit))
      return true
    }
    if (pathname === '/fabric/v1/login-code') {
      if (req.method !== 'POST') return methodNotAllowed(res, 'POST')
      if (!hostAuthorized(req)) return unauthorized(res)
      json(res, 200, codes.issue())
      return true
    }
    if (pathname === '/fabric/v1/login') {
      if (req.method !== 'GET') return methodNotAllowed(res, 'GET')
      // Burned before it is honoured, and burned even when expired (the kit's LoginCodes).
      const session = codes.redeem(ctx.url.searchParams.get('code'))
      if (session === null) return unauthorized(res)
      res.writeHead(302, { Location: '/dashboard', 'Set-Cookie': sessionCookieHeader(session) })
      res.end()
      return true
    }
    return false
  }

  const routes: readonly Route[] = [builtIn, ...(options.routes ?? []), ...added]
  const served = routes.flatMap((route) => route.paths ?? [])

  const document = () => {
    const extras = options.wellKnownExtras?.() ?? {}
    return wellKnown({
      version: options.version,
      build,
      startedAt,
      pid: process.pid,
      status,
      degraded: [...(options.degraded?.() ?? [])],
      served,
      ...(extras.actions === undefined ? {} : { actions: extras.actions }),
      ...(extras.extensions === undefined ? {} : { extensions: extras.extensions }),
    })
  }

  /** Tells the caller's hook first; a hook that throws turns the answer into a 500 with no body. */
  const refuse = async (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL | null,
    reason: RefusalReason,
    answer: () => void,
  ): Promise<void> => {
    try {
      await options.onRefused?.(req, url, reason)
    } catch (error) {
      log.write('error', 'onRefused failed', { reason, error: errorName(error) })
      res.writeHead(500)
      res.end()
      return
    }
    answer()
  }

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // Defaults a route may replace: a header it sets or writes wins over these.
    for (const [name, value] of Object.entries(COMMON_HEADERS)) res.setHeader(name, value)
    const url = parseTarget(req.url, port)
    res.on('finish', () =>
      log.write('info', 'request', { method: req.method, path: url?.pathname ?? null, status: res.statusCode }),
    )
    // The guard answers first, whatever the target looks like.
    const refusal = guard(port, req)
    if (refusal !== null) {
      await refuse(req, res, url, refusal.reason, () =>
        json(res, 403, { error: 'forbidden', message: refusal.sentence }),
      )
      return
    }
    if (url === null) {
      await refuse(req, res, null, 'bad_request', () =>
        // i18n-exempt: a protocol answer to a client that sent a request target no URL parser reads
        json(res, 400, { error: 'bad_request', message: 'The request target is not a URL.' }),
      )
      return
    }
    // The well-known document is read from memory and answers while the service drains,
    // so a host sees "stopping" rather than a refusal.
    if (url.pathname === '/.well-known/fabric-service') {
      if (req.method !== 'GET') {
        methodNotAllowed(res, 'GET')
        return
      }
      json(res, 200, document())
      return
    }
    const ctx: RouteContext = { url, port, dirs, log, events, hostAuthorized, operatorSession: sessionOf }
    try {
      await drain.work(async () => {
        for (const route of routes) if (await route(req, res, ctx)) return
        json(res, 404, { error: 'not_found' })
      })
    } catch (error) {
      if (error instanceof Stopping) {
        json(res, 503, { error: 'stopping', message: 'Okolos Agent is stopping and takes no new work.' })
        return
      }
      log.write('error', 'route failed', { path: url.pathname, error: errorName(error) })
      // Headers already out: cut the connection, so the client cannot take half an answer for a whole one.
      if (!res.headersSent) json(res, 500, { error: 'internal' })
      else res.destroy()
    }
  }

  // No throw inside handle, the log's included, may become an unhandled rejection: that ends the daemon.
  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      try {
        log.write('error', 'request failed', { error: errorName(error) })
      } catch {
        // The log itself failed; the answer below still goes out.
      }
      if (!res.headersSent) {
        res.writeHead(500)
        res.end()
      } else {
        res.destroy()
      }
    })
  })

  // 3. The bind: loopback only.
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(options.port, HOST, () => {
        server.off('error', reject)
        resolve()
      })
    })
  } catch (error) {
    lock.release()
    throw error
  }
  port = (server.address() as AddressInfo).port
  status = 'ready'
  events.append('service.started', 'info', 'Okolos Agent started.')
  log.write('info', 'started', { port, pid: process.pid })

  const markStopping = () => {
    status = 'stopping'
    events.append('service.stopping', 'info', 'Okolos Agent is stopping.')
    log.write('info', 'stopping')
  }

  let finished: Promise<void> | null = null
  const finish = (drained: boolean): Promise<void> => {
    finished ??= new Promise<void>((resolve) => {
      server.close(() => {
        lock.release()
        log.write('info', 'stopped', { drained })
        resolve()
      })
      server.closeAllConnections()
    })
    return finished
  }

  if (options.handleSignals) {
    drain.install(
      async (drained) => {
        await finish(drained)
        exit(0)
      },
      { onStopping: markStopping },
    )
  }

  return {
    port,
    address: () => server.address() as AddressInfo,
    events,
    codes,
    operatorSession: sessionOf,
    close: async () => {
      if (drain.requestStop()) markStopping()
      await finish(await drain.wait(DRAIN_SECONDS))
    },
  }
}

/**
 * Whether a request carries a live operator session: the `fabric_session` cookie that
 * `GET /fabric/v1/login` set, still inside the kit's bounds (12 h idle, 7 days in all, not logged
 * out, signed under the current host token). The dashboard (N-015) asks this before every page and
 * every write; a use inside the bounds refreshes the idle bound.
 */
export function operatorSession(codes: LoginCodes, req: { readonly headers: { readonly cookie?: string | undefined } }): boolean {
  return codes.sessionValid(cookieValue(req.headers.cookie))
}

/** Why the shell refused a request before any route saw it. */
export type RefusalReason = 'bad_host' | 'bad_origin' | 'cross_site' | 'bad_request'

/**
 * The kit's checkRequest, asked one header at a time so the refusal carries its reason. The
 * sentence is the kit's own; the decision is the kit's alone.
 */
function guard(port: number, req: IncomingMessage): { reason: RefusalReason; sentence: string } | null {
  const own = `${HOST}:${port}`
  const host = checkRequest(port, req.headers.host, undefined, undefined)
  if (host !== null) return { reason: 'bad_host', sentence: host }
  const origin = checkRequest(port, own, req.headers.origin, undefined)
  if (origin !== null) return { reason: 'bad_origin', sentence: origin }
  const site = checkRequest(port, own, undefined, firstHeader(req.headers['sec-fetch-site']))
  if (site !== null) return { reason: 'cross_site', sentence: site }
  return null
}

/** The request target as a URL on this origin, or null when it does not parse. */
function parseTarget(target: string | undefined, port: number): URL | null {
  try {
    return new URL(target ?? '/', `http://${HOST}:${port}`)
  } catch {
    return null
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function unauthorized(res: ServerResponse): true {
  json(res, 401, { error: 'unauthorized' })
  return true
}

function methodNotAllowed(res: ServerResponse, allow: string): true {
  res.setHeader('Allow', allow)
  json(res, 405, { error: 'method_not_allowed' })
  return true
}
