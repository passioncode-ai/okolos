import { expect, test } from './hooks.js'
import { serveHosts } from './serve.js'
import { SURFACE_MOUNT_MS } from './budgets.js'
import { extensionWorker } from './ready.js'
import { expectJournalLine, expectSettled, SETTLED } from './surfaces.js'

/**
 * A password submitted by a form that **navigates**, and a verdict that survives the
 * navigation it caused.
 *
 * The check runs on submit and after it — deliberately, because interrupting a login
 * somebody was going to finish is worse than saying it afterwards. But a form with an
 * `action` takes the document with it, and the content script waiting for the answer goes
 * with the document: the verdict arrived at nobody, nothing was shown, and nothing was
 * recorded (B-82). It was found from the frame side, where a small frame navigates faster
 * than a full page, so it lost the race more often — `e2e/scn-035.spec.ts` passed alone
 * and failed inside the full suite until its fixture stopped navigating. This is that
 * fixture, kept.
 *
 * The verdict is now held for the tab and pushed to the next document there, which is the
 * more useful place anyway: after a login a person is on the site's own page, and "the
 * password you just sent to this site is in a breach" is as true there as on the form.
 *
 * `password` is submitted on purpose — its digest is in the shipped common list, so the
 * verdict costs no network request.
 */

const LOGIN = `<!doctype html>
<html><head><title>Sign in</title></head>
<body>
  <h1>Sign in</h1>
  <form method="get" action="/welcome">
    <input id="p" name="password" type="password" autocomplete="current-password">
    <button type="submit">Continue</button>
  </form>
</body></html>`

const WELCOME = `<!doctype html>
<html><head><title>Welcome</title></head>
<body><h1>You are signed in</h1></body></html>`

/**
 * Waits until the content script has actually run in this document.
 *
 * Without it a spec can fill and submit before the script exists, and then **nothing**
 * happens: no check, no journal row, no banner. That failure looks exactly like a broken
 * product, and it cost this file two rounds of chasing the wrong thing — worst right after
 * a rebuild, when the first install is slowest.
 *
 * `okolos:collect` is the product's own measure, set at the end of every scan
 * (`content/index.ts`), so its presence means the script loaded, ran, and therefore
 * registered the submit listener.
 */
async function contentScriptReady(page: import('@playwright/test').Page): Promise<void> {
  await expect
    .poll(
      () => page.evaluate(() => performance.getEntriesByName('okolos:collect').length),
      { timeout: SURFACE_MOUNT_MS },
    )
    .toBeGreaterThan(0)
}

/** The panel's variant, once it settles on one. */
async function variantBecomes(page: import('@playwright/test').Page, want: string): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            document
              .querySelector('okolos-banner')
              ?.shadowRoot?.querySelector('[data-role=panel]')
              ?.getAttribute('data-variant') ?? null,
        ),
      { timeout: SURFACE_MOUNT_MS },
    )
    .toBe(want)
}

/**
 * Wakes the service worker before the part being measured.
 *
 * The scenario's precondition is "the extension is running", not "the extension starts
 * now". On a fresh profile the first `password/check` also pays the worker's cold start —
 * opening the database, preparing the feed — and on this machine that occasionally ran past
 * the surface's own deadline: the first test in the file failed roughly one run in six while
 * the three after it passed in a second each, which is the shape B-78 measured. Warming it
 * here states the precondition instead of hiding a known limit inside an assertion.
 */
async function workerAwake(
  context: import('@playwright/test').BrowserContext,
  extensionId: string,
): Promise<void> {
  const warm = await context.newPage()
  await warm.goto(`chrome-extension://${extensionId}/options.html#journal`)
  await warm.locator('[data-role=journal]').waitFor({ timeout: SURFACE_MOUNT_MS })
  await warm.close()
}

async function serve(context: import('@playwright/test').BrowserContext): Promise<void> {
  await serveHosts(context, { 'bank.test': LOGIN })
  // Registered after, so it wins: Playwright matches the most recently added route first.
  await context.route('https://bank.test/welcome**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: WELCOME }),
  )
}

