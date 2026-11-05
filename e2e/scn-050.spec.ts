import { expect, test } from './fixtures.js'

/**
 * SCN-050 and SCN-051 — usage and error data (B-199), in Chromium, on the built extension.
 *
 * The test build carries no App-Key, so nothing is sent from here; what is checked is what a
 * person sees and does: the notice on the first run, its way to the switch, and the switch
 * turning collection off and on again, each answered by the worker and repainted from it.
 */

test('the first run says what is sent, and the notice leads to the switch', async ({ context, extensionId }) => {
  const page = await context.newPage()
  await page.goto(`chrome-extension://${extensionId}/first-run.html`)

  await expect(page.locator('[data-role=usage-notice]')).toContainText('Okolos sends us data on how the product runs')
  const opened = context.waitForEvent('page')
  await page.locator('[data-role=usage-off]').click()
  const settings = await opened
  await settings.waitForLoadState()
  expect(settings.url()).toContain('options.html#data')
  await expect(settings.locator('[data-role=usage-switch]')).toBeChecked()
})

test('the switch turns it off, and on again', async ({ context, extensionId }) => {
  const page = await context.newPage()
  await page.goto(`chrome-extension://${extensionId}/options.html#data`)
  const box = page.locator('[data-role=usage-switch]')
  await expect(box).toBeChecked()

  await box.uncheck()
  await expect(page.locator('[data-role=usage-state]')).toHaveText('Off: nothing is sent, and the install number is deleted.')
  await expect(page.locator('[data-role=usage-switch]')).not.toBeChecked()

  await page.locator('[data-role=usage-switch]').check()
  await expect(page.locator('[data-role=usage-state]')).toHaveCount(0)
  await expect(page.locator('[data-role=usage-switch]')).toBeChecked()

  // The first run no longer says it sends anything once it is off.
  await page.locator('[data-role=usage-switch]').uncheck()
  await expect(page.locator('[data-role=usage-state]')).toHaveCount(1)
  const first = await context.newPage()
  await first.goto(`chrome-extension://${extensionId}/first-run.html`)
  await expect(first.locator('[data-role=checks]')).toBeVisible()
  await expect(first.locator('[data-role=usage-notice]')).toHaveCount(0)
})

test('"Delete all data" takes the install number too: collection stays on, under a new one', async ({ context, extensionId }) => {
  const page = await context.newPage()
  await page.goto(`chrome-extension://${extensionId}/options.html#data`)
  // Off and on again gives this profile an install number to delete.
  await page.locator('[data-role=usage-switch]').uncheck()
  await expect(page.locator('[data-role=usage-state]')).toHaveCount(1)
  await page.locator('[data-role=usage-switch]').check()
  await expect(page.locator('[data-role=usage-state]')).toHaveCount(0)
  const stored = () =>
    page.evaluate(async () => {
      const got = await chrome.storage.local.get('usage:state')
      return got['usage:state'] as { consent: string; iid: string | null; queue: unknown[] }
    })
  const before = await stored()
  expect(before.iid).toBeTruthy()

  await page.locator('[data-role=wipe]').click()
  await page.locator('[data-role=confirm-yes]').click()
  await expect.poll(async () => (await stored()).iid).not.toBe(before.iid)
  const after = await stored()
  expect(after).toMatchObject({ consent: 'on', queue: [] })
  expect(after.iid).toBeTruthy()
  await expect(page.locator('[data-role=usage-switch]')).toBeChecked()
})
