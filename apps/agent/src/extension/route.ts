import type { IncomingMessage, ServerResponse } from 'node:http'

import type { Route } from '../service/http.js'
import { isExtensionOrigin, WAKE_PERIOD_MS, type ExtensionLink } from './link.js'

/**
 * The extension's route to Okolos Agent (B-218 wave (a), spec §3.3 and §3.3а).
 *
 * Separate from the door: the door refuses every browser, and this route takes exactly one, the
 * Okolos extension the person paired, by its origin and the token it got when it paired. The
 * service's guard lets an extension origin through to these paths only (`extensionOrigin` in
 * `agent.ts`); everything else it refuses as before.
 *
 * The extension's background has no host permission for 127.0.0.1 (WA-7), so it reads an answer
 * only through CORS: a preflight is answered with this origin exactly, never `*`.
 */

export const EXTENSION_PATHS = ['/extension/pair', '/extension/next', '/extension/answer', '/extension/release'] as const

/** The largest body the route reads; an answer to `okolos.ping` is a few hundred bytes. */
export const MAX_EXTENSION_BODY = 64 * 1024

export interface ExtensionRouteDeps {
  readonly link: ExtensionLink
  /** Told of every refusal, for the service's log: the path and why, never a token. */
  readonly refused?: (path: string, reason: string) => void
}

/** Whether the guard may let `origin` through to `pathname`: an extension origin on this route only. */
export function extensionOrigin(pathname: string | undefined, origin: string | undefined): boolean {
  return pathname !== undefined && (EXTENSION_PATHS as readonly string[]).includes(pathname) && isExtensionOrigin(origin)
}

export function extensionRoute(deps: ExtensionRouteDeps): Route & { readonly paths: typeof EXTENSION_PATHS } {
  const { link } = deps

  const route: Route = async (req, res, ctx) => {
    const path = ctx.url.pathname
    if (!(EXTENSION_PATHS as readonly string[]).includes(path)) return false
    const origin = req.headers.origin
    // An extension origin always; once paired, only the paired one, except to pair again.
    const allowed = isExtensionOrigin(origin) && (path === '/extension/pair' || link.isPairedOrigin(origin))
    if (!allowed) return refuse(res, path, 403, 'bad_origin', null)
    const from = origin as string

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        ...cors(from),
        'Access-Control-Allow-Methods': 'POST',
        'Access-Control-Allow-Headers': 'authorization, content-type',
        // Chrome's Private Network Access asks for it on a request to loopback (spec O-4).
        'Access-Control-Allow-Private-Network': 'true',
        'Access-Control-Max-Age': '600',
      })
      res.end()
      return true
    }
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST, OPTIONS')
      return send(res, 405, from, { error: 'method_not_allowed' })
    }
    if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) return refuse(res, path, 415, 'bad_content_type', from)

    const body = await readJson(req)
    if (body === null) return refuse(res, path, 400, 'bad_request', from)

    if (path === '/extension/pair') {
      const paired = link.pair(String(body.code ?? ''), from)
      if ('refused' in paired) return refuse(res, path, 403, paired.refused, from)
      return send(res, 200, from, { token: paired.token, wakeSeconds: WAKE_PERIOD_MS / 1000 })
    }

    const auth = req.headers.authorization ?? ''
    const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : ''
    if (!link.check(from, token)) return refuse(res, path, 401, 'not_connected', from)

    if (path === '/extension/next') return send(res, 200, from, { requests: link.next(), wakeSeconds: WAKE_PERIOD_MS / 1000 })
    if (path === '/extension/answer') return send(res, 200, from, { accepted: link.answer(String(body.id ?? ''), body.result) })
    link.release()
    return send(res, 200, from, { released: true })
  }

  function refuse(res: ServerResponse, path: string, status: number, reason: string, origin: string | null): true {
    deps.refused?.(path, reason)
    return send(res, status, origin, { error: reason })
  }

  return Object.assign(route, { paths: EXTENSION_PATHS })
}

function cors(origin: string): Record<string, string> {
  return { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' }
}

function send(res: ServerResponse, status: number, origin: string | null, body: unknown): true {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...(origin === null ? {} : cors(origin)) })
  res.end(JSON.stringify(body))
  return true
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > MAX_EXTENSION_BODY) return null
    chunks.push(chunk)
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}
