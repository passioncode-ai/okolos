import { mkdtempSync, rmSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { serviceDirs } from '../service/dirs.js'
import { startService, type RunningService } from '../service/http.js'
import { ExtensionLink, extensionStoreFile } from './link.js'
import { extensionOrigin, extensionRoute } from './route.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const IDENTITY = { version: '0.0.0', buildRoot: path.resolve(here, '..', '..') } as const
const CHROME = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'
const OTHER = 'chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba'

const homes: string[] = []
const services: RunningService[] = []
afterEach(async () => {
  for (const service of services.splice(0)) await service.close()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

async function start() {
  const home = mkdtempSync(path.join(os.tmpdir(), 'okolos-agent-test-'))
  homes.push(home)
  const dirs = serviceDirs(home)
  const refusals: string[] = []
  let link: ExtensionLink | undefined
  const service = await startService({
    ...IDENTITY,
    port: 0,
    dirs,
    exit: () => undefined,
    originAllowed: extensionOrigin,
    setup: async () => {
      link = new ExtensionLink({ file: extensionStoreFile(dirs) })
      return [extensionRoute({ link, refused: (route, reason) => refusals.push(`${route} ${reason}`) })]
    },
  })
  services.push(service)
  if (link === undefined) throw new Error('the service started without its setup')
  return { port: service.port, link, refusals }
}

interface Reply {
  status: number
  headers: http.IncomingHttpHeaders
  body: Record<string, unknown>
}

function call(port: number, pathname: string, { method = 'POST', headers = {}, body }: { method?: string; headers?: Record<string, string>; body?: unknown } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        path: pathname,
        method,
        headers: { Host: `127.0.0.1:${port}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
        agent: false,
      },
      (response) => {
        let text = ''
        response.setEncoding('utf8')
        response.on('data', (chunk: string) => (text += chunk))
        response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) }))
      },
    )
    request.on('error', reject)
    request.end(body === undefined ? undefined : JSON.stringify(body))
  })
}

/** What the extension's background sends: its origin and the Fetch Metadata Chrome adds. */
const fromExtension = (origin = CHROME) => ({ Origin: origin, 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Dest': 'empty' })

async function pairedService() {
  const started = await start()
  const { code } = started.link.issueCode()
  const reply = await call(started.port, '/extension/pair', { headers: fromExtension(), body: { code } })
  return { ...started, token: String(reply.body.token) }
}

describe('the guard lets an extension origin through to /extension/* only (B-218, WA-3)', () => {
  it('is an exception for an extension origin on these paths and nothing else', () => {
    expect(extensionOrigin('/extension/next', CHROME)).toBe(true)
    expect(extensionOrigin('/mcp', CHROME)).toBe(false)
    expect(extensionOrigin('/extension/next', 'https://evil.example')).toBe(false)
    expect(extensionOrigin(undefined, CHROME)).toBe(false)
  })

  it('still refuses a web page on the route, and an extension on any other path', async () => {
    const { port } = await start()
    expect((await call(port, '/extension/pair', { headers: fromExtension('https://evil.example'), body: { code: '123456' } })).status).toBe(403)
    expect((await call(port, '/.well-known/fabric-service', { method: 'GET', headers: { Origin: CHROME } })).status).toBe(403)
  })

  it('never lets a foreign Host through, whatever the origin', async () => {
    const { port } = await start()
    const reply = await call(port, '/extension/pair', { headers: { ...fromExtension(), Host: 'evil.example' }, body: { code: '123456' } })
    expect(reply.status).toBe(403)
  })
})

describe('pairing and the wake loop over HTTP', () => {
  it('answers a preflight with the extension origin exactly, never *', async () => {
    const { port } = await start()
    const reply = await call(port, '/extension/pair', { method: 'OPTIONS', headers: { ...fromExtension(), 'Access-Control-Request-Method': 'POST' } })
    expect(reply.status).toBe(204)
    expect(reply.headers['access-control-allow-origin']).toBe(CHROME)
    expect(reply.headers['access-control-allow-headers']).toBe('authorization, content-type')
    expect(reply.headers['access-control-allow-private-network']).toBe('true')
  })

  it('pairs with the code, then hands an agent call to the extension and takes its answer', async () => {
    const { port, link, token } = await pairedService()
    expect(token).toMatch(/^[A-Za-z0-9_-]{40,}$/)
    const asked = link.ask('okolos.ping', {})
    const next = await call(port, '/extension/next', { headers: { ...fromExtension(), Authorization: `Bearer ${token}` }, body: {} })
    expect(next.status).toBe(200)
    expect(next.headers['access-control-allow-origin']).toBe(CHROME)
    const [request] = next.body.requests as { id: string; verb: string }[]
    expect(request?.verb).toBe('okolos.ping')
    const answered = await call(port, '/extension/answer', {
      headers: { ...fromExtension(), Authorization: `Bearer ${token}` },
      body: { id: request?.id, result: { success: true, data: { extensionVersion: '1.2.3', connectedSince: '2026-11-19T10:00:00.000Z' } } },
    })
    expect(answered.body).toEqual({ accepted: true })
    expect(await asked).toEqual({ success: true, data: { extensionVersion: '1.2.3', connectedSince: '2026-11-19T10:00:00.000Z' } })
  })

  it('refuses a wrong code, a missing or wrong token, and another extension once one is paired', async () => {
    const { port, token, refusals } = await pairedService()
    expect((await call(port, '/extension/next', { headers: fromExtension(), body: {} })).status).toBe(401)
    expect((await call(port, '/extension/next', { headers: { ...fromExtension(), Authorization: `Bearer ${token}x` }, body: {} })).status).toBe(401)
    expect((await call(port, '/extension/next', { headers: { ...fromExtension(OTHER), Authorization: `Bearer ${token}` }, body: {} })).status).toBe(403)
    expect((await call(port, '/extension/pair', { headers: fromExtension(OTHER), body: { code: '000000' } })).body).toEqual({ error: 'bad_code' })
    expect(refusals).toContain('/extension/next not_connected')
    expect(refusals.join('\n')).not.toContain(token)
  })

  it('ends the link on release, and the next look is refused (WA-4)', async () => {
    const { port, token } = await pairedService()
    const auth = { ...fromExtension(), Authorization: `Bearer ${token}` }
    expect((await call(port, '/extension/release', { headers: auth, body: {} })).body).toEqual({ released: true })
    // The paired origin is gone with the link, so the same extension is now refused at the origin.
    expect((await call(port, '/extension/next', { headers: auth, body: {} })).status).toBe(403)
  })

  it('takes only POST with a JSON body', async () => {
    const { port } = await start()
    expect((await call(port, '/extension/pair', { method: 'GET', headers: fromExtension() })).status).toBe(405)
    expect((await call(port, '/extension/pair', { headers: { ...fromExtension(), 'Content-Type': 'text/plain' } })).status).toBe(415)
  })
})
