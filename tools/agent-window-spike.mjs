#!/usr/bin/env node
/**
 * Б0 spike for Okolos Bridge: does the "agent window" door work as the report
 * claims, measured on this machine rather than read from Chromium's source?
 *
 *   node tools/agent-window-spike.mjs [--out <file.json>] [--chrome <binary>] [--cft <binary>]
 *
 * The door: Okolos Agent launches the person's own installed Chrome on a separate
 * profile and drives it over CDP through a pipe (`--remote-debugging-pipe`), not a
 * port and not the extension `debugger` API. Four questions, each answered by a
 * measurement with a control beside it, because a probe nobody has watched say
 * "yes" proves nothing when it says "no":
 *
 *   1. Is there an infobar? Measured as the browser frame's height
 *      (`outerHeight - innerHeight`) against two controls on the same binary:
 *      `--enable-automation`, which is known to add the "controlled by automated
 *      test software" bar, and a Chrome for Testing build loading an extension
 *      that attaches `chrome.debugger`, with and without
 *      `--silent-debugger-extension-api`.
 *   2. Does CDP work — an accessibility snapshot, and input that a page sees as
 *      `isTrusted`?
 *   3. What does a snapshot cost — raw `Accessibility.getFullAXTree` bytes, the
 *      compacted form an agent would read, and the time to take it — against the
 *      1 MB ceiling Native Messaging puts on a host-to-extension message?
 *   4. Does the agent window take focus from the person's foreground app?
 *
 * It starts real browser processes on throw-away profiles and stops every one of
 * them before it exits, on every path. It never touches the person's own profile
 * or any running browser.
 */
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'

/** The Native Messaging ceiling for one host → extension message (Chrome docs). */
export const NATIVE_MESSAGE_LIMIT = 1024 * 1024

/**
 * Splits the pipe's byte stream into CDP messages.
 *
 * Chrome writes each message as JSON followed by a NUL byte. A read can end in
 * the middle of a message, so whatever follows the last NUL is carried into the
 * next call rather than parsed or dropped.
 *
 * @param {string} pending text left over from the previous read
 * @param {string} chunk the text just read
 * @returns {{ messages: string[], pending: string }}
 */
export function splitFrames(pending, chunk) {
  const parts = (pending + chunk).split('\0')
  const rest = parts.pop() ?? ''
  return { messages: parts.filter((p) => p.length > 0), pending: rest }
}

/** Roles an agent acts on or reads to find its way; everything else is layout. */
const KEPT_ROLES = new Set([
  'button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch',
  'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'tab', 'slider', 'spinbutton',
  'heading', 'img', 'listbox', 'menu', 'tablist', 'dialog', 'alertdialog', 'alert',
  'navigation', 'main', 'form', 'search', 'banner', 'contentinfo', 'region', 'article',
  'cell', 'columnheader', 'rowheader', 'StaticText',
])

/**
 * The accessibility tree an agent would actually be handed: one line per node it
 * can act on or orient by, with a short reference it can name back.
 *
 * Ignored nodes and anonymous layout are dropped. A static text run is kept only
 * when it carries words, and long names are cut — the size of what reaches the
 * model is the question being measured, so the cut is part of the format.
 *
 * @param {Array<{ nodeId: string, ignored?: boolean, role?: { value?: string }, name?: { value?: string } }>} nodes
 * @param {number} [nameLimit]
 * @returns {{ text: string, kept: number }}
 */
export function compactAxTree(nodes, nameLimit = 120) {
  const lines = []
  for (const node of nodes) {
    if (node.ignored) continue
    const role = node.role?.value ?? ''
    if (!KEPT_ROLES.has(role)) continue
    const raw = (node.name?.value ?? '').replace(/\s+/g, ' ').trim()
    if (role === 'StaticText' && raw.length < 2) continue
    const name = raw.length > nameLimit ? `${raw.slice(0, nameLimit)}…` : raw
    lines.push(`e${node.nodeId} ${role === 'StaticText' ? 'text' : role}${name ? ` "${name}"` : ''}`)
  }
  return { text: lines.join('\n'), kept: lines.length }
}

