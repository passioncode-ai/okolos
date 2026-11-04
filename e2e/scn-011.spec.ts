import { expect, serve, test } from './hooks.js'
import {
  expectBanner,
  expectScriptReady,
  expectSettled,
  expectSurface,
  settledCount,
  SETTLED,
} from './surfaces.js'

/**
 * SCN-011 — a pause before a password on a site this device does not know.
 *
 * The two assertions that matter are opposite: the warning appears on focus,
 * and it never stops the person typing. A guard that blocks a login is a guard
 * that gets turned off.
 */

const LOGIN = `<!doctype html>
<html><body>
  <form action="/login">
    <input id="user" type="text" name="user">
    <input id="pass" type="password" name="password">
    <button type="submit">Sign in</button>
  </form>
</body></html>`

test('focusing the password field explains what is and is not known', async ({ context }) => {
  await serve(context, LOGIN)
  const page = await context.newPage()
  await page.goto('https://fixture.test/login')
  // Listening before the focus, or the focus reaches nobody and is never asked again (B-78).
  await expectScriptReady(page)

  await page.locator('#pass').focus()
  await expectBanner(page, context)

  const detail = page.locator('okolos-banner [data-role=detail]')
  // First ever visit: there is no earlier one to count from, and the warning
  // says that rather than announcing the site is new.
  await expect(detail).toContainText('no earlier visit is recorded')
  // The fact a commercial product would look up, named as not looked up.
  await expect(detail).toContainText('registered')
})

test('the second visit counts from the first, which is what makes the fact real', async ({
  context,
}) => {
  await serve(context, LOGIN)
  const first = await context.newPage()
  await first.goto('https://fixture.test/login')
  await expectScriptReady(first)
  await first.locator('#pass').focus()
  await expectSurface(first, 'okolos-banner', context)

  const second = await context.newPage()
  await second.goto('https://fixture.test/login')
  await expectScriptReady(second)
  await second.locator('#pass').focus()
  await expect(second.locator('okolos-banner [data-role=detail]')).toContainText('first day')
})

test('typing is never blocked', async ({ context }) => {
  await serve(context, LOGIN)
  const page = await context.newPage()
  await page.goto('https://fixture.test/login')

  await page.locator('#pass').fill('correct horse battery staple')
  await expect(page.locator('#pass')).toHaveValue('correct horse battery staple')
})

test('an ordinary text field is not a password field', async ({ context }) => {
  await serve(context, LOGIN)
  const page = await context.newPage()
  await page.goto('https://fixture.test/login')
  await expectScriptReady(page)

  // Until the pause says it judged this focus (a test-hook mark), not for a time: a fixed
  // wait ran out first under load and passed on a judgement not yet made (B-169). Counted
  // from before the focus, so an earlier focus cannot stand in for this one.
  const before = await settledCount(page, SETTLED.focus)
  await page.locator('#user').focus()
  await expectSettled(page, SETTLED.focus, before + 1)
  await expect(page.locator('okolos-banner')).toHaveCount(0)
})
