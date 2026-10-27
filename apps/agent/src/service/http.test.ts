import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

import { LoginCodes } from '../fabric/fabric-service.mjs'
import { serviceDirs, type ServiceDirs } from './dirs.js'
import {
  operatorSession,
  startService,
  type RefusalReason,
  type Route,
  type RunningService,
  type StartOptions,
} from './http.js'

const here = path.dirname(fileURLToPath(import.meta.url))

// ---------------------------------------------------------------------------
// Real servers on free ports, real lock files in temporary homes, real processes.
// Nothing here touches ~/Library or port 47871.
// ---------------------------------------------------------------------------

const homes: string[] = []
const services: RunningService[] = []
const children: ChildProcess[] = []

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
  for (const service of services.splice(0)) await service.close()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

function tempHome(): string {
  const home = mkdtempSync(path.join(os.tmpdir(), 'okolos-agent-test-'))
  homes.push(home)
  return home
}

async function start(
  options: Partial<StartOptions> = {},
): Promise<{ service: RunningService; dirs: ServiceDirs }> {
  const dirs = options.dirs ?? serviceDirs(tempHome())
  // A held lock must fail the test, never exit the test runner.
  const exit = (code: number) => {
    throw new Error(`the service asked to exit ${code}`)
  }
  const service = await startService({ port: 0, routes: [], exit, ...options, dirs })
  services.push(service)
  return { service, dirs }
}

/** Bytes on a raw socket, for request lines no HTTP client would send. Resolves with what came back. */
function raw(port: number, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let back = ''
    const socket = net.connect(port, '127.0.0.1', () => socket.write(text))
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => (back += chunk))
    socket.on('close', () => resolve(back))
    socket.on('error', reject)
  })
}

interface Reply {
  status: number
  headers: http.IncomingHttpHeaders
  body: string
}

/** One request with exactly the headers given; Host is ours to set, unlike fetch's. */
function call(
  port: number,
  pathname: string,
  { method = 'GET', headers = {} }: { method?: string; headers?: Record<string, string> } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: '127.0.0.1', port, path: pathname, method, headers: { Host: `127.0.0.1:${port}`, ...headers }, agent: false },
      (response) => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk: string) => (body += chunk))
        response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body }))
      },
    )
    request.on('error', reject)
    request.end()
  })
}

const token = (dirs: ServiceDirs) => readFileSync(path.join(dirs.data, 'host.token'), 'utf8').trim()
const bearer = (dirs: ServiceDirs) => ({ Authorization: `Bearer ${token(dirs)}` })

/** Every route the service answers today, with the method it answers on. */
const ROUTES: ReadonlyArray<{ method: string; path: string }> = [
  { method: 'GET', path: '/.well-known/fabric-service' },
  { method: 'GET', path: '/fabric/v1/events' },
  { method: 'POST', path: '/fabric/v1/login-code' },
  { method: 'GET', path: '/fabric/v1/login?code=AAAAAAAAAAAAAAAAAAAAAAAA' },
  { method: 'GET', path: '/later' },
  { method: 'GET', path: '/nothing-here' },
]

/** A route a later node adds: it answers 200 and says it ran. */
const later: Route = async (req, res, ctx) => {
  if (ctx.url.pathname !== '/later') return false
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ ran: true, method: req.method }))
  return true
}

/** A copy of the service in its own process, through the test fixture. */
function child(home: string): ChildProcess {
  const proc = spawn(
    process.execPath,
    ['--import', path.join(here, 'fixtures', 'ts-hooks.mjs'), path.join(here, 'fixtures', 'run-service.mjs'), home],
    { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, FABRIC_SERVICE_SUPERVISOR: '' } },
  )
  children.push(proc)
  return proc
}

function exited(proc: ChildProcess): Promise<{ code: number | null; stderr: string }> {
  let stderr = ''
  proc.stderr?.setEncoding('utf8')
  proc.stderr?.on('data', (chunk: string) => (stderr += chunk))
  return new Promise((resolve) => proc.on('exit', (code) => resolve({ code, stderr })))
}

function listening(proc: ChildProcess): Promise<{ port: number; pid: number }> {
  return new Promise((resolve, reject) => {
    let out = ''
    proc.stdout?.setEncoding('utf8')
    proc.stdout?.on('data', (chunk: string) => {
      out += chunk
      const line = out.split('\n')[0]
      if (out.includes('\n') && line) resolve(JSON.parse(line) as { port: number; pid: number })
    })
    proc.on('exit', (code) => reject(new Error(`the copy exited with ${code} before it listened`)))
  })
}

