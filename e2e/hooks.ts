import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, test as base, type BrowserContext } from '@playwright/test'

import { buildTooOld } from '../tools/build-age.mjs'

import { extensionWorker } from './ready.js'

const here = path.dirname(fileURLToPath(import.meta.url))

/**
 * The same extension, built with the shadow root open so a test can click what
 * a user clicks. Everything else is identical, and a bundle gate asserts the
 * production build never carries the flag — see REQ-35.
 */
const BUILD = path.join(here, '..', 'apps', 'extension', 'dist', 'chrome-e2e')


/**
 * Refuses before a browser starts, rather than reporting a green from an old build.
 *
 * The two harnesses load two directories and `pnpm build:e2e` refreshes one of
 * them, so "I rebuilt" and "the build under this spec is current" were different
 * facts that looked like one. A planted defect stayed green across three checks on
 * exactly that difference (B-42). Checked here rather than remembered: the habit
 * that caught it twice is not a mechanism.
 */
const stale = buildTooOld(BUILD, 'pnpm build:e2e')
if (stale !== null) throw new Error(`e2e: ${stale}`)

export const test = base.extend<{
  context: BrowserContext
  extensionId: string
  /** See `ready.ts`; only the cold-start measurement wants this. */
  coldWorker: boolean
}>({
  coldWorker: [false, { option: true }],

  context: async ({ coldWorker }, use) => {
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      args: [`--disable-extensions-except=${BUILD}`, `--load-extension=${BUILD}`],
    })
    /**
     * No test reaches the internet, in this harness too.
     *
     * `fixtures.ts` has refused outbound requests since the SCN-007 flake; this harness did
     * not, so a password that is not in the shipped common list went to the real range
     * service. Measured 2026-10-29: "a password that is not in a breach leaves the landing
     * page alone" failed one run in ten once it waited for the check to finish instead of
     * three seconds (B-169), because that check was waiting on the internet. A fixed wait
     * had been passing it on a check still in flight.
     *
     * Registered first, so any route a spec adds later takes precedence: that is how a spec
     * serves the hosts it is about.
     */
    await context.route(/^https?:\/\//, async (route) => {
      if (route.request().url().startsWith('https://fixture.test/')) return route.fallback()
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'the e2e fixture does not let the suite reach the internet' }),
      })
    })

    // Before any test navigates: a tab opened ahead of registration runs no content script
    // and never gets one, which looks exactly like a detector that found nothing.
    if (!coldWorker) await extensionWorker(context)
    await use(context)
    await context.close()
  },

  /**
   * The extension's own id, for a spec that has to read the store it writes to.
   *
   * IndexedDB is per origin, so a fixture page's `indexedDB.open('okolos')` opens an
   * empty database that has never heard of this product. Reading the journal means
   * opening an extension page, and that needs the id.
   *
   * Same shape and same named budget as `fixtures.ts`: an unnamed wait here reported
   * "Test timeout while setting up extensionId" over "target closed", which sends the
   * reader looking for a broken fixture instead of a busy machine (B-73).
   */
  /**
   * The extension's own id, for a spec that has to read the store it writes to.
   *
   * IndexedDB is per origin, so a fixture page's `indexedDB.open('okolos')` opens an
   * empty database that has never heard of this product. Reading the journal means
   * opening an extension page, and that needs the id.
   */
  extensionId: async ({ context }, use) => {
    const worker = await extensionWorker(context)
    await use(worker.url().split('/')[2] as string)
  },
})

export const expect = test.expect

export async function serve(context: BrowserContext, html: string): Promise<void> {
  await context.route('https://fixture.test/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html }),
  )
}
