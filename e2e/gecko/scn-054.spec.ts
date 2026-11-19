import { mkdtempSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { expect, test } from '@playwright/test'
import { By } from 'selenium-webdriver'

import { createAgent, type Agent } from '../../apps/agent/src/agent.js'
import { cliMessages } from '../../apps/agent/src/cli/messages.js'
import { relay } from '../../apps/agent/src/cli/mcp-stdio.js'
import { pair } from '../../apps/agent/src/cli/pair.js'
import { serviceDirs } from '../../apps/agent/src/service/dirs.js'

import { RECORD_VISIBLE_MS } from '../budgets.js'
import { launchGecko, type Gecko } from './firefox.js'

/**
 * SCN-054 in Firefox: Okolos connects to a real Okolos Agent on loopback, answers an agent
 * through `execute`, and is disconnected (B-218 wave (a), finish line in Chrome and Firefox;
 * B-231).
 *
 * The path is the one `e2e/scn-054.spec.ts` walks in Chromium, on Firefox's own terms: an
 * event page rather than a service worker, Firefox's fetch from a background page to
 * 127.0.0.1, and the host permission an MV3 add-on holds there. The code is typed into «Ваши
 * данные» as a person types it; this was impossible before `e2e/gecko/firefox.ts`, because
 * geckodriver could not open an extension page.
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

let home = ''
let agent: Agent | undefined
let gecko: Gecko | undefined

test.afterEach(async () => {
  await gecko?.close()
  gecko = undefined
  await agent?.close()
  agent = undefined
  if (home !== '') rmSync(home, { recursive: true, force: true })
  home = ''
})

test('Firefox: connects Okolos to Okolos Agent by a code, answers an agent through execute, and is disconnected from the page', async () => {
  home = mkdtempSync(path.join(os.tmpdir(), 'okolos-gecko054-'))
  agent = await createAgent({
    port: 0,
    version: '0.0.0-e2e',
    buildRoot: path.join(here, '..', '..', 'apps', 'agent'),
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

  gecko = await launchGecko()
  const { driver } = gecko
  await gecko.open('options.html#data')
  // On an extension page the script runs in the extension's origin, where `browser` exists.
  await driver.executeAsyncScript(
    'const done = arguments[arguments.length - 1]; browser.storage.local.set({ "test:agentDoorPort": arguments[0] }).then(() => done(true), (e) => done(String(e)))',
    port,
  )

  // The person presses «Connect Okolos» on the Okolos Agent page...
  const cookie = (await http(port, agent.service.codes.issue().url)).cookie
  const write = { cookie, origin: base, 'x-okolos-request': '1' }
  const state = async () => JSON.parse((await http(port, '/api/state', { headers: { cookie } })).body) as { okolos: { state: string; code: string | null } }
  expect((await http(port, '/api/extension/code', { method: 'POST', headers: write })).status).toBe(200)
  const code = (await state()).okolos.code
  expect(code).toMatch(/^\d{6}$/)

  // ...and types the code into Okolos's settings, in Firefox.
  const field = await driver.findElement(By.css('[data-role=agent-door-code]'))
  await field.sendKeys(code ?? '')
  await driver.findElement(By.css('[data-role=agent-door-pair]')).click()
  const shown = async () => {
    const [line] = await driver.findElements(By.css('[data-role=agent-door-state]'))
    return line === undefined ? '' : await line.getText()
  }
  await expect.poll(shown, { timeout: RECORD_VISIBLE_MS }).toContain('Connected since')
  expect(await driver.findElements(By.css('[data-role=agent-door-failed]'))).toHaveLength(0)
  expect((await state()).okolos.state).toBe('paired')

  // An agent with access asks Okolos for its version through the door.
  const dirs = serviceDirs(home)
  const say = cliMessages('en')
  const asking = pair({ name: 'scout', base, dirs, say, print: () => undefined })
  const waiting = async () =>
    (JSON.parse((await http(port, '/api/state', { headers: { cookie } })).body) as { pairing: { requests?: { handle: string }[] } }).pairing.requests?.[0]?.handle
  await expect.poll(waiting, { timeout: RECORD_VISIBLE_MS }).toBeDefined()
  expect((await http(port, `/api/pairing/${await waiting()}/confirm`, { method: 'POST', headers: write })).status).toBe(200)
  expect(await asking).toBe(0)

  /** Fires `okolos:agent` now from the extension page, so the event page wakes for Okolos Agent. */
  const wake = () => driver.executeScript('browser.alarms.create("okolos:agent", { when: Date.now() })')
  const answers: string[] = []
  async function* input(): AsyncIterable<string> {
    yield JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'execute', arguments: { operation: 'okolos.ping', arguments: {} } } })
  }
  const called = relay({ name: 'scout', base, dirs, say, input: input(), output: (line) => answers.push(line), error: () => undefined })
  await expect
    .poll(
      async () => {
        if (answers.length === 0) await wake()
        return answers.length
      },
      { timeout: RECORD_VISIBLE_MS },
    )
    .toBe(1)
  expect(await called).toBe(0)
  const ping = JSON.parse((JSON.parse(answers[0] ?? '{}') as { result: { content: { text: string }[] } }).result.content[0]?.text ?? '{}') as {
    success: boolean
    data?: Record<string, unknown>
  }
  expect(ping.success).toBe(true)
  expect(ping.data?.['extensionVersion']).toBe(await driver.executeScript('return browser.runtime.getManifest().version'))

  // The person disconnects Okolos from the Okolos Agent page; the extension's next look forgets it.
  expect((await http(port, '/api/extension/release', { method: 'POST', headers: write })).status).toBe(200)
  await expect
    .poll(
      async () => {
        await wake()
        await driver.navigate().refresh()
        return shown()
      },
      { timeout: RECORD_VISIBLE_MS },
    )
    .not.toContain('Connected since')
})
