import { expect, test } from './hooks.js'
import { serveCleanRange, serveHosts } from './serve.js'
import { SURFACE_MOUNT_MS } from './budgets.js'
import { extensionWorker } from './ready.js'
import { expectScriptReady, expectSettled, frameAt, SETTLED } from './surfaces.js'

/**
 * A password submitted from a form inside an embedded frame is checked, and the verdict
 * reaches the page a person is looking at — with a button that does what it says.
 *
 * Two defects met here, and both were invisible in the same way. The check stood under
 * `if (isTopFrame)`, so a password sent from an iframe was never compared against a
 * breach and never counted towards reuse (B-80) — the ordinary shape of a login, not the
 * exotic one. And the banner it would have drawn had four handlers that all returned
 * `undefined`, so "Сменить пароль" was a label with nothing behind it: a content script
 * cannot open a tab, `chrome.tabs` is not in its API surface, and the failure was silent
 * because nothing ever asked.
 *
 * `password` is submitted on purpose: its digest is in the shipped common list
 * (`background/password.ts:COMMON_SHA1`), so the verdict is `compromised` with no network
 * request at all — the answer this suite can rely on.
 *
 * The frame's host is not a lookalike, so the only reason a banner can name it is the
 * verdict. The pause before the password fires first and claims the panel at `minor`;
 * the leak verdict is `major` and takes it, which is the slot rule doing its job and is
 * asserted rather than waited out.
 */

const PARENT = `<!doctype html>
<html><head><title>Parent</title></head>
<body>
  <h1>Sign in to continue</h1>
  <iframe src="https://sso.partner.test/" width="320" height="240"></iframe>
</body></html>`

/**
 * The form does not navigate, and that is a statement about what this spec can prove.
 *
 * A form with an `action` navigates the frame on submit, and the navigation tears down the
 * frame's content script while `password/check` is still in flight — so the verdict is
 * lost whenever the navigation wins the race. Measured here: the spec passed alone and
 * failed twice inside the full suite, once with no banner at all. That race is real, it
 * predates this change, it affects the page's own form exactly the same way, and it is
 * filed as B-82 — it is not something a fixture should hide **or** be flaky about.
 *
 * `preventDefault` is also the common modern shape: a login form that posts with `fetch`
 * and stays on the page. The product's listener is capture-phase on `document`, so it sees
 * the submit before the page's own handler either way.
 */
const LOGIN_FRAME = `<!doctype html>
<html><head><title>Sign in</title></head>
<body>
  <form id="f">
    <input id="p" name="password" type="password" autocomplete="current-password">
    <button type="submit">Continue</button>
  </form>
  <script>
    document.getElementById('f').addEventListener('submit', (e) => e.preventDefault())
  </script>
</body></html>`

/**
 * Waits until the content script has run **inside the frame**.
 *
 * Without it a spec can submit before the frame's script exists, and then nothing happens
 * at all — a failure that reads exactly like a broken product (the lesson of scn-036).
 *
 * It looked for a frame whose address contains `g00gle`, and this file's frame is
 * `sso.partner.test`, so it fell back to the top document and waited on the wrong script:
 * the submit could still beat the frame's listener. Seen 2026-10-29, one run in ten under
 * four workers: no banner for 35 s (B-78). The frame is now named by the host it is served
 * from.
 */
