import { expect, test } from './fixtures.js'
import { RECORD_VISIBLE_MS } from './budgets.js'

/**
 * SCN-015 and SCN-016 — the leak inventory, and the coverage line that gives
 * its number a meaning.
 *
 * No API key is configured in a test profile, which is exactly the interesting
 * case: one source cannot run, and the panel has to say so rather than quietly
 * reporting a smaller number.
 *
 * Every outbound host is stubbed for the whole file, on the context rather than
 * the page — the lookup is made by the service worker, which `page.route` never
 * sees. Before this, two tests reached the real Cavalier API: they were slow,
 * failed roughly one run in four, and sent an invented address to a third party
 * on every green run as well.
 *
 * Stubbing alone did not steady them. Two handlers on the same URL — a
 * file-wide one and a per-test override — leave the answer depending on
 * registration order, and one run in four got the wrong body. There is exactly
 * one route now, and a test that needs a different answer sets the body rather
 * than adding a second handler.
 *
 * The other half of the fix is in the product: every source has a deadline now,
 * so a silent one is reported as unreachable instead of holding the panel open
 * forever.
 *
 * The two tests that wait on a lookup are given their own budget. The suite's
 * default is 30 seconds, and a check that legitimately allows a source 10 to
 * answer does not fit inside it once the context launch is counted — which is
 * why these were steady alone and failed one run in four in the full suite. The
 * assertion timeouts stay modest so a real failure still reports as one.
 */

/**
 * Reads the panel and turns a timeout into a diagnosis.
 *
 * This file has carried an intermittent failure that always looked the same —
 * a fifteen-second wait for an element that never came — and said nothing
 * about which of several causes produced it. The three are now
 * distinguishable from the DOM alone, without logging, which matters because
 * logging inside the product moves the race it is meant to observe:
 *
 * - `needs`   — the check was pressed with no usable address in the field;
 * - `status`  — the check started and the answer never arrived;
 * - `idle` with neither — the press never reached the handler at all.
 */
/**
 * Navigations seen on a page, recorded from the moment it is created.
 *
 * A chrome-extension page reloading mid-test would explain everything the
 * other measurements have ruled out: one field, one panel, a `fill` that
 * reported success, and a value gone by the press. A fresh document means a
 * fresh module, an empty singleton and `address` back at ''.
 */
const navigations = new WeakMap<import('@playwright/test').Page, string[]>()

function watchNavigation(page: import('@playwright/test').Page): void {
  const seen: string[] = []
  navigations.set(page, seen)
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) seen.push(frame.url())
  })
}

async function diagnose(page: import('@playwright/test').Page): Promise<string> {
  const state = await page.evaluate(() => {
    const panel = document.querySelector('[data-role=leaks]')
    const has = (role: string) => panel?.querySelector(`[data-role=${role}]`) !== null
    const fields = [...document.querySelectorAll('[data-role=address]')]
    const field = fields[0]
    return {
      needs: has('needs'),
      checking: has('status'),
      idle: has('idle'),
      ready: has('coverage'),
      address: field instanceof HTMLInputElement ? field.value : '(no field)',
      // More than one means the page module was evaluated twice, and the
      // button the click reached belongs to a different copy than the field
      // the fill bound to. Counted because it is the one remaining explanation
      // for a stable node holding nothing after a fill that reported success.
      fieldCount: fields.length,
      panels: document.querySelectorAll('[data-role=leaks]').length,
    }
  })
  const navs = navigations.get(page) ?? []
  const where =
    `field held "${state.address}", ${state.fieldCount} field(s), ${state.panels} panel(s), ` +
    `${navs.length} navigation(s)${navs.length > 1 ? ': ' + navs.join(' -> ') : ''}`
  if (state.needs) return `the check was refused for want of an address (${where})`
  if (state.checking) return `the check started and never answered (${where})`
  if (state.ready) return 'the check finished but the expected group is absent — a product bug, not a race'
  if (state.idle) return `the panel never left idle: the press did not reach the handler (${where})`
  return `the leaks panel is not on the page at all (${where})`
}