/** The number of NUL-framed messages of at most `limit` bytes a payload needs. */
export function chunksNeeded(bytes, limit = NATIVE_MESSAGE_LIMIT) {
  return bytes === 0 ? 0 : Math.ceil(bytes / limit)
}

// ---------------------------------------------------------------------------
// Everything below drives real processes and is exercised by running the spike,
// not by unit tests.

const DEFAULT_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

function arg(name) {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : undefined
}

/** The newest Chrome for Testing in Puppeteer's cache, if there is one. */
function findChromeForTesting() {
  const base = path.join(process.env.HOME ?? '', '.cache/puppeteer/chrome')
  if (!existsSync(base)) return undefined
  const versions = execFileSync('ls', [base], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).sort()
  for (const v of versions.reverse()) {
    const bin = path.join(base, v, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')
    if (existsSync(bin)) return bin
  }
  return undefined
}

function frontmostApp() {
  try {
    return execFileSync(
      'osascript',
      ['-e', 'tell application "System Events" to get name of first application process whose frontmost is true'],
      { encoding: 'utf8', timeout: 5000 },
    ).trim()
  } catch (cause) {
    return `unreadable: ${cause instanceof Error ? cause.message.split('\n')[0] : String(cause)}`
  }
}

/** Brings an app back to the front by name — used only to restore the person's own app. */
function activate(name) {
  try {
    execFileSync('osascript', ['-e', `tell application "${name.replace(/"/g, '')}" to activate`], { timeout: 5000 })
  } catch {
    // restoring focus is a courtesy; a failure shows up in the next frontmost reading
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** One browser on a throw-away profile, spoken to over the CDP pipe. */
class PipeBrowser {
  constructor(binary, flags) {
    this.profile = mkdtempSync(path.join(tmpdir(), 'okolos-b0-'))
    this.child = spawn(
      binary,
      [
        `--user-data-dir=${this.profile}`,
        '--remote-debugging-pipe',
        '--no-first-run',
        '--no-default-browser-check',
        '--use-mock-keychain',
        '--password-store=basic',
        ...flags,
        'about:blank',
      ],
      { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'], detached: true },
    )
    this.stderr = ''
    this.child.stdio[2].on('data', (d) => {
      this.stderr = (this.stderr + d.toString()).slice(-4000)
    })
    this.nextId = 1
    this.waiting = new Map()
    this.events = []
    this.pending = ''
    this.child.stdio[4].setEncoding('utf8')
    this.child.stdio[4].on('data', (chunk) => {
      const { messages, pending } = splitFrames(this.pending, chunk)
      this.pending = pending
      for (const text of messages) {
        const msg = JSON.parse(text)
        if (msg.id && this.waiting.has(msg.id)) {
          const { resolve, reject } = this.waiting.get(msg.id)
          this.waiting.delete(msg.id)
          if (msg.error) reject(new Error(`${msg.error.code}: ${msg.error.message}`))
          else resolve(msg.result)
        } else if (msg.method) {
          this.events.push(msg)
        }
      }
    })
    this.exited = new Promise((r) => this.child.on('exit', r))
  }

  send(method, params = {}, sessionId, timeoutMs = 30000) {
    const id = this.nextId++
    const message = { id, method, params, ...(sessionId ? { sessionId } : {}) }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id)
        reject(new Error(`timeout after ${timeoutMs} ms: ${method}`))
      }, timeoutMs)
      this.waiting.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      })
      this.child.stdio[3].write(`${JSON.stringify(message)}\0`)
    })
  }

  async firstPage() {
    for (let i = 0; i < 50; i++) {
      const { targetInfos } = await this.send('Target.getTargets')
      const page = targetInfos.find((t) => t.type === 'page')
      if (page) {
        const { sessionId } = await this.send('Target.attachToTarget', { targetId: page.targetId, flatten: true })
        return { targetId: page.targetId, sessionId }
      }
      await sleep(200)
    }
    throw new Error('no page target appeared within 10 s')
  }

  async targets() {
    return (await this.send('Target.getTargets')).targetInfos
  }

  async close() {
    try {
      await this.send('Browser.close', {}, undefined, 5000)
    } catch {
      // the process may already be gone; the group kill below is the guarantee
    }
    const done = await Promise.race([this.exited.then(() => true), sleep(5000).then(() => false)])
    if (!done) {
      try {
        process.kill(-this.child.pid, 'SIGKILL')
      } catch {
        // already exited between the check and the kill
      }
      await this.exited
    }
    rmSync(this.profile, { recursive: true, force: true })
  }
}

