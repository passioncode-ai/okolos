import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import * as z from 'zod'

import { Journal } from '../journal/journal.js'
import { Pairing } from '../pairing/pairing.js'
import type { RouteContext } from '../service/http.js'
import { AGENT_KEY_HEADER, door, searchOperations, type Operation } from './door.js'

/**
 * The door (N-008, REQ-57) over a real loopback server: the pairing steps a CLI takes, the key on
 * `/mcp`, the two tools, the journal before every answer, and the browser turned away.
 */

const census: Operation = {
  verb: 'hygiene.census',
  purpose: 'Lists the automation processes running on this machine; reads no page.',
  input: z.object({}),
  gate: 'agent',
  example: {},
  run: async () => ({ success: true, data: [] }),
}

const open: Operation = {
  verb: 'open',
  purpose: 'Opens an address of the task in the agent window.',
  input: z.object({ task: z.string(), url: z.string() }),
  gate: 'agent',
  example: { task: '0'.repeat(32), url: 'https://example.test/' },
  run: async () => ({ success: false, error: { code: 'origin_not_in_task', message: 'not in the task', retryable: false } }),
}

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))))
})

async function start() {
  const dir = mkdtempSync(path.join(tmpdir(), 'okolos-door-'))
  const pairing = Pairing.open(path.join(dir, 'pairing.json'))
  const journal = Journal.open(path.join(dir, 'journal'), { retentionDays: 90 })
  const route = door({ pairing, journal, operations: [census, open], version: '0.0.0-test' })
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    void route(req, res, { url } as RouteContext).then((handled) => {
      if (!handled) {
        res.writeHead(404)
        res.end()
      }
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const post = (where: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${where}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
  return { pairing, journal, post, dir }
}

/** The pairing a CLI makes: ask, the person confirms on the page, claim. */
async function paired(t: Awaited<ReturnType<typeof start>>, name = 'claude-code'): Promise<string> {
  const asked = (await (await t.post('/pair', { name })).json()) as { requestId: string; code: string }
  const pending = t.pairing.list(Date.now()).requests.find((r) => r.code === asked.code)
  expect(pending, 'the page lists the request under the same code').toBeDefined()
  expect(t.pairing.confirmByHandle(pending!.handle, Date.now())).toBe(true)
  const claimed = await t.post('/pair/claim', { requestId: asked.requestId })
  expect(claimed.status).toBe(200)
  return ((await claimed.json()) as { key: string }).key
}

async function rpc(t: Awaited<ReturnType<typeof start>>, key: string, method: string, params: unknown) {
  const res = await t.post('/mcp', { jsonrpc: '2.0', id: 1, method, params }, { [AGENT_KEY_HEADER]: key })
  return { status: res.status, body: (await res.json()) as { result?: { content: Array<{ text: string }>; isError?: boolean; tools?: Array<{ name: string }> } } }
}

describe('the door, as an agent meets it', () => {
  it('pairs: a code to read out, then the key once the person has confirmed', async () => {
    const t = await start()
    const asked = await t.post('/pair', { name: 'claude-code' })
    expect(asked.status).toBe(200)
    const { requestId } = (await asked.json()) as { requestId: string }
    // Not yet confirmed: the claim waits.
    expect((await t.post('/pair/claim', { requestId })).status).toBe(202)
    expect(await paired(t)).toMatch(/\S{16,}/)
  })

  it('offers exactly two tools, search and execute', async () => {
    const t = await start()
    const key = await paired(t)
    const listed = await rpc(t, key, 'tools/list', {})
    expect(listed.body.result?.tools?.map((tool) => tool.name).sort()).toEqual(['execute', 'search'])
  })

  it('search answers each operation with its purpose, schema, gate and example', async () => {
    const t = await start()
    const key = await paired(t)
    const found = await rpc(t, key, 'tools/call', { name: 'search', arguments: { query: 'census' } })
    const ops = JSON.parse(found.body.result?.content[0]?.text ?? '[]') as Array<{ operation: string; gate: string; inputSchema: object }>
    expect(ops.map((op) => op.operation)).toEqual(['hygiene.census'])
    expect(ops[0]?.gate).toBe('agent')
    expect(ops[0]?.inputSchema).toMatchObject({ type: 'object' })
  })

  it('execute runs an operation and writes the journal before the answer', async () => {
    const t = await start()
    const key = await paired(t)
    const ran = await rpc(t, key, 'tools/call', { name: 'execute', arguments: { operation: 'hygiene.census' } })
    expect(JSON.parse(ran.body.result?.content[0]?.text ?? '{}')).toEqual({ success: true, data: [] })
    expect(t.journal.recent(10).answers.at(-1)).toMatchObject({ outcome: 'answered', verb: 'hygiene.census', agent: 'claude-code' })
  })

  it('execute refuses an unknown operation and wrong arguments as bad_call, journaled', async () => {
    const t = await start()
    const key = await paired(t)
    const unknown = await rpc(t, key, 'tools/call', { name: 'execute', arguments: { operation: 'page.click' } })
    expect(unknown.body.result?.isError).toBe(true)
    const wrong = await rpc(t, key, 'tools/call', { name: 'execute', arguments: { operation: 'open', arguments: { url: 1 } } })
    expect(wrong.body.result?.isError).toBe(true)
    expect(t.journal.recent(10).refusals.slice(-2)).toMatchObject([
      { outcome: 'refused', verb: 'unknown', code: 'bad_call' },
      { outcome: 'refused', verb: 'open', code: 'bad_call' },
    ])
  })

  it('passes an operation refusal through, journaled with its code', async () => {
    const t = await start()
    const key = await paired(t)
    const ran = await rpc(t, key, 'tools/call', {
      name: 'execute',
      arguments: { operation: 'open', arguments: { task: '0'.repeat(32), url: 'https://elsewhere.test/' } },
    })
    expect(ran.body.result?.isError).toBe(true)
    expect(t.journal.recent(10).refusals.at(-1)).toMatchObject({ outcome: 'refused', verb: 'open', code: 'origin_not_in_task' })
  })
})

describe('the door, as it turns callers away', () => {
  it('answers /mcp without a key, or with one nobody holds, 403 not_paired, no OAuth hint, no request made', async () => {
    const t = await start()
    for (const headers of [{}, { [AGENT_KEY_HEADER]: 'not-a-key' }]) {
      const res = await t.post('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, headers)
      expect(res.status).toBe(403)
      expect(res.headers.get('www-authenticate')).toBeNull()
      expect(await res.json()).toEqual({ error: 'not_paired' })
    }
    expect(t.pairing.list(Date.now()).requests).toEqual([])
  })

  it('refuses any Origin and the Fetch Metadata only a browser sends, on every route: no browser is a client in Б1', async () => {
    const t = await start()
    const key = await paired(t)
    for (const where of ['/mcp', '/pair', '/pair/claim']) {
      for (const headers of [
        { origin: 'http://127.0.0.1:47871' },
        { origin: 'https://attacker.test' },
        { 'sec-fetch-site': 'same-origin' },
        { 'sec-fetch-dest': 'empty' },
        { 'sec-fetch-user': '?1' },
      ]) {
        const res = await t.post(where, { name: 'x' }, { [AGENT_KEY_HEADER]: key, ...headers })
        expect(res.status, `${where} ${JSON.stringify(headers)}`).toBe(403)
      }
    }
    const { request, state } = t.journal.recent(50).rejections
    expect([...request, ...state].map((line) => line.code)).toContain('bad_origin')
    expect([...request, ...state].map((line) => line.code)).toContain('cross_site')
  })

  it('refuses a body that is not JSON by content type, and a parse error from a paired agent as bad_call', async () => {
    const t = await start()
    const key = await paired(t)
    const typed = await fetch((await t.post('/pair', { name: 'y' })).url, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' })
    expect(typed.status).toBe(415)
    const broken = await t.post('/mcp', '{not json', { [AGENT_KEY_HEADER]: key })
    expect(broken.status).toBe(400)
    expect(t.journal.recent(10).refusals.at(-1)).toMatchObject({ outcome: 'refused', verb: 'unknown', code: 'bad_call' })
  })
})

describe('a Node client, which is not a browser', () => {
  it('is let in although its fetch sends sec-fetch-mode: the stdio shim and Node MCP clients do', async () => {
    const t = await start()
    const key = await paired(t)
    const res = await t.post('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, { [AGENT_KEY_HEADER]: key, 'sec-fetch-mode': 'cors' })
    expect(res.status).toBe(200)
  })
})

describe('what search reads', () => {
  it('lists everything for an empty query and narrows by every word', () => {
    expect(searchOperations([census, open], undefined).map((op) => op.operation)).toEqual(['hygiene.census', 'open'])
    expect(searchOperations([census, open], 'agent window').map((op) => op.operation)).toEqual(['open'])
    expect(searchOperations([census, open], 'nothing-matches')).toEqual([])
  })
})