test('the verdict reaches the page the login landed on', async ({ context, extensionId }) => {
  await serve(context)
  await workerAwake(context, extensionId)
  const page = await context.newPage()
  await page.goto('https://bank.test/')
  await contentScriptReady(page)

  await page.locator('input[type=password]').fill('password')
  await page.locator('button[type=submit]').click()

  // The navigation the submission caused really happened — otherwise this spec would be
  // testing the same thing as scn-035 while claiming to test the harder case.
  await expect.poll(() => page.url(), { timeout: SURFACE_MOUNT_MS }).toContain('/welcome')
  await expect(page.locator('h1')).toHaveText('You are signed in')

  await variantBecomes(page, 'password')

  const shown = await page.evaluate(() => {
    const root = document.querySelector('okolos-banner')?.shadowRoot ?? null
    const text = (role: string) => root?.querySelector(`[data-role=${role}]`)?.textContent ?? null
    return { headline: text('headline'), detail: text('detail'), source: text('source') }
  })

  // The sentence names the site the password was sent to, which is what keeps it true on
  // a page that is not the form.
  expect(shown.headline).toContain('bank.test')
  expect(shown.detail?.length ?? 0).toBeGreaterThan(20)
  expect(shown.source).not.toBeNull()
})

/**
 * The other half of what B-82 complained about: a compromised password produced a banner
 * and **nothing else**. So a banner dismissed, or lost to the navigation the submission
 * caused, took the fact with it. The journal row is written before any delivery is
 * attempted, because the fact is true whether or not anybody saw it.
 *
 * Asserted through the surface a person uses, not by reaching into the database: the
 * complaint was that there was nothing to come back to, and the journal screen is where
 * somebody comes back to it.
 */
test('the verdict is recorded, so it survives being missed', async ({
  context,
  extensionId,
}) => {
  await serve(context)
  // This one paid the cold start on its own until 2026-08-20 — the only test in the file
  // without the warm-up, and it failed inside the full suite for that reason alone.
  await workerAwake(context, extensionId)
  const page = await context.newPage()
  await page.goto('https://bank.test/')
  await contentScriptReady(page)
  await page.locator('input[type=password]').fill('password')
  await page.locator('button[type=submit]').click()

  /**
   * Deliberately **not** waiting for the banner first.
   *
   * A first version did, and a plant that removed the delivery reddened this test on the
   * banner — hiding whether the row had been written at all. The row is written before any
   * delivery is attempted, precisely so that it exists when delivery fails, so the
   * assertion must not depend on delivery succeeding.
   */
  const journal = await context.newPage()
  await journal.goto(`chrome-extension://${extensionId}/options.html#journal`)
  const line = await journal.evaluate(() =>
    chrome.i18n.getMessage('journalPasswordCompromised', ['bank.test']),
  )
  expect(line.length, 'the catalogue has no sentence for this row').toBeGreaterThan(10)

  // Reloaded on each attempt — see `expectJournalLine`. This spec is where the class was
  // first found; `budget.spec.ts` is where it was found again, on CI, which is why the
  // polling lives in one place now instead of two.
  await expectJournalLine(journal, line)
})

test('the verdict is not delivered twice', async ({ context, extensionId }) => {
  await serve(context)
  await workerAwake(context, extensionId)
  const page = await context.newPage()
  await page.goto('https://bank.test/')
  await contentScriptReady(page)
  await page.locator('input[type=password]').fill('password')
  await page.locator('button[type=submit]').click()
  await variantBecomes(page, 'password')

  /**
   * Dismiss it, then give the tab another document. The held copy was released by the
   * surface that drew it, so nothing should come back — a verdict that reappears after
   * being read is the shape people learn to click away without reading.
   */
  await page.evaluate(() => {
    document
      .querySelector('okolos-banner')
      ?.shadowRoot?.querySelector<HTMLElement>('[data-role=dismiss]')
      ?.click()
  })
  await expect(page.locator('okolos-banner')).toHaveCount(0)

  await page.goto('https://bank.test/welcome')
  // Until this document's question for a held verdict is answered, not for a time: three
  // seconds ran out first under load and passed on a question not yet asked (B-169).
  await expectSettled(page, SETTLED.pending)
  await expect(page.locator('okolos-banner')).toHaveCount(0)
})

test('a password that is not in a breach leaves the landing page alone', async ({
  context,
  extensionId,
}) => {
  // Without this, the tests above pass just as well against a build that warns on every
  // navigation that followed a password field.
  await serve(context)
  await workerAwake(context, extensionId)
  const page = await context.newPage()
  await page.goto('https://bank.test/')
  await contentScriptReady(page)
  await page.locator('input[type=password]').fill('correct horse battery staple 8f2a')
  await page.locator('button[type=submit]').click()
  await expect.poll(() => page.url(), { timeout: SURFACE_MOUNT_MS }).toContain('/welcome')

  // Two facts, because the check runs after the submission and races the navigation: the
  // worker has judged the password and offered a verdict to the tab, and the landing page
  // has asked for one. After both, a verdict that was going to arrive has arrived (B-169).
  await expectSettled(await extensionWorker(context), SETTLED.password)
  await expectSettled(page, SETTLED.pending)
  await expect(page.locator('okolos-banner')).toHaveCount(0)
})
