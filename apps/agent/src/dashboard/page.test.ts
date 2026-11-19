import { mkdtempSync, rmSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createAgent, type Agent } from '../agent.js'
import { fill, PAGE_CSP } from './page.js'

const homes: string[] = []
const agents: Agent[] = []

afterEach(async () => {
  for (const agent of agents.splice(0)) await agent.close()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

interface Reply {
  status: number
  headers: http.IncomingHttpHeaders
  body: string
}

function call(port: number, pathname: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: pathname, method: options.method ?? 'GET', headers: { Host: `127.0.0.1:${port}`, ...options.headers }, agent: false },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => (body += chunk))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
      },
    )
    req.on('error', reject)
    req.end(options.body)
  })
}

async function started(): Promise<{ agent: Agent; port: number; cookie: string; write: Record<string, string> }> {
  const home = mkdtempSync(path.join(os.tmpdir(), 'okolos-agent-page-'))
  homes.push(home)
  const agent = await createAgent({
    port: 0,
    version: '0.0.0-test',
    buildRoot: path.resolve(import.meta.dirname, '..', '..'),
    probeSource: '',
    chromeBinary: null,
    locale: 'en',
    home,
    timeZone: 'UTC',
    exit: (code) => {
      throw new Error(`exit ${code}`)
    },
  })
  agents.push(agent)
  const port = agent.service.port
  const signedIn = await call(port, agent.service.codes.issue().url)
  const cookie = String(signedIn.headers['set-cookie']).split(';')[0] ?? ''
  return { agent, port, cookie, write: { cookie, origin: `http://127.0.0.1:${port}`, 'x-okolos-request': '1' } }
}

const json = (body: string) => JSON.parse(body) as Record<string, any>

describe('the page of Okolos Agent (N-015, SCR-23, SCR-24)', () => {
  it('serves the page with its own CSP and the catalogue words, escaped, and no data in it', async () => {
    const { port } = await started()
    const page = await call(port, '/dashboard')
    expect(page.status).toBe(200)
    expect(page.headers['content-security-policy']).toBe(PAGE_CSP)
    expect(page.headers['content-security-policy']).not.toContain('unsafe-inline')
    expect(page.body).toContain('Agents in the browser')
    expect(page.body).toContain('Reading the list of agents and tasks.')
    expect(page.body).not.toMatch(/<script>(?!<\/)/)
    expect(fill('<b>{{x}}</b>', { x: '<i>"a" & \'b\'</i>' })).toBe('<b>&lt;i&gt;&quot;a&quot; &amp; &#39;b&#39;&lt;/i&gt;</b>')
    const wellKnown = json((await call(port, '/.well-known/fabric-service')).body)
    expect(JSON.stringify(wellKnown)).toContain('/dashboard')
  })

  it('refuses the API without the session (401), and a write without its header or with another origin (403)', async () => {
    const { port, cookie, write } = await started()
    expect((await call(port, '/api/state')).status).toBe(401)
    expect((await call(port, '/api/state', { headers: { cookie } })).status).toBe(200)
    const target = '/api/agents/nobody/revoke'
    expect((await call(port, target, { method: 'POST', headers: { cookie, origin: write.origin ?? '' } })).status).toBe(403)
    expect((await call(port, target, { method: 'POST', headers: { cookie, 'x-okolos-request': '1' } })).status).toBe(403)
    expect((await call(port, target, { method: 'POST', headers: { ...write, origin: 'https://evil.example' } })).status).toBe(403)
    expect((await call(port, target, { method: 'POST', headers: write })).status).toBe(409)
  })

  it('shows a request by handle with its code apart, never the request id; confirming gives the key, revoking takes it back', async () => {
    const { port, cookie, write } = await started()
    const empty = json((await call(port, '/api/state', { headers: { cookie } })).body)
    expect(empty.pairing.state).toBe('empty')
    expect(empty.activity.state).toBe('empty')

    const asked = json((await call(port, '/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'scout' }) })).body)
    const state = await call(port, '/api/state', { headers: { cookie } })
    expect(state.body).not.toContain(String(asked.requestId))
    const row = json(state.body).pairing.requests[0]
    expect(row.agent).toBe('Agent scout (a name it gave itself)')
    expect(row.code.replace(' ', '')).toBe(asked.code)
    expect(row.status).toBeNull()

    const confirmed = await call(port, `/api/pairing/${row.handle}/confirm`, { method: 'POST', headers: write })
    expect(json(confirmed.body).notice).toContain('scout')
    const claimed = json((await call(port, '/pair/claim', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId: asked.requestId }) })).body)
    expect(typeof claimed.key).toBe('string')
    // The request is gone once its key was collected: acting on its row says so.
    const gone = await call(port, `/api/pairing/${row.handle}/decline`, { method: 'POST', headers: write })
    expect(gone.status).toBe(409)
    expect(json(gone.body).notice).toContain('This request is gone')
    const paired = json((await call(port, '/api/state', { headers: { cookie } })).body)
    expect(paired.pairing.agents).toHaveLength(1)
    expect(paired.pairing.agents[0].since).toContain('no calls yet')

    const revoked = await call(port, `/api/agents/${paired.pairing.agents[0].agentId}/revoke`, { method: 'POST', headers: write })
    expect(json(revoked.body).notice).toBe('Access for agent scout was revoked and its tasks closed.')
    const door = await call(port, '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', 'x-okolos-agent-key': claimed.key }, body: '{}' })
    expect(door.status).toBe(403)
  })

  it('exports one day of the agents journal as JSON lines', async () => {
    const { port, cookie } = await started()
    await call(port, '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: '{}' })
    const day = new Date().toISOString().slice(0, 10)
    const exported = await call(port, `/api/journal?day=${day}`, { headers: { cookie } })
    expect(exported.status).toBe(200)
    expect(exported.headers['content-disposition']).toContain(`okolos-agent-journal-${day}.jsonl`)
    expect(exported.body.trim().split('\n').map((l) => JSON.parse(l).outcome)).toContain('rejected')
    expect((await call(port, '/api/journal?day=yesterday', { headers: { cookie } })).status).toBe(400)
  })
})