async function frameScriptReady(page: import('@playwright/test').Page): Promise<void> {
  await expectScriptReady(await frameAt(page, 'https://sso.partner.test'))
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
 * Fills the field **without focusing it**, then submits.
 *
 * Not squeamishness: focusing raises the pause before the password, which is a second
 * finding travelling the same relay, and the panel then has to swap from it to the leak
 * verdict. That put two round trips through the service worker in a test about one, and
 * this spec failed in a full local run with the panel still showing `credential` after 35
 * seconds — on the worker wake-up spread B-78 measured (8.8 s, 10.1 s, 22.3 s for the same
 * three tests, 56 s for a failing run), not on anything this scenario is about.
 *
 * A scripted value is also a real case: a password manager fills a field it never focused.
 * The event under test is the submit, and that is what stays real here. The pause's own
 * relay is proved by scn-034, and their interaction on one panel by the slot's unit tests.
 */
async function submitPassword(page: import('@playwright/test').Page): Promise<void> {
  await frameScriptReady(page)
  const frame = page.frameLocator('iframe')
  await frame.locator('input[type=password]').evaluate((el) => {
    ;(el as HTMLInputElement).value = 'password'
  })
  await frame.locator('button[type=submit]').click()
}

test('checks a password submitted from a frame and says so on the embedding page', async ({
  context,
}) => {
  await serveHosts(context, { 'parent.test': PARENT, 'sso.partner.test': LOGIN_FRAME })
  const page = await context.newPage()
  await page.goto('https://parent.test/')
  await submitPassword(page)

  await variantBecomes(page, 'password')

  const shown = await page.evaluate(() => {
    const root = document.querySelector('okolos-banner')?.shadowRoot ?? null
    const text = (role: string) => root?.querySelector(`[data-role=${role}]`)?.textContent ?? null
    return {
      headline: text('headline'),
      detail: text('detail'),
      source: text('source'),
      primary: root?.querySelector('[data-role=primary]')?.textContent ?? null,
    }
  })

  // The headline names the frame's site, from the origin the background stamped.
  expect(shown.headline).toContain('sso.partner.test')
  // Both facts, not one: the breach and where else the password is used.
  expect(shown.detail).not.toBeNull()
  expect(shown.detail?.length ?? 0).toBeGreaterThan(20)
  // Every claim names its source, and this verdict cost no request.
  expect(shown.source).not.toBeNull()
  // The control that was a label with nothing behind it.
  expect(shown.primary).not.toBe('')
})

test('the change-password button opens the frame site’s own page', async ({ context }) => {
  await serveHosts(context, { 'parent.test': PARENT, 'sso.partner.test': LOGIN_FRAME })

  /**
   * The address is asserted on the **request**, not on the opened tab's `url()`.
   *
   * A first version read the tab and got `chrome-error://chromewebdata/`: whether a tab
   * the extension opened finishes loading under interception is a fact about this
   * harness, and it would have been read as the button opening the wrong page. What the
   * row is about is which address the product asks for, and that is exactly what a route
   * sees. Registered after `serveHosts` because Playwright matches the most recently
   * added route first.
   */
  const asked: string[] = []
  await context.route('https://sso.partner.test/.well-known/change-password', (route) => {
    asked.push(route.request().url())
    return route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: '<!doctype html><title>Change your password</title>',
    })
  })

  const page = await context.newPage()
  await page.goto('https://parent.test/')
  await submitPassword(page)
  await variantBecomes(page, 'password')

  // A content script cannot open a tab at all — `chrome.tabs` is not in its API surface
  // — so this passing means the request reached the background and the background
  // composed the address from the origin it had stamped itself.
  await page.evaluate(() => {
    const primary = document
      .querySelector('okolos-banner')
      ?.shadowRoot?.querySelector<HTMLElement>('[data-role=primary]')
    primary?.click()
  })

  await expect.poll(() => asked, { timeout: SURFACE_MOUNT_MS }).toEqual([
    'https://sso.partner.test/.well-known/change-password',
  ])
})

test('stays silent when the password submitted from the frame is not in a breach', async ({
  context,
}) => {
  // Without this, the tests above pass just as well against a build that warns about
  // every password submitted anywhere.
  await serveHosts(context, { 'parent.test': PARENT, 'sso.partner.test': LOGIN_FRAME })
  await serveCleanRange(context)
  const page = await context.newPage()
  await page.goto('https://parent.test/')
  await frameScriptReady(page)
  const frame = page.frameLocator('iframe')
  // Not in the common list, and the range query cannot be reached from here — so the
  // verdict is "not compromised" and no leak banner may appear. Filled without focus for
  // the reason `submitPassword` gives.
  await frame.locator('input[type=password]').evaluate((el) => {
    ;(el as HTMLInputElement).value = 'correct horse battery staple 8f2a'
  })
  await frame.locator('button[type=submit]').click()

  // Until the worker says it judged the password and offered whatever it found to the tab,
  // not for a time: three seconds ran out first under load (B-169).
  await expectSettled(await extensionWorker(context), SETTLED.password)
  // And until the frame that asked has handled the answer, relay to this page included:
  // the worker's measure is written before the frame acts on what it returned.
  await expectSettled(await frameAt(page, 'https://sso.partner.test'), SETTLED.passwordHandled)
  const variant = await page.evaluate(
    () =>
      document
        .querySelector('okolos-banner')
        ?.shadowRoot?.querySelector('[data-role=panel]')
        ?.getAttribute('data-variant') ?? null,
  )
  // Nothing at all is the expected answer here: the field was never focused, so the pause
  // did not fire either, and the password is not in a breach.
  expect(variant).toBeNull()
})