/** Awaits an assertion and, if it times out, says what the page was doing. */
async function expectWithDiagnosis(
  page: import('@playwright/test').Page,
  assertion: Promise<void>,
): Promise<void> {
  try {
    await assertion
  } catch (cause) {
    const why = await diagnose(page)
    throw new Error(`${String(cause).split('\n')[0]}\n\nDiagnosis: ${why}`)
  }
}

/**
 * Types an address and reads it straight back.
 *
 * The read-back is the point. An intermittent failure in this file ends with
 * the field empty at the press, and everything that could explain it has been
 * ruled out one at a time: not a repaint (an 800 ms delay forcing that race
 * did not reproduce it), not a second copy of the page module (one field, one
 * panel), not a reload (one navigation). What remains is whether the value was
 * ever there — so every test asks, one statement after `fill`, and the failure
 * lands where the value was lost rather than fifteen seconds later.
 */
async function fillAddress(page: import('@playwright/test').Page, value: string): Promise<void> {
  const field = page.locator('[data-role=address]')

  // The stamp that used to stand here is gone, and its removal is the proof.
  //
  // It was a round trip to the page before typing, and it made the failure
  // vanish — as logging had, and a delay before it. Three instruments, three
  // disappearances, and the note here said the green was not evidence.
  //
  // It was not. Every one of them was adding time for the page's own repaint
  // to finish before the typing started. Removing the stamp brought the
  // failure back within one run, which is what finally named it: repainting
  // moves the field, moving it blurs it, and native typing needs somewhere
  // focused to land. `apps/extension/src/options/keep-focus.ts` carries the
  // rule and the reasoning.
  await field.fill(value)

  const after = await page.evaluate(() => {
    const el = document.querySelector('[data-role=address]')
    return {
      value: el instanceof HTMLInputElement ? el.value : '(not an input)',
      // No longer a swap check: the node was never swapped. Kept so the
      // failure message below stays honest about which of the two it was.
      sameNode: true,
    }
  })
  expect(
    after,
    after.sameNode
      ? 'the value left the very node it was typed into — #29'
      : 'the node was swapped for another after the fill — #29',
  ).toEqual({ value, sameNode: true })
}

/** The body the single Cavalier stub returns. A test that needs another sets it. */
let cavalierBody = '{"stealers":[]}'
/**
 * The single Have I Been Pwned stub, set the same way. 401 by default: with no key saved
 * the source is never asked, and a test that saves one decides what it answers.
 */
let hibpStatus = 401
let hibpBody = '{}'
/** The `hibp-api-key` header of every request the stub saw, in order. */
let hibpKeys: string[] = []
test.beforeEach(async ({ context }) => {
  cavalierBody = '{"stealers":[]}'
  hibpStatus = 401
  hibpBody = '{}'
  hibpKeys = []
  await context.route('https://cavalier.hudsonrock.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: cavalierBody }),
  )
  await context.route('https://haveibeenpwned.com/**', (route) => {
    hibpKeys.push(route.request().headers()['hibp-api-key'] ?? '')
    return route.fulfill({ status: hibpStatus, contentType: 'application/json', body: hibpBody })
  })
})

/** Obviously fake: no real credential belongs in a repository, a test one included. */
const FAKE_KEY = 'fake-hibp-key-for-e2e-00000000'

test('the panel says what will be sent before anything is', async ({ context, extensionId }) => {
  const page = await context.newPage()
  watchNavigation(page)
  await page.goto(`chrome-extension://${extensionId}/options.html#leaks`)

  // The second test that held the false claim steady. It asserted the word
  // "hashed" about a check that sends the address itself, and the unit test
  // one layer down asserted the same. Two tests agreeing on a lie read exactly
  // like two tests agreeing on a truth.
  const idle = page.locator('[data-role=leaks] [data-role=idle]')
  await expect(idle).toContainText('sends your address')
  await expect(idle).not.toContainText('hashed form')
  await expect(idle, 'the password check is separate and is the hashed one').toContainText(
    'partial hash',
  )
  await expect(page.locator('[data-role=leaks] [data-role=total]')).toHaveCount(0)
})

