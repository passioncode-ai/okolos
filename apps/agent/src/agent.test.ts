import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { request } from 'node:http'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createAgent, type Agent } from './agent.js'
import { serviceDirs } from './service/dirs.js'

const homes: string[] = []
const agents: Agent[] = []

afterEach(async () => {
  for (const agent of agents.splice(0)) await agent.close()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

function tempHome(): string {
  const home = mkdtempSync(path.join(os.tmpdir(), 'okolos-agent-whole-'))
  homes.push(home)
  return home
}

const OPTIONS = { port: 0, version: '0.0.0-test', buildRoot: path.resolve(import.meta.dirname, '..'), probeSource: '', chromeBinary: null, locale: 'en' as const }

async function start(home: string, extra: Partial<Parameters<typeof createAgent>[0]> = {}): Promise<Agent> {
  const agent = await createAgent({
    ...OPTIONS,
    home,
    exit: (code) => {
      throw new Error(`exit ${code}`)
    },
    ...extra,
  })
  agents.push(agent)
  return agent
}

function post(port: number, pathname: string, body: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path: pathname, method: 'POST', headers: { 'content-type': 'application/json', host: `127.0.0.1:${port}`, ...headers } },
      (res) => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => (text += chunk))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }))
      },
    )
    req.on('error', reject)
    req.end(body)
  })
}

describe('createAgent (N-011)', () => {
  it('serves the door: a call without a key is not_paired, a request for access lands in the events feed by name only', async () => {
    const home = tempHome()
    const agent = await start(home)
    const port = agent.service.port
    expect((await post(port, '/mcp', '{}')).status).toBe(403)
    const asked = await post(port, '/pair', JSON.stringify({ name: 'scout' }))
    expect(asked.status).toBe(200)
    const events = readFileSync(path.join(serviceDirs(home).data, 'events.jsonl'), 'utf8')
    const line = events.split('\n').find((l) => l.includes('pairing_requested'))
    expect(line).toBeDefined()
    expect(line).toContain('scout')
    // Every value of the door's answer (the request id, the code) stays out of the feed.
    for (const value of Object.values(JSON.parse(asked.body) as Record<string, unknown>)) {
      expect(events).not.toContain(String(value))
    }
  })

  it('journals refusals of the door routes only, not of the service routes Fabric polls', async () => {
    const home = tempHome()
    const agent = await start(home)
    const port = agent.service.port
    await post(port, '/mcp', '{}', { origin: 'https://evil.example' })
    await post(port, '/.well-known/fabric-service', '{}', { origin: 'https://evil.example' })
    await agent.close()
    const dir = path.join(serviceDirs(home).data, 'journal')
    const text = readFileSync(path.join(dir, (await import('node:fs')).readdirSync(dir).filter((f) => f.endsWith('.jsonl'))[0] ?? ''), 'utf8')
    const lines = text.trim().split('\n').map((l) => JSON.parse(l) as { outcome: string; code: string })
    expect(lines.filter((l) => l.outcome === 'rejected')).toHaveLength(1)
  })

  it('a second copy on the same home leaves with 75 before opening the journal, the access list or Chrome', async () => {
    const home = tempHome()
    await start(home)
    const codes: number[] = []
    const dirs = serviceDirs(home)
    await expect(
      createAgent({ ...OPTIONS, dirs: { ...dirs, logs: path.join(home, 'second') }, exit: (code) => void codes.push(code) }),
    ).rejects.toThrow()
    expect(codes).toEqual([75])
    expect(() => statSync(path.join(home, 'second'))).toThrow()
  })

  it('closes once, and a second close is the same promise', async () => {
    const agent = await start(tempHome())
    const first = agent.close()
    expect(agent.close()).toBe(first)
    await first
  })
})
