/**
 * The agents' window on the person's own Chrome stable (N-010, REQ-61).
 *
 * Runs only when asked: `OKOLOS_CHROME_TESTS=1 pnpm exec vitest run
 * apps/agent/src/window/window.chrome.test.ts` on a machine with Chrome stable
 * and a screen (docs/runbooks/development.md). Hosted CI has neither a person's
 * screen nor a person to keep the focus for, and the pre-push gate must not put
 * a window in front of whoever pushes.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'

import { CdpPipe } from '@okolos/cdp-pipe'
import type { CdpTransport } from '@okolos/cdp-pipe'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { findChrome } from './chrome.js'
import { AgentWindows } from './window.js'

const chrome = findChrome()
const asked = process.env.OKOLOS_CHROME_TESTS === '1'
const why = !asked ? 'OKOLOS_CHROME_TESTS=1 is not set' : chrome === null ? 'Chrome stable is not installed' : ''

/** The processes whose command line names this profile. */
function processesOf(profileDir: string): number[] {
  try {
    return execFileSync('pgrep', ['-f', `user-data-dir=${profileDir}`], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
      .map(Number)
  } catch {
    return []
  }
}

/**
 * The application in front, or `null` when System Events will not say: no
 * Automation permission, or no application in front (a locked screen). The
 * focus check is then skipped, and the run says so.
 */
function frontmost(): string | null {
  try {
    return execFileSync(
      'osascript',
      ['-e', 'tell application "System Events" to get name of first application process whose frontmost is true'],
      { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim()
  } catch {
    return null
  }
}

async function until(check: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (check()) return true
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return check()
}

async function navigate(browser: CdpTransport, sessionId: string, url: string): Promise<void> {
  await browser.send('Page.enable', {}, sessionId)
  const loaded = new Promise<void>((resolve) => {
    const off = browser.on('Page.loadEventFired', (_params, from) => {
      if (from === sessionId) {
        off()
        resolve()
      }
    })
  })
  await browser.send('Page.navigate', { url }, sessionId)
  await loaded
}

async function evaluate<T>(browser: CdpTransport, sessionId: string, expression: string): Promise<T> {
  const answer = await browser.send<{ result: { value: T } }>('Runtime.evaluate', { expression, returnByValue: true }, sessionId)
  return answer.result.value
}

describe.skipIf(why !== '')(`agent window on Chrome stable${why === '' ? '' : ` (skipped: ${why})`}`, () => {
  const binary = chrome ?? ''
  let server: Server
  let origin = ''
  const profiles: string[] = []
  const profile = (): string => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'okolos-agent-window-'))
    profiles.push(dir)
    return dir
  }

  beforeAll(async () => {
    server = createServer((request, response) => {
      if (request.url === '/set') {
        const expires = new Date(Date.now() + 86_400_000).toUTCString()
        response.setHeader('set-cookie', [`kept=1; Expires=${expires}; Path=/`, 'session=1; Path=/'])
      }
      response.setHeader('content-type', 'text/html; charset=utf-8')
      response.end('<!doctype html><title>okolos window test</title><p>page</p>')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(() => {
    server.close()
    for (const dir of profiles) {
      for (const pid of processesOf(dir)) process.kill(pid, 'SIGKILL')
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('opens a visible task window behind the person, with no automation bar, and leaves no process', { timeout: 90_000 }, async () => {
    const dir = profile()
    const windows = new AgentWindows({ binary, profileDir: dir })
    const before = frontmost()
    const opened = await windows.openWindow()
    const browser = await windows.transport()
    await navigate(browser, opened.cdpSessionId, `${origin}/`)
    expect(await evaluate(browser, opened.cdpSessionId, 'document.visibilityState')).toBe('visible')
    const frame = await evaluate<number>(browser, opened.cdpSessionId, 'window.outerHeight - window.innerHeight')
    expect(frame).toBeLessThan(120)
    if (before === null) console.warn('agent window test: no application in front, focus not checked')
    else expect(frontmost()).toBe(before)
    expect(await windows.shutdown()).toEqual({ complete: true })
    expect(await until(() => processesOf(dir).length === 0, 10_000)).toBe(true)
  })

  it('a browser killed with -9 fails a waiting request as exited, and leaves no helper behind', { timeout: 90_000 }, async () => {
    const dir = profile()
    const exits: boolean[] = []
    const windows = new AgentWindows({ binary, profileDir: dir, onExit: (info) => exits.push(info.requested) })
    const opened = await windows.openWindow()
    const browser = await windows.transport()
    const waiting = browser.send('Runtime.evaluate', { expression: 'new Promise(() => {})', awaitPromise: true }, opened.cdpSessionId, {
      timeoutMs: 30_000,
    })
    const started = Date.now()
    process.kill(browser.pid, 'SIGKILL')
    await expect(waiting).rejects.toMatchObject({ kind: 'exited' })
    expect(Date.now() - started).toBeLessThan(5000)
    expect(exits).toEqual([false])
    expect(await until(() => processesOf(dir).length === 0, 15_000)).toBe(true)
    expect(windows.openWindows()).toEqual([])
  })

  it('a browser a crashed daemon left on the profile is ended before the next one starts', { timeout: 90_000 }, async () => {
    const dir = profile()
    // The daemon that crashed: it started the browser and never closed it.
    const orphan = await CdpPipe.launch({ binary, args: ['--no-startup-window', '--no-first-run'], userDataDir: dir })
    await orphan.send('Target.createTarget', { url: 'about:blank', newWindow: true, background: true })
    expect(processesOf(dir).length).toBeGreaterThan(0)
    const windows = new AgentWindows({ binary, profileDir: dir })
    await windows.openWindow()
    const browser = await windows.transport()
    expect(browser.pid).not.toBe(orphan.pid)
    expect(processesOf(dir)).not.toContain(orphan.pid)
    await windows.shutdown()
    await orphan.close(500)
    expect(await until(() => processesOf(dir).length === 0, 10_000)).toBe(true)
  })

  it('the agent profile keeps cookies with an expiry across a restart, and drops session cookies', { timeout: 120_000 }, async () => {
    const dir = profile()
    const first = new AgentWindows({ binary, profileDir: dir })
    const a = await first.openWindow()
    await navigate(await first.transport(), a.cdpSessionId, `${origin}/set`)
    await first.shutdown()
    const second = new AgentWindows({ binary, profileDir: dir })
    const b = await second.openWindow()
    const browser = await second.transport()
    await navigate(browser, b.cdpSessionId, `${origin}/`)
    const cookies = await evaluate<string>(browser, b.cdpSessionId, 'document.cookie')
    expect(cookies).toContain('kept=1')
    expect(cookies).not.toContain('session=1')
    await second.shutdown()
  })

  it('a disposable window keeps nothing: its cookies never reach the agent profile and go with it', { timeout: 90_000 }, async () => {
    const dir = profile()
    const windows = new AgentWindows({ binary, profileDir: dir })
    const temp = await windows.openWindow('disposable')
    const browser = await windows.transport()
    await navigate(browser, temp.cdpSessionId, `${origin}/set`)
    expect(await evaluate<string>(browser, temp.cdpSessionId, 'document.cookie')).toContain('kept=1')
    await windows.closeWindow(temp.targetId)
    const agent = await windows.openWindow()
    await navigate(browser, agent.cdpSessionId, `${origin}/`)
    expect(await evaluate<string>(browser, agent.cdpSessionId, 'document.cookie')).toBe('')
    const { browserContextIds } = await browser.send<{ browserContextIds: string[] }>('Target.getBrowserContexts')
    expect(browserContextIds).toEqual([])
    await windows.shutdown()
  })
})
