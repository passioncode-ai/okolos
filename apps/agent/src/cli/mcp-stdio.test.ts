import { mkdtempSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import * as z from 'zod'

import { door, type Operation } from '../door/door.js'
import { Journal } from '../journal/journal.js'
import { Pairing } from '../pairing/pairing.js'
import type { ServiceDirs } from '../service/dirs.js'
import type { RouteContext } from '../service/http.js'
import { relay } from './mcp-stdio.js'
import { cliMessages } from './messages.js'
import { pair } from './pair.js'

/** `okolos-agent pair` and `okolos-agent mcp-stdio` against a real door on loopback (N-008). */

const say = cliMessages('en')
const census: Operation = {
  verb: 'hygiene.census',
  purpose: 'Lists automation processes; reads no page.',
  input: z.object({}),
  gate: 'agent',
  example: {},
  run: async () => ({ success: true, data: [] }),
}

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))))
})

async function start() {
  const root = mkdtempSync(path.join(tmpdir(), 'okolos-cli-'))
  const dirs: ServiceDirs = { data: path.join(root, 'data'), logs: path.join(root, 'logs'), cache: path.join(root, 'cache') }
  const pairing = Pairing.open(path.join(root, 'pairing.json'))
  const journal = Journal.open(path.join(root, 'journal'), { retentionDays: 90 })
  const route = door({ pairing, journal, operations: [census], version: '0.0.0-test' })
  const server = createServer((req, res) => void route(req, res, { url: new URL(req.url ?? '/', 'http://127.0.0.1') } as RouteContext))
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { dirs, pairing, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }
}

async function* lines(...items: string[]): AsyncIterable<string> {
  for (const item of items) yield item
}

describe('okolos-agent mcp-stdio', () => {
  it('carries each message to the door with the saved key and writes the answer back', async () => {
    const t = await start()
    await pair({
      name: 'claude-code',
      base: t.base,
      dirs: t.dirs,
      say,
      print: () => undefined,
      sleep: async () => {
        const request = t.pairing.list(Date.now()).requests[0]
        if (request) t.pairing.confirmByHandle(request.handle, Date.now())
      },
    })
    const out: string[] = []
    const code = await relay({
      name: 'claude-code',
      base: t.base,
      dirs: t.dirs,
      say,
      input: lines(
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
        '',
        JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
        JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'execute', arguments: { operation: 'hygiene.census' } } }),
      ),
      output: (line) => out.push(line),
      error: () => undefined,
    })
    expect(code).toBe(0)
    // Two answers: the notification has none.
    expect(out).toHaveLength(2)
    expect(JSON.parse(out[0]!).result.tools.map((tool: { name: string }) => tool.name).sort()).toEqual(['execute', 'search'])
    expect(JSON.parse(JSON.parse(out[1]!).result.content[0].text)).toEqual({ success: true, data: [] })
  })

  it('without a key says how to pair, on stderr, and exits 1', async () => {
    const t = await start()
    const errors: string[] = []
    const code = await relay({ name: 'nobody', base: t.base, dirs: t.dirs, say, input: lines(), output: () => undefined, error: (line) => errors.push(line) })
    expect(code).toBe(1)
    expect(errors[0]).toContain('okolos-agent pair --name')
  })
})