// ---------------------------------------------------------------------------

describe('one copy, locked before any side effect', () => {
  it('a second copy on the same data exits 75 naming the holder, and the first keeps answering', async () => {
    const home = tempHome()
    const { service } = await start({ dirs: serviceDirs(home) })

    const second = await exited(child(home))
    expect(second.code).toBe(75)
    expect(second.stderr).toContain(`process ${process.pid}`)

    const answer = await call(service.port, '/.well-known/fabric-service')
    expect(answer.status).toBe(200)
    expect(JSON.parse(answer.body).process.pid).toBe(process.pid)
  })

  it('a second copy in this process is refused too, before it creates anything', async () => {
    const home = tempHome()
    const dirs = serviceDirs(home)
    await start({ dirs })
    const codes: number[] = []
    await expect(
      startService({
        port: 0,
        dirs: { ...dirs, logs: path.join(home, 'second-logs') },
        exit: (code) => {
          codes.push(code)
        },
      }),
    ).rejects.toThrow(/another copy/i)
    expect(codes).toEqual([75])
    // The refused copy wrote no log: the lock comes before every side effect.
    expect(() => statSync(path.join(home, 'second-logs'))).toThrow()
  })

  it('keeps the host token in a 0600 file it made itself', async () => {
    const { dirs } = await start()
    const info = statSync(path.join(dirs.data, 'host.token'))
    expect(info.mode & 0o777).toBe(0o600)
    expect(token(dirs).length).toBeGreaterThanOrEqual(32)
  })

  it('listens on 127.0.0.1 only', async () => {
    const { service } = await start()
    expect(service.address()).toMatchObject({ address: '127.0.0.1', family: 'IPv4' })
  })
})

describe('the guard runs on every path, the well-known one included', () => {
  it('answers this service’s own Host (control: the refusals below are not the only answer)', async () => {
    const { service } = await start({ routes: [later] })
    for (const host of [`127.0.0.1:${service.port}`, `localhost:${service.port}`, `[::1]:${service.port}`]) {
      const answer = await call(service.port, '/.well-known/fabric-service', { headers: { Host: host } })
      expect(answer.status, host).toBe(200)
    }
    expect((await call(service.port, '/later')).status).toBe(200)
  })

  it('refuses Host evil.example with 403 on every route', async () => {
    const { service, dirs } = await start({ routes: [later] })
    for (const route of ROUTES) {
      const answer = await call(service.port, route.path, {
        method: route.method,
        headers: { Host: 'evil.example', ...bearer(dirs) },
      })
      expect(answer.status, `${route.method} ${route.path}`).toBe(403)
    }
  })

  it('refuses this host on another port (a rebinding page reaches us through its own port)', async () => {
    const { service } = await start()
    const answer = await call(service.port, '/.well-known/fabric-service', {
      headers: { Host: `127.0.0.1:${service.port + 1}` },
    })
    expect(answer.status).toBe(403)
  })

  it('refuses Origin https://evil.example with 403 on every route', async () => {
    const { service, dirs } = await start({ routes: [later] })
    for (const route of ROUTES) {
      const answer = await call(service.port, route.path, {
        method: route.method,
        headers: { Origin: 'https://evil.example', ...bearer(dirs) },
      })
      expect(answer.status, `${route.method} ${route.path}`).toBe(403)
    }
  })

  it('refuses Sec-Fetch-Site: cross-site with 403 on every route', async () => {
    const { service, dirs } = await start({ routes: [later] })
    for (const route of ROUTES) {
      const answer = await call(service.port, route.path, {
        method: route.method,
        headers: { 'Sec-Fetch-Site': 'cross-site', ...bearer(dirs) },
      })
      expect(answer.status, `${route.method} ${route.path}`).toBe(403)
    }
  })

  it('lets its own origin through', async () => {
    const { service } = await start()
    const answer = await call(service.port, '/.well-known/fabric-service', {
      headers: { Origin: `http://127.0.0.1:${service.port}`, 'Sec-Fetch-Site': 'same-origin' },
    })
    expect(answer.status).toBe(200)
  })

  it('a refused request never reaches a route', async () => {
    let ran = 0
    const counting: Route = async (_req, res, ctx) => {
      if (ctx.url.pathname !== '/counted') return false
      ran += 1
      res.end()
      return true
    }
    const { service } = await start({ routes: [counting] })
    await call(service.port, '/counted', { headers: { Host: 'evil.example' } })
    expect(ran).toBe(0)
    await call(service.port, '/counted')
    expect(ran).toBe(1)
  })
})