test('a source that cannot run is named, and the total says it may be incomplete', async ({
  context,
  extensionId,
}) => {
  test.slow()
  const page = await context.newPage()
  watchNavigation(page)
  await page.goto(`chrome-extension://${extensionId}/options.html#leaks`)

  await fillAddress(page, 'someone@example.test')
  await page.locator('[data-role=leaks] [data-role=check]').click()

  const coverage = page.locator('[data-role=leaks] [data-role=coverage]')
  await expectWithDiagnosis(
    page,
    expect(coverage).toContainText('Have I Been Pwned', { timeout: RECORD_VISIBLE_MS }),
  )
  await expect(coverage).toContainText('may be incomplete')

  // B-125: the default state of every install. The source was not asked, the screen says
  // so in those words, and the line that says it is the way to the field.
  await expect(coverage).toContainText('Not checked against Have I Been Pwned')
  await expect(page.locator('[data-role=leaks] [data-role=source-key]')).toContainText(
    'Have I Been Pwned was not checked: no key is saved.',
  )
  const addKey = page.locator('[data-role=leaks] [data-role=add-key]')
  await expect(addKey).toHaveText('Add key')
  expect(hibpKeys, 'with no key saved the source must not be asked at all').toEqual([])

  await addKey.click()
  await expect(page.locator('[data-role=leak-key] [data-role=leak-key-state]')).toHaveText(
    'No key is saved, so Have I Been Pwned is not checked.',
  )
})

test('a saved key is asked with, sent only in its header, never shown back, and removable', async ({
  context,
  extensionId,
}) => {
  test.slow()
  hibpStatus = 200
  hibpBody = JSON.stringify([
    { Name: 'ExampleBreach', Domain: 'example.test', BreachDate: '2023-04-05', DataClasses: ['Passwords'] },
  ])

  const page = await context.newPage()
  watchNavigation(page)
  await page.goto(`chrome-extension://${extensionId}/options.html#data`)

  const block = page.locator('[data-role=leak-key]')
  const field = block.locator('[data-role=leak-key-field]')
  await expect(field).toHaveAttribute('type', 'password')
  await field.fill(FAKE_KEY)
  await block.locator('[data-role=leak-key-save]').click()

  await expect(block.locator('[data-role=leak-key-state]')).toHaveText(
    'A key is saved on this device and is not shown here. To change it, paste a new one.',
  )
  await expect(block.locator('[data-role=leak-key-save]')).toHaveText('Replace key')
  await expect(field).toHaveValue('')
  expect(await page.content(), 'the key is back on the page after saving').not.toContain(FAKE_KEY)

  await page.goto(`chrome-extension://${extensionId}/options.html#leaks`)
  // Before anything is sent, both recipients are named, and the key is said to go along.
  const idle = page.locator('[data-role=leaks] [data-role=idle]')
  await expect(idle).toContainText('Hudson Rock Cavalier and Have I Been Pwned')
  await expect(idle).toContainText('your key goes to Have I Been Pwned in the request header')
  await fillAddress(page, 'someone@example.test')
  await page.locator('[data-role=leaks] [data-role=check]').click()

  const coverage = page.locator('[data-role=leaks] [data-role=coverage]')
  await expectWithDiagnosis(
    page,
    expect(coverage).toContainText('Have I Been Pwned', { timeout: RECORD_VISIBLE_MS }),
  )
  // Both sources answered, so the line claims both and admits no gap.
  await expect(coverage).toHaveText(/^Checked against .*Hudson Rock Cavalier/)
  await expect(coverage).not.toContainText('Not checked')
  await expect(page.locator('[data-role=leaks] [data-role=leak][data-leak=ExampleBreach]')).toHaveCount(1)
  // CC BY 4.0 asks for the credit wherever the data appears, and here it does.
  const attribution = page.locator('[data-role=leaks] [data-role=attribution]')
  await expect(attribution).toContainText('Have I Been Pwned')
  await expect(attribution).toContainText('CC BY 4.0')
  await expect(page.locator('[data-role=leaks] [data-role=source-key]')).toHaveCount(0)
  expect(hibpKeys, 'the key travels in the header the API asks for').toEqual([FAKE_KEY])

  // The outbound log names the request and keeps the key out of every field it shows.
  await page.goto(`chrome-extension://${extensionId}/options.html#audit`)
  await expect(page.locator('body')).toContainText('haveibeenpwned.com')
  // Its "what left" line says the key left, by the header's name and never its value.
  await expect(page.locator('[data-role=entry-payload]').filter({ hasText: 'header:hibp-api-key' })).toHaveCount(1)
  expect(await page.content()).not.toContain(FAKE_KEY)

  await page.goto(`chrome-extension://${extensionId}/options.html#data`)
  await page.locator('[data-role=leak-key] [data-role=leak-key-remove]').click()
  await expect(page.locator('[data-role=leak-key] [data-role=leak-key-state]')).toHaveText(
    'No key is saved, so Have I Been Pwned is not checked.',
  )
  await expect(page.locator('[data-role=leak-key] [data-role=leak-key-remove]')).toHaveCount(0)
})

