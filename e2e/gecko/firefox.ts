import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ChildProcess } from 'node:child_process'

import { Builder } from 'selenium-webdriver'
import { Context, Options, type Driver } from 'selenium-webdriver/firefox.js'

import { endTree, spawnTree } from '../../tools/bin.mjs'
import { findFirefox } from '../../tools/find-firefox.mjs'

import { WORKER_REGISTER_MS } from '../budgets.js'

/**
 * Firefox with the extension's own pages open to the test (B-231).
 *
 * `tools/firefox-e2e.mjs` drives web pages only: geckodriver refuses a `moz-extension://`
 * address from the content context, and Firefox answers the chrome context with «System access
 * is required» unless it was started for it, which capabilities cannot ask for (its «Known
 * limit»). So this harness starts Firefox itself, with `-marionette -remote-allow-system-access`
 * and `MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1`, attaches geckodriver to it with `--connect-existing`,
 * and opens an extension page from the chrome context with the system principal. On an
 * extension page `executeScript` runs in the extension's origin, so `browser.storage` and
 * `browser.alarms` are there, which a web page never offers.
 *
 * Measured 2026-11-19 (Nightly from the Playwright cache, macOS): `options.html#data` opened and
 * rendered «Your data». Every port is taken free at start: on this machine 4445 is a running
 * safaridriver, and a fixed port once opened a Safari session instead of Firefox.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
/** The test-hook build: it reads Okolos Agent's port from `test:agentDoorPort`. */
const BUILD = path.join(here, '..', '..', 'apps', 'extension', 'dist', 'firefox-e2e')
const EXT_ID = 'okolos@ssheleg.dev'
/** Fixed before the add-on is installed, so its pages have a known address. */
export const EXT_UUID = '11111111-2222-3333-4444-555555555555'
export const EXT_BASE = `moz-extension://${EXT_UUID}`

export interface Gecko {
  readonly driver: Driver
  /** Opens an extension page in a new tab and makes it the one the driver talks to. */
  open(page: string): Promise<void>
  close(): Promise<void>
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => (typeof address === 'object' && address !== null ? resolve(address.port) : reject(new Error('no port'))))
    })
  })
}

async function driverUp(port: number, deadline: number): Promise<void> {
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/status`)).ok) return
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`geckodriver did not answer on ${port} within ${WORKER_REGISTER_MS / 1000}s`)
}

export async function launchGecko(): Promise<Gecko> {
  const marionette = await freePort()
  const port = await freePort()
  const profile = mkdtempSync(path.join(os.tmpdir(), 'okolos-gecko-'))
  writeFileSync(
    path.join(profile, 'user.js'),
    [
      `user_pref("marionette.port", ${marionette});`,
      `user_pref("extensions.webextensions.uuids", ${JSON.stringify(JSON.stringify({ [EXT_ID]: EXT_UUID }))});`,
      'user_pref("browser.shell.checkDefaultBrowser", false);',
      'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
      'user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);',
    ].join('\n'),
  )
  // Read by the Firefox spawned below, which inherits this process's environment.
  process.env['MOZ_REMOTE_ALLOW_SYSTEM_ACCESS'] = '1'
  const browser: ChildProcess = spawnTree(findFirefox(), ['-marionette', '-remote-allow-system-access', '-headless', '-no-remote', '-profile', profile])
  const gecko: ChildProcess = spawnTree('npx', ['geckodriver', '--port', String(port), '--connect-existing', '--marionette-port', String(marionette), '--allow-system-access'])
  const end = (): void => {
    endTree(gecko)
    endTree(browser)
    rmSync(profile, { recursive: true, force: true })
  }

  let driver: Driver
  try {
    await driverUp(port, Date.now() + WORKER_REGISTER_MS)
    // geckodriver connects to Marionette when the session is created; Firefox may still be
    // starting, so the session is asked for until Marionette answers.
    const deadline = Date.now() + WORKER_REGISTER_MS
    for (;;) {
      try {
        driver = await new Builder()
          .forBrowser('firefox')
          .usingServer(`http://127.0.0.1:${port}`)
          .setFirefoxOptions(new Options().setBinary(findFirefox()))
          .build() as Driver
        break
      } catch (cause) {
        if (Date.now() > deadline) throw cause
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
    }
    const installed = await driver.installAddon(BUILD, true)
    if (installed !== EXT_ID) throw new Error(`installAddon returned ${String(installed)}, not ${EXT_ID}`)
  } catch (cause) {
    end()
    throw cause
  }

  return {
    driver,
    async open(page) {
      await driver.setContext(Context.CHROME)
      await driver.executeScript(
        `const w = Services.wm.getMostRecentWindow('navigator:browser');
         w.gBrowser.selectedTab = w.gBrowser.addTab(arguments[0], { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });`,
        `${EXT_BASE}/${page}`,
      )
      await driver.setContext(Context.CONTENT)
      const handles = await driver.getAllWindowHandles()
      await driver.switchTo().window(handles[handles.length - 1] as string)
      // The new tab starts as about:blank; wait for the extension page before anyone scripts it.
      await driver.wait(
        async () => (await driver.getCurrentUrl()).startsWith(EXT_BASE) && (await driver.executeScript('return document.readyState')) === 'complete',
        WORKER_REGISTER_MS,
      )
    },
    async close() {
      try {
        await driver.quit()
      } finally {
        end()
      }
    },
  }
}