async function evaluate(browser, sessionId, expression) {
  const { result, exceptionDetails } = await browser.send(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true },
    sessionId,
  )
  if (exceptionDetails) throw new Error(`page threw: ${exceptionDetails.text}`)
  return result.value
}

async function navigate(browser, sessionId, url) {
  await browser.send('Page.enable', {}, sessionId)
  await browser.send('Page.navigate', { url }, sessionId)
  for (let i = 0; i < 150; i++) {
    const state = await evaluate(browser, sessionId, 'document.readyState').catch(() => 'loading')
    if (state === 'complete') return
    await sleep(200)
  }
  throw new Error(`page did not finish loading in 30 s: ${url}`)
}

/** Browser frame height in CSS pixels: tab strip, toolbar and any infobar. */
async function frameHeight(browser, sessionId) {
  return evaluate(browser, sessionId, 'window.outerHeight - window.innerHeight')
}

/** A local page that reports whether the click it received was trusted. */
function fixtureServer() {
  const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>b0</title></head>
<body><button id="b" style="position:absolute;left:40px;top:40px;width:200px;height:60px">Press</button>
<script>window.clicks=[];document.getElementById('b').addEventListener('click',e=>window.clicks.push(e.isTrusted))</script>
</body></html>`
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(page)
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
}

/** A minimal MV3 extension that attaches chrome.debugger to the first web tab. */
function debuggerExtension(dir) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    path.join(dir, 'manifest.json'),
    JSON.stringify({
      manifest_version: 3,
      name: 'okolos-b0-debugger-probe',
      version: '0.0.1',
      permissions: ['debugger', 'tabs'],
      background: { service_worker: 'sw.js' },
    }),
  )
  writeFileSync(
    path.join(dir, 'sw.js'),
    // Attaches, then proves it attached by writing to the page through the
    // debugger: a probe that only *tried* would read the same as one that worked.
    `async function go(){const tabs=await chrome.tabs.query({});for(const t of tabs){if(t.url&&t.url.startsWith('http')){try{await chrome.debugger.attach({tabId:t.id},'1.3')}catch(e){}try{await chrome.debugger.sendCommand({tabId:t.id},'Runtime.evaluate',{expression:"document.title='okolos-debugger-attached'"})}catch(e){}}}}
chrome.tabs.onUpdated.addListener((id,info)=>{if(info.status==='complete')go()});go();`,
  )
  return dir
}

const PUBLIC_PAGES = [
  'https://en.wikipedia.org/wiki/Google_Chrome',
  'https://github.com/microsoft/playwright-mcp',
  'https://news.ycombinator.com/',
  'https://www.bbc.com/news',
]

async function measureInfobar(binary, label, flags, url, withExtension) {
  const extraFlags = [...flags]
  let extDir
  if (withExtension) {
    extDir = debuggerExtension(mkdtempSync(path.join(tmpdir(), 'okolos-b0-ext-')))
    extraFlags.push(`--load-extension=${extDir}`, `--disable-extensions-except=${extDir}`)
  }
  const browser = new PipeBrowser(binary, extraFlags)
  try {
    const { sessionId } = await browser.firstPage()
    await navigate(browser, sessionId, url)
    await sleep(2500)
    const height = await frameHeight(browser, sessionId)
    // Our extension's own service worker, not any of Chrome's component extensions,
    // which also run service workers and made an earlier version of this check
    // answer "loaded" on every run.
    const ourWorker = withExtension
      ? (await browser.targets()).some((t) => t.type === 'service_worker' && t.url.endsWith('/sw.js'))
      : null
    const debuggerAttached = withExtension ? (await evaluate(browser, sessionId, 'document.title')) === 'okolos-debugger-attached' : null
    return {
      label,
      flags: extraFlags.map((f) => f.replace(/=.*okolos-b0-ext-[^/]+/, '=<ext>')),
      frameHeight: height,
      extensionLoaded: ourWorker,
      debuggerAttached,
    }
  } finally {
    await browser.close()
    if (extDir) rmSync(extDir, { recursive: true, force: true })
  }
}

async function main() {
  const chrome = arg('--chrome') ?? DEFAULT_CHROME
  const cft = arg('--cft') ?? findChromeForTesting()
  const out = arg('--out')
  if (!existsSync(chrome)) throw new Error(`no Chrome at ${chrome}`)
  const version = (bin) => execFileSync(bin, ['--version'], { encoding: 'utf8' }).trim()

  const server = await fixtureServer()
  const fixture = `http://127.0.0.1:${server.address().port}/`
  const report = {
    measuredAt: new Date().toISOString(),
    chrome: version(chrome),
    chromeForTesting: cft ? version(cft) : null,
    infobar: [],
    cdp: null,
    snapshots: [],
    focus: [],
    notCovered: [],
  }

  try {
    // 1. Infobar, with positive controls.
    report.infobar.push(await measureInfobar(chrome, 'stable, pipe, agent profile', [], fixture, false))
    report.infobar.push(await measureInfobar(chrome, 'stable, pipe + --enable-automation (positive control)', ['--enable-automation'], fixture, false))
    report.infobar.push(await measureInfobar(chrome, 'stable, --load-extension (expected ignored since 137)', [], fixture, true))
    if (cft) {
      report.infobar.push(await measureInfobar(cft, 'CfT, pipe', [], fixture, false))
      report.infobar.push(await measureInfobar(cft, 'CfT, debugger extension attached', [], fixture, true))
      report.infobar.push(
        await measureInfobar(cft, 'CfT, debugger extension + --silent-debugger-extension-api', ['--silent-debugger-extension-api'], fixture, true),
      )
    } else {
      report.notCovered.push('Chrome for Testing not found: the chrome.debugger infobar and its silencing flag were not measured')
    }

    // 2–4. CDP, snapshots and focus on the agent profile of stable Chrome.
    const before = frontmostApp()
    const browser = new PipeBrowser(chrome, [])
    try {
      await sleep(3000)
      report.focus.push({ moment: 'before launch', frontmost: before })
      report.focus.push({ moment: '3 s after launch (default startup window)', frontmost: frontmostApp() })
      const { sessionId } = await browser.firstPage()

      await navigate(browser, sessionId, fixture)
      report.focus.push({ moment: 'after navigating the startup window', frontmost: frontmostApp() })
      const box = await evaluate(browser, sessionId, 'JSON.stringify(document.getElementById("b").getBoundingClientRect())')
      const r = JSON.parse(box)
      const x = r.x + r.width / 2
      const y = r.y + r.height / 2
      for (const type of ['mousePressed', 'mouseReleased']) {
        await browser.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }, sessionId)
      }
      const clicks = await evaluate(browser, sessionId, 'window.clicks')
      const ax = await browser.send('Accessibility.getFullAXTree', {}, sessionId)
      report.cdp = {
        clicksSeenByPage: clicks,
        inputIsTrusted: Array.isArray(clicks) && clicks.length === 1 && clicks[0] === true,
        axNodesOnFixture: ax.nodes.length,
      }

      // A background tab, the way the bridge would open a task's page.
      const { targetId: bgTarget } = await browser.send('Target.createTarget', { url: 'about:blank', background: true })
      await sleep(1500)
      report.focus.push({ moment: 'after Target.createTarget background:true', frontmost: frontmostApp() })
      const { sessionId: bgSession } = await browser.send('Target.attachToTarget', { targetId: bgTarget, flatten: true })

      for (const url of PUBLIC_PAGES) {
        try {
          await navigate(browser, bgSession, url)
          await sleep(1500)
          const t0 = performance.now()
          const full = await browser.send('Accessibility.getFullAXTree', {}, bgSession, 60000)
          const ms = performance.now() - t0
          const rawBytes = Buffer.byteLength(JSON.stringify(full))
          const compact = compactAxTree(full.nodes)
          const compactBytes = Buffer.byteLength(compact.text)
          report.snapshots.push({
            url,
            axNodes: full.nodes.length,
            rawBytes,
            rawChunks: chunksNeeded(rawBytes),
            compactLines: compact.kept,
            compactBytes,
            compactChunks: chunksNeeded(compactBytes),
            approxCompactTokens: Math.round(compactBytes / 4),
            msToSnapshot: Math.round(ms),
          })
        } catch (cause) {
          report.snapshots.push({ url, error: cause instanceof Error ? cause.message : String(cause) })
        }
      }
      report.focus.push({ moment: 'after four navigations in the background tab', frontmost: frontmostApp() })

      // Launch takes focus once. The question for a running bridge is whether
      // work in an already-open agent window takes it again, so the person's app
      // is put back in front and the work repeated.
      if (!before.startsWith('unreadable')) {
        activate(before)
        await sleep(1500)
        report.focus.push({ moment: 'the person\'s app put back in front', frontmost: frontmostApp() })
        const { targetId: t2 } = await browser.send('Target.createTarget', { url: 'about:blank', background: true })
        const { sessionId: s2 } = await browser.send('Target.attachToTarget', { targetId: t2, flatten: true })
        await navigate(browser, s2, fixture)
        for (const type of ['mousePressed', 'mouseReleased']) {
          await browser.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }, s2)
        }
        await browser.send('Accessibility.getFullAXTree', {}, s2)
        await sleep(1500)
        report.focus.push({ moment: 'after background tab + navigate + click + snapshot, window already open', frontmost: frontmostApp() })
        const clicks2 = await evaluate(browser, s2, 'window.clicks')
        report.cdp.backgroundTabClicks = clicks2
        report.cdp.backgroundTabClickTrusted = Array.isArray(clicks2) && clicks2[0] === true
        report.cdp.backgroundTabVisibility = await evaluate(browser, s2, 'document.visibilityState')

        // The candidate fix: tell the renderer to behave as focused and visible
        // without raising the tab, then click again.
        await browser.send('Emulation.setFocusEmulationEnabled', { enabled: true }, s2)
        for (const type of ['mousePressed', 'mouseReleased']) {
          await browser.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }, s2)
        }
        await sleep(500)
        const clicks3 = await evaluate(browser, s2, 'window.clicks')
        report.cdp.backgroundTabClicksWithFocusEmulation = clicks3
        report.focus.push({ moment: 'after a click with focus emulation in the background tab', frontmost: frontmostApp() })
      }
    } finally {
      await browser.close()
    }

    // A launch with no startup window: the window is created by CDP in the
    // background, which is how the bridge would start one when the person is busy.
    if (!before.startsWith('unreadable')) {
      activate(before)
      await sleep(1500)
      const quiet = new PipeBrowser(chrome, ['--no-startup-window'])
      try {
        await sleep(3000)
        report.focus.push({ moment: '3 s after launch with --no-startup-window', frontmost: frontmostApp() })
        const { targetId } = await quiet.send('Target.createTarget', { url: 'about:blank', newWindow: true, background: true })
        const { sessionId } = await quiet.send('Target.attachToTarget', { targetId, flatten: true })
        await navigate(quiet, sessionId, fixture)
        await sleep(1500)
        report.focus.push({ moment: 'after Target.createTarget newWindow+background and navigate', frontmost: frontmostApp() })
        report.focus.push({ moment: 'window visible to the person', frontmost: String(await evaluate(quiet, sessionId, 'document.visibilityState')) })
      } finally {
        await quiet.close()
        activate(before)
      }
    }

    report.notCovered.push(
      'Chrome 155 stable: this machine had 154 at measurement time',
      'enterprise policies (CommandLineFlagSecurityWarningsEnabled, blocked hosts, DLP): not set on the operator machine on purpose',
      'frame height is a proxy for an infobar; the positive controls are what make it readable',
    )
  } finally {
    server.close()
  }

  const json = `${JSON.stringify(report, null, 2)}\n`
  if (out) writeFileSync(out, json)
  process.stdout.write(json)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((cause) => {
    process.stderr.write(`agent-window-spike: ${cause instanceof Error ? cause.stack : String(cause)}\n`)
    process.exit(1)
  })
}