test('a key the source refuses is named as refused, with the way to replace it', async ({
  context,
  extensionId,
}) => {
  test.slow()
  hibpStatus = 401

  const page = await context.newPage()
  watchNavigation(page)
  await page.goto(`chrome-extension://${extensionId}/options.html#data`)
  await page.locator('[data-role=leak-key] [data-role=leak-key-field]').fill(FAKE_KEY)
  await page.locator('[data-role=leak-key] [data-role=leak-key-save]').click()
  await expect(page.locator('[data-role=leak-key] [data-role=leak-key-remove]')).toBeVisible()

  await page.goto(`chrome-extension://${extensionId}/options.html#leaks`)
  await fillAddress(page, 'someone@example.test')
  await page.locator('[data-role=leaks] [data-role=check]').click()

  const line = page.locator('[data-role=leaks] [data-role=source-key]')
  await expectWithDiagnosis(
    page,
    expect(line).toContainText('Have I Been Pwned refused the saved key.', { timeout: RECORD_VISIBLE_MS }),
  )
  await expect(line.locator('[data-role=add-key]')).toHaveText('Replace key')
  expect(await page.content()).not.toContain(FAKE_KEY)
})

test('with no key saved, the screen names only the source it will ask, and credits nobody', async ({
  context,
  extensionId,
}) => {
  test.slow()
  // B-125 round 2. The idle sentence said "the sources named below", and the only one below
  // was the credit line naming Have I Been Pwned: the source that is not asked without a key.
  const page = await context.newPage()
  watchNavigation(page)
  await page.goto(`chrome-extension://${extensionId}/options.html#leaks`)

  const idle = page.locator('[data-role=leaks] [data-role=idle]')
  await expect(idle).toContainText('sends your address to Hudson Rock Cavalier')
  await expect(idle).toContainText('Have I Been Pwned is not asked until you save a key')
  const attribution = page.locator('[data-role=leaks] [data-role=attribution]')
  await expect(attribution).toHaveCount(0)

  await fillAddress(page, 'someone@example.test')
  await page.locator('[data-role=leaks] [data-role=check]').click()
  await expectWithDiagnosis(
    page,
    expect(page.locator('[data-role=leaks] [data-role=coverage]')).toBeVisible({
      timeout: RECORD_VISIBLE_MS,
    }),
  )
  // Have I Been Pwned gave nothing to this screen, so it is not credited on it.
  await expect(attribution).toHaveCount(0)
})

test('a recent infection is separated from an old breach, and each carries its repair', async ({
  context,
  extensionId,
}) => {
  test.slow()
  // The two piles need different responses: cookies survive a password change.
  // A single date-sorted list makes the infection look like a newer breach.
  // Sets the single stub's body rather than adding a second handler on the same
  // URL — that was the race.
  cavalierBody = JSON.stringify({ stealers: [{ date_compromised: new Date().toISOString() }] })

  const page = await context.newPage()
  watchNavigation(page)
  await page.goto(`chrome-extension://${extensionId}/options.html#leaks`)

  await fillAddress(page, 'someone@example.test')
  await page.locator('[data-role=leaks] [data-role=check]').click()

  const fresh = page.locator('[data-role=leak-group][data-urgency=fresh-infostealer]')
  await expectWithDiagnosis(page, expect(fresh).toHaveCount(1, { timeout: RECORD_VISIBLE_MS }))
  await expect(fresh.locator('[data-role=group-why]')).toContainText('session cookies')

  // Cavalier names no site, so the panel says so instead of guessing a login page.
  await expect(fresh.locator('[data-role=no-domain]')).toContainText('nowhere to send you')
  await expect(fresh.locator('[data-role=resolve]')).toHaveText('Mark resolved')
})

