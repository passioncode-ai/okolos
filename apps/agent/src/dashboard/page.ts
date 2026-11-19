/**
 * The page of Okolos Agent and its API (SCR-23, SCR-24; N-015, REQ-64, REQ-65).
 *
 *   GET  /dashboard, /dashboard/app.js, /dashboard/app.css    the page, no data in it
 *   GET  /api/state                                           what the page shows (`pageView`)
 *   POST /api/pairing/<handle>/confirm | /decline             the person's decision on a request
 *   POST /api/agents/<agentId>/revoke                         ends an agent's access and its tasks
 *   GET  /api/journal?day=YYYY-MM-DD                          the agents' journal, one day as JSON lines
 *
 * Every /api route needs the operator session the shell gave Fabric Dashboards
 * (401 otherwise, the page then says its session expired). A write also needs
 * this page's own `Origin` and `X-Okolos-Request: 1` (403 otherwise), so no
 * other page can post here even with the cookie (review F4). The page sets its
 * own Content-Security-Policy: scripts and styles from itself only, no inline.
 */
import { readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Resolver } from '@okolos/i18n'

import { JournalError, type Journal } from '../journal/journal.js'
import { PairingStoreError, type AgentRecord, type Pairing } from '../pairing/pairing.js'
import type { Route } from '../service/http.js'
import type { Tasks } from '../tasks/tasks.js'
import { pageView, REFUSALS_SHOWN } from './view.js'

/** The page's folder: apps/agent/static, beside src/ (or dist/) as the catalogue is. */
export function defaultStaticDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'static')
}

export const PAGE_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'"

export interface DashboardDeps {
  readonly pairing: Pairing
  readonly tasks: Tasks
  readonly journal: Journal
  readonly say: Resolver
  readonly locale: string
  readonly now: () => number
  /** Closes the tasks and windows of an agent whose access the person revoked. */
  readonly onRevoke: (agent: AgentRecord) => Promise<void>
  /** The reason of the journal's last failed write in words, or null while writes succeed. */
  readonly journalWriteFailure: () => string | null
  readonly staticDir?: string
  readonly timeZone?: string
}

const ASSETS: Readonly<Record<string, string>> = {
  '/dashboard': 'index.html',
  '/dashboard/app.js': 'app.js',
  '/dashboard/app.css': 'app.css',
}

const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
}

function json(res: ServerResponse, status: number, body: unknown): true {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Security-Policy': PAGE_CSP })
  res.end(JSON.stringify(body))
  return true
}

