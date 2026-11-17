import { expect, test } from './fixtures.js'

/**
 * B-209 — a build with no App-Key, which is every build but the store's, says it sends nothing.
 *
 * Run against the production-shaped build (`dist/chrome`): it used to show the notice "Okolos sends
 * us usage and error data" and a switch that was on, while it sent nothing at all.
 */

test('the first run shows no notice, and settings say this build sends nothing', async ({ context, extensionId }) => {
  const first = await context.newPage()
  await first.goto(`chrome-extension://${extensionId}/first-run.html`)
  await expect(first.locator('[data-role=checks]')).toBeVisible()
  await expect(first.locator('[data-role=usage-notice]')).toHaveCount(0)

  const settings = await context.newPage()
  await settings.goto(`chrome-extension://${extensionId}/options.html#data`)
  const box = settings.locator('[data-role=usage-switch]')
  await expect(box).not.toBeChecked()
  await expect(box).toBeDisabled()
  await expect(settings.locator('[data-role=usage-state]')).toContainText('is not from a store and sends no usage and error data')
})