test('the address field survives a repaint instead of being rebuilt', async ({
  context,
  extensionId,
}) => {
  // The regression behind three days of flake. This page repaints wholesale,
  // and each repaint awaits several database reads, so it takes real time
  // while the page is live. Rebuilding the input threw away whatever was typed
  // during that window — value, caret, focus, and any IME composition — and
  // the check clicked afterwards read an empty address and returned in
  // silence.
  //
  // Asserted on node identity rather than on the value, because a rebuilt
  // field that happens to be repopulated from the right variable would pass a
  // value check while still dropping focus and the caret.
  const page = await context.newPage()
  watchNavigation(page)
  await page.goto(`chrome-extension://${extensionId}/options.html#leaks`)

  const field = page.locator('[data-role=address]')
  await expect(field).toHaveCount(1)
  await page.evaluate(() => {
    document.querySelector('[data-role=address]')?.setAttribute('data-identity', 'original')
  })

  await field.fill('someone@example.test')
  await expect(field, 'the typed address did not survive the fill itself — #29').toHaveValue(
    'someone@example.test',
  )

  // The check itself is the repaint now. It used to be the journal's history
  // toggle — a full reload with no network in it — but the journal is a
  // different area since the page started rendering one at a time, and a
  // trigger that is not on this screen is not a trigger. The sources are
  // stubbed at the top of this file, so idle → checking → ready is two paints
  // and no real request.
  await page.locator('[data-role=leaks] [data-role=check]').click()
  await expect(page.locator('[data-role=leaks] [data-role=coverage]')).toBeVisible({
    timeout: RECORD_VISIBLE_MS,
  })

  await expect(page.locator('[data-role=address][data-identity=original]')).toHaveCount(1)
  await expect(field).toHaveValue('someone@example.test')

})

test('pressing Check now with nothing typed says so, instead of nothing', async ({
  context,
  extensionId,
}) => {
  // Two things at once. It is the behaviour a user meets when they press the
  // button too early — and it is the reason the flake in this file cost three
  // days: a check that could not run left the page identical to how it
  // started, so every failure looked like the starting state and said nothing
  // about which of a dozen causes it was.
  const page = await context.newPage()
  watchNavigation(page)
  await page.goto(`chrome-extension://${extensionId}/options.html#leaks`)

  await page.locator('[data-role=leaks] [data-role=check]').click()

  await expect(page.locator('[data-role=leaks] [data-role=needs]')).toContainText(
    'Enter the email address',
  )
  // And the refusal is recoverable: the control is still there.
  await expect(page.locator('[data-role=leaks] [data-role=check]')).toBeVisible()
})

test('an address that is not one is refused by name', async ({ context, extensionId }) => {
  const page = await context.newPage()
  watchNavigation(page)
  await page.goto(`chrome-extension://${extensionId}/options.html#leaks`)

  await fillAddress(page, 'not-an-address')

  // Read back before pressing anything. This test doubles as the sharpest
  // detector this file has for the intermittent failure: the two refusals say
  // different things, so getting the empty-field wording after a successful
  // fill is unambiguous, arrives in five seconds rather than fifteen, and says
  // exactly where the value went.
  const beforeClick = await page.evaluate(() => {
    const fields = [...document.querySelectorAll('[data-role=address]')]
    return {
      count: fields.length,
      values: fields.map((f) => (f instanceof HTMLInputElement ? f.value : '(not an input)')),
      panels: document.querySelectorAll('[data-role=leaks]').length,
    }
  })
  expect(
    beforeClick,
    'the typed address did not survive to the press — this is the race tracked as #29',
  ).toEqual({ count: 1, values: ['not-an-address'], panels: 1 })

  await page.locator('[data-role=leaks] [data-role=check]').click()

  await expect(page.locator('[data-role=leaks] [data-role=needs]')).toContainText(
    'does not look like an email address',
  )
})
