import { expect, test } from './hooks.js'
import { serveHosts } from './serve.js'
import { expectPageSettled, expectScriptReady, expectSurface, frameAt } from './surfaces.js'

/**
 * A login form inside an embedded frame is checked, and its finding reaches the page a
 * person is actually looking at.
 *
 * For two releases nothing watched it. `watchCredentialFields` stood under
 * `if (isTopFrame)`, and the comment above it claimed a subframe's form "is warned about
 * by the frame it is in" — which that condition prevented: the content script runs in
 * every frame, and in a subframe `isTopFrame` is false, so the block was skipped there
 * too. An OAuth or payment form in an iframe, which is the ordinary shape rather than
 * the exotic one, was watched by nobody (B-79).
 *
 * The half of the restriction that was right is kept: a frame does not draw. A banner
 * inside a 300×200 frame is clipped, and inside a hidden ad frame it warns nobody. So the
 * frame reports and the top frame draws — the same arrangement SCN-031 proved for
 * injections, over a relay that now carries a kind so the facts survive the trip.
 *
 * `g00gle.com` serves the form on purpose: it is the lookalike fixture, so the guard has
 * a real fact to state rather than only "we do not know". The parent is deliberately
 * clean and is not a lookalike, so nothing else on this page can raise a banner — a
 * warning that appears here came through the relay or not at all.
 */

const PARENT = `<!doctype html>
<html><head><title>Parent</title></head>
<body>
  <h1>Sign in to continue</h1>
  <p>Nothing hidden here at all.</p>
  <iframe src="https://g00gle.com/" width="300" height="200"></iframe>
</body></html>`

const LOGIN_FRAME = `<!doctype html>
<html><head><title>Sign in</title></head>
<body>
  <form method="post" action="/session">
    <label for="p">Password</label>
    <input id="p" name="password" type="password" autocomplete="current-password">
    <button type="submit">Continue</button>
  </form>
</body></html>`

const NO_FORM = `<!doctype html>
<html><head><title>Framed</title></head>
<body><p>An advert.</p></body></html>`

test('warns about a login form inside a frame, on the page that embeds it', async ({ context }) => {
  await serveHosts(context, { 'parent.test': PARENT, 'g00gle.com': LOGIN_FRAME })
  const page = await context.newPage()
  await page.goto('https://parent.test/')
  // The frame's script listens before the click, or the click reaches nobody (B-78).
  await expectScriptReady(await frameAt(page, 'https://g00gle.com'))

  /**
   * A click rather than `.focus()`, and the difference is not style. The pause is bound
   * to `focusin`, and `focus()` on an element inside a cross-origin frame does not raise
   * it in headless Chromium — the first version of this spec failed for that reason and
   * would have been read as the feature not working. A click is what a person does
   * anyway.
   */
  await page.frameLocator('iframe').locator('input[type=password]').click()

  await expectSurface(page, 'okolos-banner', context)

  const shown = await page.evaluate(() => {
    const host = document.querySelector('okolos-banner')
    const root = host?.shadowRoot ?? null
    const text = (role: string) => root?.querySelector(`[data-role=${role}]`)?.textContent ?? null
    return {
      variant: root?.querySelector('[data-role=panel]')?.getAttribute('data-variant') ?? null,
      headline: text('headline'),
      detail: text('detail'),
      source: text('source'),
    }
  })

  // It is the password warning, not some other surface that happened to mount.
  expect(shown.variant).toBe('credential')

  /**
   * The headline names the frame's site, and that is the assertion the security of this
   * whole path rests on: the origin is stamped by the background from the sender, never
   * taken from a field the frame filled in. A frame that could name itself could name
   * somebody else.
   */
  expect(shown.headline).toContain('g00gle.com')

  /**
   * And the facts arrived, not a summary of them. The relay was built for injections and
   * carried `{origin, summary, count}`; a password warning pushed through a summary
   * string loses exactly the part a person acts on. The lookalike fact is the one this
   * fixture guarantees.
   */
  expect(shown.detail).toContain('google.com')
  expect(shown.source).not.toBeNull()
})

test('does not mount a banner inside the frame with the form', async ({ context }) => {
  await serveHosts(context, { 'parent.test': PARENT, 'g00gle.com': LOGIN_FRAME })
  const page = await context.newPage()
  await page.goto('https://parent.test/')
  await expectScriptReady(await frameAt(page, 'https://g00gle.com'))
  await page.frameLocator('iframe').locator('input[type=password]').click()
  await expectSurface(page, 'okolos-banner', context)

  // Asserted after the top banner exists, so it cannot pass by the whole check having
  // failed. A frame that both draws and reports shows the warning twice.
  await expect(page.frameLocator('iframe').locator('okolos-banner')).toHaveCount(0)
})

test('stays silent when the embedded frame asks for no password', async ({ context }) => {
  // Without this, the tests above pass just as well against a build that warns about
  // every page containing an iframe.
  await serveHosts(context, { 'parent.test': PARENT, 'g00gle.com': NO_FORM })
  const page = await context.newPage()
  await page.goto('https://parent.test/')

  // Until both documents have scanned and the address is checked, not for a time (B-169).
  await expectPageSettled(page)
  await expect(page.locator('okolos-banner')).toHaveCount(0)
})
