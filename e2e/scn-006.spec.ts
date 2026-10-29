import { expect, test } from './hooks.js'
import { expectBanner, expectPageSettled } from './surfaces.js'

/**
 * SCN-006 — an address that imitates a known one is shown next to the name it
 * imitates, before the user interacts with the page.
 *
 * Runs against the test-hook build so the comparison can be opened by a click;
 * the production build keeps the same surface closed to the page.
 */

const PAGE = `<!doctype html><html><body><h1>Sign in</h1></body></html>`

test('a lookalike address is flagged on the page it is about', async ({ context }) => {
  // fixture.test is not a lookalike; g00gle.com is. The fixture origin is
  // whatever the route serves, so the host itself carries the test.
  await context.route('https://g00gle.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: PAGE }),
  )

  const page = await context.newPage()
  await page.goto('https://g00gle.com/signin')

  await expectBanner(page, context)
  await expect(page.locator('okolos-banner [data-role=headline]')).toContainText('only looks like')
})

test('the comparison shows both spellings side by side', async ({ context }) => {
  await context.route('https://g00gle.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: PAGE }),
  )

  const page = await context.newPage()
  await page.goto('https://g00gle.com/signin')
  await expectBanner(page, context)

  await page.locator('okolos-banner [data-role=primary]').click()
  // Inside its own shadow root since 2026-08-20 — Playwright's CSS engine
  // pierces an open one, and the production build keeps it closed to the page.
  const comparison = page.locator('[data-okolos=comparison] [data-role=comparison]')
  await expect(comparison.locator('[data-role=visited]')).toContainText('g00gle.com')
  await expect(comparison.locator('[data-role=resembles]')).toContainText('google.com')
})

test('the genuine article is left alone', async ({ context }) => {
  // The watched name itself, not merely an unrelated site: a warning on the
  // real google.com teaches people to dismiss the next one without reading it,
  // and this is the assertion that protects the feature's value.
  await context.route('https://google.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: PAGE }),
  )

  const page = await context.newPage()
  await page.goto('https://google.com/signin')
  // Until the address check and the scan say they are done, not for a time: a fixed wait
  // ran out first under load and passed on a check that had not run (B-169).
  await expectPageSettled(page)

  await expect(page.locator('okolos-banner')).toHaveCount(0)
})

test('and so is a subdomain of it', async ({ context }) => {
  await context.route('https://accounts.google.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: PAGE }),
  )

  const page = await context.newPage()
  await page.goto('https://accounts.google.com/signin')
  await expectPageSettled(page)

  await expect(page.locator('okolos-banner')).toHaveCount(0)
})
