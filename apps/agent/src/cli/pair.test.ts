import { mkdtempSync, statSync } from 'node:fs'
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
import { clientKeyFile, readKey } from './clients.js'
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

describe('okolos-agent pair', () => {
  it('prints the code, waits for the person, and keeps the key 0600 under the name', async () => {
    const t = await start()
    const printed: string[] = []
    let polls = 0
    const code = await pair({
      name: 'claude-code',
      base: t.base,
      dirs: t.dirs,
      say,
      print: (line) => printed.push(line),
      // The person confirms on the page after the second look.
      sleep: async () => {
        polls += 1
        if (polls === 2) {
          const request = t.pairing.list(Date.now()).requests[0]
          t.pairing.confirmByHandle(request!.handle, Date.now())
        }
      },
    })
    expect(code).toBe(0)
    const shown = t.pairing.list(Date.now())
    expect(printed[0]).toContain('claude-code')
    expect(printed.at(-1)).toContain(clientKeyFile(t.dirs, 'claude-code'))
    expect(shown.agents.map((a) => a.name)).toEqual(['claude-code'])
    const file = clientKeyFile(t.dirs, 'claude-code')
    expect(readKey(file)).toMatch(/\S{16,}/)
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('stops with exit 1 and says why when the person declines', async () => {
    const t = await start()
    const printed: string[] = []
    const code = await pair({
      name: 'claude-code',
      base: t.base,
      dirs: t.dirs,
      say,
      print: (line) => printed.push(line),
      sleep: async () => {
        const request = t.pairing.list(Date.now()).requests[0]
        if (request) t.pairing.declineByHandle(request.handle, Date.now())
      },
    })
    expect(code).toBe(1)
    expect(printed.at(-1)).toContain('declined')
  })

  /** Confirms the newest pending request on the second look, as the person does on the page. */
  function confirmOnSecondLook(t: Awaited<ReturnType<typeof start>>) {
    let polls = 0
    return async () => {
      polls += 1
      if (polls === 2) {
        const request = t.pairing.list(Date.now()).requests.find((r) => r.state === 'pending')
        t.pairing.confirmByHandle(request!.handle, Date.now())
      }
    }
  }

  it('refuses to ask again under a name it already holds a key for, unless --replace (SCN-044 alt path)', async () => {
    const t = await start()
    expect(await pair({ name: 'scout', base: t.base, dirs: t.dirs, say, print: () => {}, sleep: confirmOnSecondLook(t) })).toBe(0)
    const first = readKey(clientKeyFile(t.dirs, 'scout'))
    const printed: string[] = []
    expect(await pair({ name: 'scout', base: t.base, dirs: t.dirs, say, print: (line) => printed.push(line) })).toBe(1)
    expect(printed).toEqual([say.exists('scout')])
    expect(t.pairing.list(Date.now()).requests).toHaveLength(0)

    expect(await pair({ name: 'scout', base: t.base, dirs: t.dirs, say, replace: true, print: () => {}, sleep: confirmOnSecondLook(t) })).toBe(0)
    const second = readKey(clientKeyFile(t.dirs, 'scout'))
    expect(second).not.toBe(first)
    // The earlier access ended once the new key was saved: one agent with access, holding the new key.
    expect(t.pairing.list(Date.now()).agents).toHaveLength(1)
    expect(t.pairing.verify(first ?? '')).toBeNull()
    expect(t.pairing.verify(second ?? '')).not.toBeNull()
  })
})