describe('every request ends in an answer', () => {
  it('a target that is not a URL is a 400, and the service keeps answering', async () => {
    const { service } = await start()
    const back = await raw(
      service.port,
      `GET http://[bad/x HTTP/1.1\r\nHost: 127.0.0.1:${service.port}\r\nConnection: close\r\n\r\n`,
    )
    expect(back.split('\r\n')[0]).toBe('HTTP/1.1 400 Bad Request')
    expect((await call(service.port, '/.well-known/fabric-service')).status).toBe(200)
  })

  it('the guard still answers first: the same target from a foreign Host is a 403', async () => {
    const { service } = await start()
    const back = await raw(service.port, 'GET http://[bad/x HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n')
    expect(back.split('\r\n')[0]).toBe('HTTP/1.1 403 Forbidden')
    expect((await call(service.port, '/.well-known/fabric-service')).status).toBe(200)
  })
})

describe('a refusal is told to the caller before it is answered (onRefused)', () => {
  const cases: ReadonlyArray<{ headers: Record<string, string>; reason: RefusalReason }> = [
    { headers: { Host: 'evil.example' }, reason: 'bad_host' },
    { headers: { Origin: 'https://evil.example' }, reason: 'bad_origin' },
    { headers: { 'Sec-Fetch-Site': 'cross-site' }, reason: 'cross_site' },
  ]

  for (const { headers, reason } of cases) {
    it(`${reason}: called with the request, its URL and the reason, before a byte is written`, async () => {
      const seen: Array<{ path: string | undefined; reason: RefusalReason; method: string | undefined }> = []
      let release: () => void = () => {}
      const gate = new Promise<void>((resolve) => (release = resolve))
      let called: () => void = () => {}
      const inside = new Promise<void>((resolve) => (called = resolve))
      const { service } = await start({
        onRefused: async (req, url, why) => {
          seen.push({ path: url?.pathname, reason: why, method: req.method })
          called()
          await gate
        },
      })

      let answered = false
      const reply = call(service.port, '/mcp', { method: 'POST', headers }).then((r) => {
        answered = true
        return r
      })
      await inside
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(answered).toBe(false)
      release()
      expect((await reply).status).toBe(403)
      expect(seen).toEqual([{ path: '/mcp', reason, method: 'POST' }])
    })
  }

  it('bad_request: a target that is not a URL reaches onRefused with no URL, then 400', async () => {
    const seen: Array<{ url: URL | null; reason: RefusalReason }> = []
    const { service } = await start({
      onRefused: async (_req, url, reason) => {
        seen.push({ url, reason })
      },
    })
    const back = await raw(
      service.port,
      `GET http://[bad/x HTTP/1.1\r\nHost: 127.0.0.1:${service.port}\r\nConnection: close\r\n\r\n`,
    )
    expect(back.split('\r\n')[0]).toBe('HTTP/1.1 400 Bad Request')
    expect(seen).toEqual([{ url: null, reason: 'bad_request' }])
  })

  it('an onRefused that throws makes the answer a 500 with no body', async () => {
    const { service } = await start({
      onRefused: async () => {
        throw new Error('the journal is not writable')
      },
    })
    const answer = await call(service.port, '/mcp', { headers: { Host: 'evil.example' } })
    expect(answer.status).toBe(500)
    expect(answer.body).toBe('')
    expect((await call(service.port, '/.well-known/fabric-service')).status).toBe(200)
  })

  it('is not called for a request the guard lets through', async () => {
    let calls = 0
    const { service } = await start({
      onRefused: async () => {
        calls += 1
      },
    })
    await call(service.port, '/.well-known/fabric-service')
    await call(service.port, '/fabric/v1/events')
    expect(calls).toBe(0)
  })
})

