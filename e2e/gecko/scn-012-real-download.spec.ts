import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'

import { expect, test } from '@playwright/test'
import { By } from 'selenium-webdriver'

import { RECORD_VISIBLE_MS, SURFACE_MOUNT_MS } from '../budgets.js'
import { launchGecko, type Gecko } from './firefox.js'

/**
 * SCN-012 with a download Firefox really makes (B-201, the Firefox half).
 *
 * `e2e/scn-012-real-download.spec.ts` measured Chromium: a small file is whole before the feed
 * is read, so the extension removes it, and a slow one is stopped in flight. Firefox differs
 * where the panel's words rest on it: it refuses to cancel a download that has finished, so
 * the removal is all there is for a small file. What is asserted is what the person reads on
 * the page and what is left in the download folder and in the browser's list.
 *
 * Hosts are real names pointed at a local server by `network.dns.localDomains`, because
 * nothing intercepts Firefox's requests here the way Playwright routes Chromium's.
 */

const PAGE = 'fixture.test'
const SMALL = 'files.test'
const SLOW = 'slow.test'

let gecko: Gecko | undefined
let server: Server | undefined
let folder = ''
let finished = false

test.afterEach(async () => {
  await gecko?.close()
  gecko = undefined
  server?.closeAllConnections()
  await new Promise<void>((resolve) => (server === undefined ? resolve() : server.close(() => resolve())))
  server = undefined
  if (folder !== '') rmSync(folder, { recursive: true, force: true })
  folder = ''
})

async function start(): Promise<{ gecko: Gecko; port: number }> {
  finished = false
  server = createServer((request, response) => {
    const host = (request.headers.host ?? '').split(':')[0]
    if (host === PAGE) {
      const port = (server?.address() as AddressInfo).port
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(
        `<!doctype html><a id="small" href="http://${SMALL}:${port}/invoice.pdf">Invoice</a> <a id="slow" href="http://${SLOW}:${port}/update.zip">Update</a>`,
      )
      return
    }
    if (host === SMALL) {
      response.writeHead(200, { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="invoice.pdf"' })
      response.end(Buffer.from('%PDF-1.4 a few bytes, whole before the feed is read'))
      return
    }
    // The slow file: 64 chunks of 64 KiB, one every 150 ms, so it is still arriving when stopped.
    response.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-disposition': 'attachment; filename="update.zip"',
      'content-length': String(64 * 64 * 1024),
    })
    let sent = 0
    const tick = setInterval(() => {
      if (response.destroyed) {
        clearInterval(tick)
        return
      }
      response.write(Buffer.alloc(64 * 1024))
      sent += 1
      if (sent === 64) {
        clearInterval(tick)
        finished = true
        response.end()
      }
    }, 150)
    response.on('close', () => clearInterval(tick))
  })
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  folder = mkdtempSync(path.join(os.tmpdir(), 'okolos-gecko-dl-'))
  gecko = await launchGecko({
    'network.dns.localDomains': [PAGE, SMALL, SLOW].join(','),
    'browser.download.folderList': 2,
    'browser.download.dir': folder,
    'browser.download.useDownloadDir': true,
    'browser.download.always_ask_before_handling_new_types': false,
    'browser.download.alwaysOpenPanel': false,
    'browser.helperApps.neverAsk.saveToDisk': 'application/pdf,application/octet-stream',
    'pdfjs.disabled': true,
  })
  return { gecko, port }
}

/** Puts `hosts` on the phishing feed, from an extension page, as the feed pull would. */
async function listHosts(g: Gecko, hosts: string[]): Promise<void> {
  await g.open('options.html')
  const error = await g.driver.executeAsyncScript(
    `const done = arguments[arguments.length - 1]
     const open = indexedDB.open('okolos')
     open.onerror = () => done(String(open.error))
     open.onsuccess = () => {
       const db = open.result
       const tx = db.transaction(['feeds'], 'readwrite')
       const now = new Date().toISOString()
       tx.objectStore('feeds').put({ name: 'phishing', version: 1, updatedAt: now, storedAt: now, entries: arguments[0] })
       tx.oncomplete = () => { db.close(); done(null) }
       tx.onerror = () => done(String(tx.error))
     }`,
    hosts,
  )
  expect(error).toBeNull()
}

/** The panel's headline and detail on the page in front, through the test build's open root. */
async function panel(g: Gecko): Promise<{ headline: string; detail: string }> {
  const read = (): Promise<{ headline: string; detail: string } | null> =>
    g.driver.executeScript(`
      const root = document.querySelector('okolos-banner')?.shadowRoot
      const headline = root?.querySelector('[data-role=headline]')?.textContent
      return headline ? { headline, detail: root.querySelector('[data-role=detail]')?.textContent ?? '' } : null`)
  await expect.poll(read, { timeout: SURFACE_MOUNT_MS }).not.toBeNull()
  return (await read()) as { headline: string; detail: string }
}

/** A sentence of the catalogue and what Firefox still lists of downloads, from an extension page. */
async function fromExtension(g: Gecko, key: string): Promise<{ sentence: string; listed: Array<{ state: string; exists: boolean }> }> {
  await g.open('options.html')
  return g.driver.executeAsyncScript(
    `const done = arguments[arguments.length - 1]
     browser.downloads.search({}).then((items) => done({
       sentence: browser.i18n.getMessage(arguments[0]),
       listed: items.map((item) => ({ state: item.state, exists: item.exists })),
     }), (e) => done({ sentence: String(e), listed: [] }))`,
    key,
  )
}

test('Firefox: a small file from a listed host is removed, and the panel says so', async () => {
  const { gecko: g, port } = await start()
  await listHosts(g, [SMALL])
  await g.driver.get(`http://${PAGE}:${port}/`)
  await g.driver.findElement(By.id('small')).click()

  const shown = await panel(g)
  const headline = await fromExtension(g, 'warnDownloadBlockedHeadline')
  const detail = await fromExtension(g, 'warnDownloadCancelled')
  expect(shown.headline).toBe(headline.sentence)
  expect(shown.detail).toContain(detail.sentence)
  // The disk: no whole invoice.pdf in the folder Firefox writes to.
  await expect.poll(() => existsSync(path.join(folder, 'invoice.pdf')), { timeout: RECORD_VISIBLE_MS }).toBe(false)
  // And nothing finished is left in Firefox's list with its file.
  await expect
    .poll(async () => (await fromExtension(g, 'warnDownloadCancelled')).listed.filter((item) => item.state === 'complete' && item.exists), {
      timeout: RECORD_VISIBLE_MS,
    })
    .toEqual([])
})

test('Firefox: a slow file from a listed host is stopped while it is still arriving', async () => {
  const { gecko: g, port } = await start()
  await listHosts(g, [SLOW])
  await g.driver.get(`http://${PAGE}:${port}/`)
  await g.driver.findElement(By.id('slow')).click()

  const shown = await panel(g)
  const headline = await fromExtension(g, 'warnDownloadBlockedHeadline')
  expect(shown.headline).toBe(headline.sentence)
  expect(finished, 'the whole file was sent, so this did not test a stop in flight').toBe(false)
  await expect
    .poll(async () => (await fromExtension(g, 'warnDownloadCancelled')).listed.filter((item) => item.state === 'complete' && item.exists), {
      timeout: RECORD_VISIBLE_MS,
    })
    .toEqual([])
  expect(readdirSync(folder).filter((name) => name === 'update.zip')).toEqual([])
})
