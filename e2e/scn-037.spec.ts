import { expect, test } from './hooks.js'
import { serveHosts } from './serve.js'

/**
 * The block page refuses to be somebody else's iframe.
 *
 * `interstitial.html` is the one file this extension makes web-accessible, because the
 * blocker redirects a tab to it — and web-accessible means any page can embed it. A framed
 * copy would be the product's own block page, with its own "continue anyway" control,
 * inside a document an attacker lays out. What that buys is narrow and real: the control
 * records an exception for the last blocked address, so a click stolen by an overlay turns
 * off a block the product had made.
 *
 * The page cannot be made to *name* an arbitrary site — it asks the background rather than
 * reading its own query string, which is a decision that predates this spec. A click is
 * enough on its own.
 *
 * **Since 2026-08-21 there are two defences, and this spec asserts the outer one.**
 * `use_dynamic_url` on the resource means it answers only to a per-session address a page
 * cannot learn, so the embed never loads. The inner defence — the page refusing to draw
 * when it is not the top document — is asserted in `framed.test.ts`, and it is what would
 * still hold if the manifest were ever changed back.
 */

const HOST = `<!doctype html>
<html><head><title>Host</title></head>
<body>
  <h1>An ordinary page</h1>
  <iframe id="framed" width="480" height="320"></iframe>
</body></html>`

test('a page that embeds the block page gets nothing of ours', async ({
  context,
  extensionId,
}) => {
  await serveHosts(context, { 'host.test': HOST })
  const page = await context.newPage()
  await page.goto('https://host.test/')

  // Set from the page, the way an attacker would. The id is fixed and public; what is not
  // reachable is the resource behind it.
  /**
   * The frame's own `load` is the signal that the browser has finished with the navigation,
   * refusal included: measured in Chromium 2026-11-18, a refused extension resource still
   * ends in `load` on the frame. Until then this waited three fixed seconds before asserting
   * absence, which passes early on a loaded machine (B-189). The listener is attached before
   * `src` is set, so a fast refusal cannot slip past it.
   */
  const settled = await page.evaluate(
    (id) =>
      new Promise<string>((resolve) => {
        const frame = document.getElementById('framed') as HTMLIFrameElement
        frame.addEventListener('load', () => resolve('load'), { once: true })
        frame.addEventListener('error', () => resolve('error'), { once: true })
        frame.src = `chrome-extension://${id}/interstitial.html`
      }),
    extensionId,
  )
  expect(settled).toBe('load')

  /**
   * **Two defences, and this asserts the outer one.**
   *
   * `use_dynamic_url` means the resource answers only to a per-session address the
   * extension knows and a page cannot learn, so the browser refuses the load outright:
   * measured, the frame exists and its document is unreachable — `contentDocument` is null
   * and nothing renders. The inner defence, the page refusing to draw when it is not the
   * top document, is asserted in `framed.test.ts` and is what would still hold if this
   * outer one were ever configured away.
   */
  const framed = page.frameLocator('#framed')

  // None of the block page — and the control that matters least of all.
  await expect(framed.locator('[data-role=continue]')).toHaveCount(0)
  await expect(framed.locator('[data-role=back]')).toHaveCount(0)
  // And not our refusal either: nothing of ours ran at all, which is a stronger answer
  // than a sentence. Stated so the difference between the two defences stays legible.
  await expect(framed.locator('#root')).toHaveCount(0)
})

test('still renders as a tab of its own', async ({ context, extensionId }) => {
  // Without this, the refusal above passes just as well against a page that renders
  // nothing at all, anywhere.
  const page = await context.newPage()
  await page.goto(`chrome-extension://${extensionId}/interstitial.html`)

  const refusal = await page.evaluate(() => chrome.i18n.getMessage('blockFramed'))
  expect(refusal.length).toBeGreaterThan(20)
  await expect(page.locator('#root')).not.toContainText(refusal.slice(0, 40))
  // The real page asks the background what was blocked; with nothing blocked it still
  // draws its own shell rather than the refusal.
  await expect(page.locator('#root')).not.toBeEmpty()
})