describe('wrong methods, a taken port, a route that fails halfway, a route’s own headers', () => {
  const protocol: ReadonlyArray<{ path: string; allow: string; wrong: string }> = [
    { path: '/.well-known/fabric-service', allow: 'GET', wrong: 'POST' },
    { path: '/fabric/v1/events', allow: 'GET', wrong: 'POST' },
    { path: '/fabric/v1/login-code', allow: 'POST', wrong: 'GET' },
    { path: '/fabric/v1/login?code=AAAAAAAAAAAAAAAAAAAAAAAA', allow: 'GET', wrong: 'POST' },
  ]

  for (const { path: target, allow, wrong } of protocol) {
    it(`${wrong} ${target.split('?')[0]} is a 405 that names ${allow}`, async () => {
      const { service, dirs } = await start()
      const answer = await call(service.port, target, { method: wrong, headers: bearer(dirs) })
      expect(answer.status).toBe(405)
      expect(answer.headers.allow).toBe(allow)
    })
  }

  it('a port another server holds fails the start and lets the lock go', async () => {
    const holder = net.createServer()
    await new Promise<void>((resolve) => holder.listen(0, '127.0.0.1', resolve))
    const taken = (holder.address() as net.AddressInfo).port
    try {
      const dirs = serviceDirs(tempHome())
      await expect(startService({ port: taken, dirs, routes: [] })).rejects.toThrow(/EADDRINUSE/)
      const next = await start({ dirs })
      expect((await call(next.service.port, '/.well-known/fabric-service')).status).toBe(200)
    } finally {
      await new Promise<void>((resolve) => holder.close(() => resolve()))
    }
  })

  it('a route that fails after its headers went out cuts the answer short instead of passing it as whole', async () => {
    const halfway: Route = async (_req, res, ctx) => {
      if (ctx.url.pathname !== '/halfway') return false
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.write('first half')
      throw new Error('the second half failed')
    }
    const { service } = await start({ routes: [halfway] })
    const complete = await new Promise<boolean>((resolve) => {
      const request = http.request(
        { host: '127.0.0.1', port: service.port, path: '/halfway', headers: { Host: `127.0.0.1:${service.port}` }, agent: false },
        (response) => {
          response.resume()
          response.on('close', () => resolve(response.complete))
        },
      )
      request.on('error', () => resolve(false))
      request.end()
    })
    expect(complete).toBe(false)
    expect((await call(service.port, '/.well-known/fabric-service')).status).toBe(200)
  })

  it('the shell’s CSP applies unless the route sets its own', async () => {
    const page: Route = async (_req, res, ctx) => {
      if (ctx.url.pathname === '/own') {
        res.writeHead(200, { 'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'" })
        res.end('page')
        return true
      }
      if (ctx.url.pathname === '/plain') {
        res.end('plain')
        return true
      }
      return false
    }
    const { service } = await start({ routes: [page] })
    expect((await call(service.port, '/own')).headers['content-security-policy']).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self'",
    )
    expect((await call(service.port, '/plain')).headers['content-security-policy']).toBe(
      "default-src 'none'; frame-ancestors 'self'",
    )
  })
})

describe('GET /.well-known/fabric-service', () => {
  it('answers without a token, from memory, with who is answering', async () => {
    const { service } = await start()
    const answer = await call(service.port, '/.well-known/fabric-service')
    expect(answer.status).toBe(200)
    expect(answer.headers['content-type']).toMatch(/^application\/json/)
    expect(answer.headers['cache-control']).toBe('no-store')
    expect(answer.headers['x-content-type-options']).toBe('nosniff')
    const doc = JSON.parse(answer.body)
    expect(doc.service.id).toBe('okolos-agent')
    expect(doc.service.instance).toBe('default')
    expect(doc.service.build.commit).toMatch(/^[0-9a-f]{40}$/)
    expect(doc.process.pid).toBe(process.pid)
    expect(Date.parse(doc.process.startedAt)).not.toBeNaN()
    expect(doc.status).toBe('ready')
    expect(doc).toHaveProperty('degraded')
    expect(doc.degraded).toEqual([])
    expect(doc.surfaces.mcp.auth).toBe('own')
    expect(doc.surfaces.dashboard).toEqual({ path: '/dashboard', login: true })
  })
})

describe('the host’s routes take the host token', () => {
  it('events: 401 without the token or with a wrong one, the page with it', async () => {
    const { service, dirs } = await start()
    expect((await call(service.port, '/fabric/v1/events')).status).toBe(401)
    const wrong = await call(service.port, '/fabric/v1/events', {
      headers: { Authorization: `Bearer ${'x'.repeat(43)}` },
    })
    expect(wrong.status).toBe(401)

    const page = await call(service.port, '/fabric/v1/events', { headers: bearer(dirs) })
    expect(page.status).toBe(200)
    const body = JSON.parse(page.body)
    expect(body.events.map((e: { kind: string }) => e.kind)).toContain('service.started')
    expect(body.cursor).toBe(body.events.at(-1).id)

    const after = await call(service.port, `/fabric/v1/events?after=${body.cursor}`, { headers: bearer(dirs) })
    expect(JSON.parse(after.body)).toEqual({ events: [], cursor: body.cursor })
  })

  it('events: a limit that is not a number is a 400, not a crash', async () => {
    const { service, dirs } = await start()
    const answer = await call(service.port, '/fabric/v1/events?limit=many', { headers: bearer(dirs) })
    expect(answer.status).toBe(400)
  })

  it('login-code: 401 without the token', async () => {
    const { service } = await start()
    expect((await call(service.port, '/fabric/v1/login-code', { method: 'POST' })).status).toBe(401)
  })

  it('a login code works once: the cookie is HttpOnly and SameSite=Strict, then 302 to /dashboard', async () => {
    const { service, dirs } = await start()
    const issued = await call(service.port, '/fabric/v1/login-code', { method: 'POST', headers: bearer(dirs) })
    expect(issued.status).toBe(200)
    const { url, expiresAt } = JSON.parse(issued.body) as { url: string; expiresAt: string }
    expect(url).toMatch(/^\/fabric\/v1\/login\?code=[A-Za-z0-9_-]{16,256}$/)
    expect(Date.parse(expiresAt) - Date.now()).toBeLessThanOrEqual(120_000)

    const first = await call(service.port, url)
    expect(first.status).toBe(302)
    expect(first.headers.location).toBe('/dashboard')
    const cookie = String(first.headers['set-cookie'])
    expect(cookie).toMatch(/^fabric_session=/)
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Strict')

    const again = await call(service.port, url)
    expect(again.status).toBe(401)
    expect(again.headers['set-cookie']).toBeUndefined()
  })

  it('the session cookie is HttpOnly, SameSite=Strict, Path=/ and lives at most 7 days', async () => {
    const { service, dirs } = await start()
    const issued = await call(service.port, '/fabric/v1/login-code', { method: 'POST', headers: bearer(dirs) })
    const { url } = JSON.parse(issued.body) as { url: string }
    const signedIn = await call(service.port, url)
    const cookies = signedIn.headers['set-cookie'] ?? []
    expect(cookies).toHaveLength(1)
    const attributes = (cookies[0] ?? '').split(';').map((part) => part.trim())
    expect(attributes).toContain('HttpOnly')
    expect(attributes).toContain('SameSite=Strict')
    expect(attributes).toContain('Path=/')
    // A cookie without Max-Age would last the browser session; the kit always bounds it.
    const maxAge = attributes.find((part) => part.startsWith('Max-Age=')) ?? 'Max-Age=missing'
    const seconds = Number(maxAge.slice('Max-Age='.length))
    expect(seconds).toBeGreaterThan(0)
    expect(seconds).toBeLessThanOrEqual(7 * 24 * 60 * 60)
    expect(attributes.some((part) => part.startsWith('Expires='))).toBe(false)
  })

  it('operatorSession knows the cookie the login gave, and nothing else', async () => {
    const { service, dirs } = await start()
    const codes = new LoginCodes(path.join(dirs.data, 'auth'), 120, { token: token(dirs) })
    const issued = await call(service.port, '/fabric/v1/login-code', { method: 'POST', headers: bearer(dirs) })
    const { url } = JSON.parse(issued.body) as { url: string }
    const signedIn = await call(service.port, url)
    const pair = String(signedIn.headers['set-cookie']).split(';')[0] ?? ''

    expect(operatorSession(codes, { headers: { cookie: `theme=dark; ${pair}` } })).toBe(true)
    expect(operatorSession(codes, { headers: {} })).toBe(false)
    // Tampered: the last hex digit of the MAC changed (to a digit it certainly is not).
    const tampered = `${pair.slice(0, -1)}${pair.endsWith('0') ? '1' : '0'}`
    expect(operatorSession(codes, { headers: { cookie: tampered } })).toBe(false)
    expect(operatorSession(codes, { headers: { cookie: 'fabric_session=v2.x.1.y.z' } })).toBe(false)
  })

  it('a made-up code signs nobody in', async () => {
    const { service } = await start()
    const answer = await call(service.port, '/fabric/v1/login?code=AAAAAAAAAAAAAAAAAAAAAAAA')
    expect(answer.status).toBe(401)
    expect(answer.headers['set-cookie']).toBeUndefined()
  })

  it('never writes the token, a login code or a cookie into its log', async () => {
    const { service, dirs } = await start()
    const issued = await call(service.port, '/fabric/v1/login-code', { method: 'POST', headers: bearer(dirs) })
    const { url } = JSON.parse(issued.body) as { url: string }
    const signedIn = await call(service.port, url)
    await call(service.port, '/fabric/v1/events', { headers: bearer(dirs) })

    const log = readFileSync(path.join(dirs.logs, 'service.jsonl'), 'utf8')
    expect(log).toContain('/fabric/v1/login') // the log does record the request
    const code = url.split('code=')[1] ?? ''
    const session = String(signedIn.headers['set-cookie']).split(';')[0]?.split('=')[1] ?? ''
    expect(code.length).toBeGreaterThan(15)
    expect(session.length).toBeGreaterThan(15)
    for (const secret of [token(dirs), code, session]) expect(log).not.toContain(secret)
    const events = readFileSync(path.join(dirs.data, 'events.jsonl'), 'utf8')
    for (const secret of [token(dirs), code, session]) expect(events).not.toContain(secret)
  })
})

describe('routes a later node adds', () => {
  it('run after the guard, with the request’s URL, and a route that declines falls through to 404', async () => {
    const declines: Route = async () => false
    const { service } = await start({ routes: [declines, later] })
    const answer = await call(service.port, '/later', { method: 'POST' })
    expect(answer.status).toBe(200)
    expect(JSON.parse(answer.body)).toEqual({ ran: true, method: 'POST' })
    expect((await call(service.port, '/nothing-here')).status).toBe(404)
  })

  it('a route that throws is a 500 and the service keeps answering', async () => {
    const broken: Route = async (_req, _res, ctx) => {
      if (ctx.url.pathname !== '/broken') return false
      throw new Error('a later node is wrong')
    }
    const { service } = await start({ routes: [broken] })
    expect((await call(service.port, '/broken')).status).toBe(500)
    expect((await call(service.port, '/.well-known/fabric-service')).status).toBe(200)
  })
})

describe('stopping drains', () => {
  it('finishes the work in flight, refuses new work with 503, says stopping, then lets the lock go', async () => {
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => (release = resolve))
    let entered: () => void = () => {}
    const inside = new Promise<void>((resolve) => (entered = resolve))
    const slow: Route = async (_req, res, ctx) => {
      if (ctx.url.pathname !== '/slow') return false
      entered()
      await held
      res.end('done')
      return true
    }
    const home = tempHome()
    const dirs = serviceDirs(home)
    const { service } = await start({ dirs, routes: [slow, later] })

    const inFlight = call(service.port, '/slow')
    await inside
    const closing = service.close()

    expect((await call(service.port, '/later')).status).toBe(503)
    const during = JSON.parse((await call(service.port, '/.well-known/fabric-service')).body)
    expect(during.status).toBe('stopping')

    release()
    const finished = await inFlight
    expect(finished.status).toBe(200)
    expect(finished.body).toBe('done')
    await closing

    const events = readFileSync(path.join(dirs.data, 'events.jsonl'), 'utf8')
    expect(events).toContain('"service.stopping"')
    // The lock is free: the next copy starts on the same data.
    const next = await start({ dirs })
    expect((await call(next.service.port, '/.well-known/fabric-service')).status).toBe(200)
  })

  it('SIGTERM to a real process drains and exits 0', async () => {
    const home = tempHome()
    const proc = child(home)
    const done = exited(proc)
    const { port, pid } = await listening(proc)
    const answer = await call(port, '/.well-known/fabric-service')
    expect(JSON.parse(answer.body).process.pid).toBe(pid)

    proc.kill('SIGTERM')
    expect((await done).code).toBe(0)
    const events = readFileSync(path.join(serviceDirs(home).data, 'events.jsonl'), 'utf8')
    expect(events).toContain('"service.stopping"')
  })
})
