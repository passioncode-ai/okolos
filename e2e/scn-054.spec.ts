import { mkdtempSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Worker } from '@playwright/test'

import { createAgent, type Agent } from '../apps/agent/src/agent.js'
import { cliMessages } from '../apps/agent/src/cli/messages.js'
import { relay } from '../apps/agent/src/cli/mcp-stdio.js'
import { pair } from '../apps/agent/src/cli/pair.js'
import { serviceDirs } from '../apps/agent/src/service/dirs.js'

import { expect, test } from './hooks.js'
import { extensionWorker } from './ready.js'

/**
 * SCN-054: Okolos connects to a real Okolos Agent on loopback, in Chromium, on the built
 * extension (B-218 wave (a), spec step 5).
 *
 * The daemon runs in this process on a temporary home and a free port; the test build reads
 * that port from `test:agentDoorPort` (the store build has 47871 alone, where the person's own
 * Okolos Agent may be listening). What a person does is done as they do it: the code comes
 * from the Okolos Agent page's API, is typed into «Ваши данные» and connected there; an agent
 * paired the usual way asks `okolos.ping` through `execute`, and the answer comes from the
 * extension's background over the browser's own fetch: its Origin, its CORS preflight, its
 * Fetch Metadata, which the daemon's unit tests can only imitate. The page then disconnects
 * it, and the extension's next look forgets the link (WA-4).
 *
 * The wake is not waited for: the alarm is set to fire now from the worker, which an unpacked
 * extension may do at any interval. Firefox does not run this: its harness cannot open the
 * extension's pages (`tools/firefox-e2e.mjs`, «Known limit»), so it cannot type the code.
 */

const here = path.dirname(fileURLToPath(import.meta.url))

function http(port: number, pathname: string, options: { method?: string; headers?: Record<string, string> } = {}): Promise<{ status: number; body: string; cookie: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: pathname, method: options.method ?? 'GET', headers: { Host: `127.0.0.1:${port}`, ...options.headers }, agent: false }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => (body += chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, cookie: String(res.headers['set-cookie'] ?? '').split(';')[0] ?? '' }))
    })
    req.on('error', reject)
    req.end()
  })
}

/** Fires the alarm `okolos:agent` now, so the background wakes for Okolos Agent at once. */
async function wake(worker: Worker): Promise<void> {
  await worker.evaluate(() => chrome.alarms.create('okolos:agent', { when: Date.now() }))
}

let home = ''
let agent: Agent | undefined

test.afterEach(async () => {
  await agent?.close()
  agent = undefined
  if (home !== '') rmSync(home, { recursive: true, force: true })
  home = ''
})

test('connects Okolos to Okolos Agent by a code, answers an agent through execute, and is disconnected from the page', async ({ context, extensionId }) => {
  home = mkdtempSync(path.join(os.tmpdir(), 'okolos-scn054-'))
  agent = await createAgent({
    port: 0,
    version: '0.0.0-e2e',
    buildRoot: path.join(here, '..', 'apps', 'agent'),
    probeSource: '',
    chromeBinary: null,
    home,
    locale: 'en',
    timeZone: 'UTC',
    exit: (code) => {
      throw new Error(`exit ${code}`)
    },
  })
  const port = agent.service.port
  const base = `http://127.0.0.1:${port}`
  // The suite answers every http(s) request with 503 so nothing reaches the internet; this one
  // is the daemon on this machine, which is the point of the test.
  await context.route(`${base}/**`, (route) => route.continue())
  const worker = await extensionWorker(context)
  await worker.evaluate((p) => chrome.storage.local.set({ 'test:agentDoorPort': p }), port)

  // The person opens the Okolos Agent page in Fabric Dashboards and presses «Connect Okolos».
  const cookie = (await http(port, agent.service.codes.issue().url)).cookie
  const write = { cookie, origin: base, 'x-okolos-request': '1' }
  const state = async () => JSON.parse((await http(port, '/api/state', { headers: { cookie } })).body) as { okolos: { state: string; code: string | null } }
  expect((await state()).okolos.state).toBe('unpaired')
  expect((await http(port, '/api/extension/code', { method: 'POST', headers: write })).status).toBe(200)
  const code = (await state()).okolos.code
  expect(code).toMatch(/^\d{6}$/)

  // ...and types the code into Okolos's settings.
  const settings = await context.newPage()
  await settings.goto(`chrome-extension://${extensionId}/options.html#data`)
  await settings.locator('[data-role=agent-door-code]').fill(code ?? '')
  await settings.locator('[data-role=agent-door-pair]').click()
  await expect(settings.locator('[data-role=agent-door-state]')).toContainText('Connected since')
  await expect(settings.locator('[data-role=agent-door-failed]')).toHaveCount(0)
  expect((await state()).okolos.state).toBe('paired')

  // An agent with access asks Okolos for its version through the door.
  const dirs = serviceDirs(home)
  const say = cliMessages('en')
  const asking = pair({ name: 'scout', base, dirs, say, print: () => undefined })
  let handle: string | undefined
  for (let i = 0; i < 50 && handle === undefined; i++) {
    const page = JSON.parse((await http(port, '/api/state', { headers: { cookie } })).body) as { pairing: { requests?: { handle: string }[] } }
    handle = page.pairing.requests?.[0]?.handle
    if (handle === undefined) await new Promise((resolve) => setTimeout(resolve, 100))
  }
  expect(handle).toBeDefined()
  expect((await http(port, `/api/pairing/${handle}/confirm`, { method: 'POST', headers: write })).status).toBe(200)
  expect(await asking).toBe(0)

  const answers: string[] = []
  async function* input(): AsyncIterable<string> {
    yield JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'execute', arguments: { operation: 'okolos.ping', arguments: {} } } })
  }
  const called = relay({ name: 'scout', base, dirs, say, input: input(), output: (line) => answers.push(line), error: () => undefined })
  // The call waits with Okolos Agent until the extension looks; it looks now.
  await new Promise((resolve) => setTimeout(resolve, 300))
  await wake(worker)
  expect(await called).toBe(0)
  const result = JSON.parse((JSON.parse(answers[0] ?? '{}') as { result: { content: { text: string }[] } }).result.content[0]?.text ?? '{}') as {
    success: boolean
    data?: { extensionVersion?: string; connectedSince?: string }
  }
  expect(result.success).toBe(true)
  expect(result.data?.extensionVersion).toBe(await worker.evaluate(() => chrome.runtime.getManifest().version))
  expect(Date.parse(result.data?.connectedSince ?? '')).not.toBeNaN()

  // The person disconnects on the Okolos Agent page; the extension's next look forgets the link.
  const released = JSON.parse((await http(port, '/api/extension/release', { method: 'POST', headers: write })).body) as { notice: string }
  expect(released.notice).toBe('The Okolos extension was disconnected')
  await wake(worker)
  await expect
    .poll(() => worker.evaluate(async () => (await chrome.storage.local.get('agent:link'))['agent:link'] === undefined), { timeout: 15_000 })
    .toBe(true)
  await expect.poll(() => worker.evaluate(async () => (await chrome.alarms.get('okolos:agent')) === undefined), { timeout: 15_000 }).toBe(true)
  await settings.reload()
  await expect(settings.locator('[data-role=agent-door-pair]')).toBeVisible()
})
