import { existsSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import type { BrowserContext, Page } from '@playwright/test'

import { SURFACE_MOUNT_MS } from './budgets.js'
import { expect, serve, test } from './hooks.js'
import { extensionWorker } from './ready.js'

/**
 * SCN-012 with a download the browser really makes (B-201).
 *
 * Until now the download path was proven only by unit tests over a fake `chrome.downloads`,
 * and the panel's words ("nothing reached the disk") rest on how the browser behaves: that a
 * cancel stops a download, that a finished one is removed, that the item the panel names is
 * gone. Here Chromium downloads for real, twice: a small file that is whole before the
 * extension has read its feed, and a slow one that is still arriving when it is stopped. Both
 * hosts are on the feed, so both are blocked; what is asserted is what the person would see
 * and what the browser says happened to the file.
 *
 * Firefox runs the same two cases in `e2e/gecko/scn-012-real-download.spec.ts` (B-201), through
 * geckodriver, with real host names pointed at a local server.
 */

/** Puts `hosts` on the phishing feed the extension reads, as the feed pull would. */
async function listHosts(context: BrowserContext, extensionId: string, hosts: string[]): Promise<void> {
  const page = await context.newPage()
  await page.goto(`chrome-extension://${extensionId}/options.html`)
  await page.evaluate(async (entries) => {
    const open = indexedDB.open('okolos')
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      open.onsuccess = () => resolve(open.result)
      open.onerror = () => reject(open.error)
    })
    const tx = db.transaction(['feeds'], 'readwrite')
    const now = new Date().toISOString()
    tx.objectStore('feeds').put({ name: 'phishing', version: 1, updatedAt: now, storedAt: now, entries })
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
    db.close()
  }, hosts)
  await page.close()
}

/** The panel's headline and detail, through the test build's open root. */
async function panel(page: Page): Promise<{ headline: string; detail: string }> {
  const banner = page.locator('okolos-banner')
  await expect(banner).toHaveCount(1, { timeout: SURFACE_MOUNT_MS })
  return {
    headline: (await banner.locator('[data-role=headline]').textContent()) ?? '',
    detail: (await banner.locator('[data-role=detail]').textContent()) ?? '',
  }
}

/** A sentence of the catalogue, in the browser's language, as the extension writes it. */
async function sentence(page: Page, extensionId: string, key: string): Promise<string> {
  const words = await page.context().newPage()
  await words.goto(`chrome-extension://${extensionId}/options.html`)
  const text = await words.evaluate((name) => chrome.i18n.getMessage(name), key)
  await words.close()
  return text
}

/** What the browser still lists of downloads, after the extension has dealt with them. */
async function listed(context: BrowserContext): Promise<Array<{ state: string; exists: boolean }>> {
  const worker = await extensionWorker(context)
  return worker.evaluate(async () =>
    (await chrome.downloads.search({})).map((item) => ({ state: item.state, exists: item.exists })),
  )
}

test('a small file from a listed host is stopped and removed, and the panel says so', async ({
  context,
  extensionId,
}) => {
  await context.route('https://files.test/**', (route) =>
    route.fulfill({
      status: 200,
      headers: {
        'content-type': 'application/pdf',
        'content-disposition': 'attachment; filename="invoice.pdf"',
      },
      body: Buffer.from('%PDF-1.4 a few bytes, whole before the feed is read'),
    }),
  )
  await listHosts(context, extensionId, ['files.test'])
  await serve(context, '<!doctype html><a id="dl" href="https://files.test/invoice.pdf" download>Invoice</a>')
  const page = await context.newPage()
  await page.goto('https://fixture.test/')

  const download = page.waitForEvent('download')
  await page.locator('#dl').click()

  const shown = await panel(page)
  expect(shown.headline).toBe(await sentence(page, extensionId, 'warnDownloadBlockedHeadline'))
  expect(shown.detail).toContain(await sentence(page, extensionId, 'warnDownloadCancelled'))
  /**
   * Measured 2026-11-18: a file this small is whole before the feed is read, so Chromium
   * completes it and the extension removes it. The headline used to say "stopped before it was
   * saved", which was false here; it now says stopped and removed, true in both cases (B-201).
   * What is asserted is the disk: the file the browser wrote is gone.
   */
  const written = await (await download).path().catch(() => null)
  expect(written === null || !existsSync(written), `the file is still on disk at ${written}`).toBe(true)
  // And nothing finished is left in the browser's list: the item was removed with its file.
  expect((await listed(context)).filter((item) => item.state === 'complete' && item.exists)).toEqual([])
})

test('a slow file from a listed host is stopped while it is still arriving', async ({ context, extensionId }) => {
  // A real server, because a routed response arrives whole: the case is a download the
  // browser is still writing when the cancel lands.
  let finished = false
  const server: Server = createServer((_request, response) => {
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
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  const address = `http://127.0.0.1:${port}/update.zip`
  try {
    // Past the suite's own guard, which answers every other address with a 503.
    await context.route(`http://127.0.0.1:${port}/**`, (route) => route.continue())
    await listHosts(context, extensionId, ['127.0.0.1'])
    await serve(context, `<!doctype html><a id="dl" href="${address}" download>Update</a>`)
    const page = await context.newPage()
    await page.goto('https://fixture.test/')

    const download = page.waitForEvent('download')
    await page.locator('#dl').click()

    const shown = await panel(page)
    expect(shown.headline).toBe(await sentence(page, extensionId, 'warnDownloadBlockedHeadline'))
    expect(shown.detail).toContain(await sentence(page, extensionId, 'warnDownloadCancelled'))
    expect(await (await download).failure()).not.toBeNull()
    // Stopped while it was arriving: the server never got to send the last chunk.
    expect(finished, 'the whole file was sent, so this did not test a stop in flight').toBe(false)
    expect((await listed(context)).filter((item) => item.state === 'complete' && item.exists)).toEqual([])
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