export function dashboard(deps: DashboardDeps): Route {
  const dir = deps.staticDir ?? defaultStaticDir()
  const files = Object.fromEntries(Object.entries(ASSETS).map(([route, file]) => [route, readFileSync(path.join(dir, file))]))
  const format = (at: number): string =>
    Number.isFinite(at)
      ? new Intl.DateTimeFormat(deps.locale, {
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          ...(deps.timeZone === undefined ? {} : { timeZone: deps.timeZone }),
        }).format(at)
      : '?'

  function state(origin: string): unknown {
    const now = deps.now()
    let pairing: Parameters<typeof pageView>[0]['pairing']
    try {
      pairing = deps.pairing.list(now)
    } catch (error) {
      pairing = { unreadable: error instanceof PairingStoreError ? error.reason : 'other' }
    }
    let journal: Parameters<typeof pageView>[0]['journal']
    try {
      journal = { recent: deps.journal.recent(REFUSALS_SHOWN) }
    } catch (error) {
      journal = { failure: error instanceof JournalError ? error.code : 'other' }
    }
    return pageView({
      say: deps.say,
      now,
      doorUrl: origin,
      pairing,
      tasks: deps.tasks.list(now),
      journal,
      journalWriteFailure: deps.journalWriteFailure(),
      format,
    })
  }

  const route: Route = async (req: IncomingMessage, res: ServerResponse, ctx) => {
    const pathname = ctx.url.pathname
    const asset = files[pathname]
    if (asset !== undefined && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(ASSETS[pathname] ?? '')] ?? 'text/plain', 'Content-Security-Policy': PAGE_CSP })
      // The page's first words (title, the loading line) are filled here, escaped, from the catalogue.
      res.end(pathname === '/dashboard' ? fill(asset.toString('utf8'), { lang: deps.locale, title: deps.say('agentPageTitle'), loading: deps.say('agentPageLoading') }) : asset)
      return true
    }
    if (pathname !== '/api' && !pathname.startsWith('/api/')) return false
    if (!ctx.operatorSession(req)) return json(res, 401, { error: 'session' })
    const origin = `http://127.0.0.1:${ctx.port}`

    if (req.method === 'GET' && pathname === '/api/state') return json(res, 200, state(origin))
    if (req.method === 'GET' && pathname === '/api/journal') {
      const day = ctx.url.searchParams.get('day') ?? new Date(deps.now()).toISOString().slice(0, 10)
      try {
        const text = deps.journal.export(day)
        res.writeHead(200, {
          'Content-Type': 'application/x-ndjson; charset=utf-8',
          'Content-Disposition': `attachment; filename="okolos-agent-journal-${day}.jsonl"`,
          'Content-Security-Policy': PAGE_CSP,
        })
        res.end(text)
        return true
      } catch (error) {
        return json(res, error instanceof TypeError ? 400 : 500, {
          notice: deps.say('journalExportFailed', [error instanceof JournalError ? error.code : 'other']),
        })
      }
    }

    if (req.method !== 'POST') return json(res, 405, { error: 'method' })
    if (req.headers['x-okolos-request'] !== '1' || req.headers.origin !== origin) return json(res, 403, { error: 'forbidden' })
    const now = deps.now()

    const decision = /^\/api\/pairing\/([A-Za-z0-9_-]{1,64})\/(confirm|decline)$/.exec(pathname)
    if (decision !== null) {
      const handle = decision[1] ?? ''
      const row = safeList(deps.pairing, now)?.requests.find((r) => r.handle === handle)
      try {
        const done = decision[2] === 'confirm' ? deps.pairing.confirmByHandle(handle, now) : deps.pairing.declineByHandle(handle, now)
        if (!done || row === undefined) return json(res, 409, { notice: deps.say('pairingGone') })
        return json(res, 200, { notice: deps.say(decision[2] === 'confirm' ? 'pairingConfirmed' : 'pairingDeclined', [row.name]) })
      } catch (error) {
        if (error instanceof PairingStoreError) return json(res, 500, { notice: deps.say('pairingStoreUnwritable', [error.reason]) })
        throw error
      }
    }

    const revoke = /^\/api\/agents\/([A-Za-z0-9_-]{1,64})\/revoke$/.exec(pathname)
    if (revoke !== null) {
      const agentId = revoke[1] ?? ''
      const before = safeList(deps.pairing, now)?.agents.find((a) => a.agentId === agentId)
      try {
        const gone = deps.pairing.revoke(agentId, now)
        if (gone === null) return json(res, 409, { notice: deps.say('agentGone') })
        await deps.onRevoke(gone)
        return json(res, 200, { notice: deps.say('agentRevoked', [gone.name]) })
      } catch (error) {
        if (error instanceof PairingStoreError) return json(res, 500, { notice: deps.say('agentRevokeFailed', [before?.name ?? '?']) })
        throw error
      }
    }
    return json(res, 404, { error: 'not_found' })
  }
  return Object.assign(route, { paths: ['/dashboard', '/api'] as const })
}

const ESCAPES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

/** The template with `{{name}}` replaced by escaped text. */
export function fill(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_whole, name: string) => (values[name] ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c))
}

function safeList(pairing: Pairing, now: number) {
  try {
    return pairing.list(now)
  } catch {
    return undefined
  }
}
