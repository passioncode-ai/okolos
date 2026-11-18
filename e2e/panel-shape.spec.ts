import { expect, test } from './fixtures.js'
import { expectJournalRows } from './surfaces.js'

/**
 * Every screen of this extension is one panel, shaped the same way.
 *
 * Four defects found on 2026-08-21 by rendering all nine areas and looking at them, all
 * from the same cause: the visual layer was an allow-list of `data-role`s and membership
 * was hand-work.
 *
 *  - the recovery *chooser* had no card at all — heading flush against the page, browser
 *    bullets beside its buttons — because its role had never been added to the list;
 *  - five areas returned a role-less `div` holding exactly one child, and the router
 *    focuses what it mounts, so the focus ring framed the wrapper and read on screen as a
 *    second card offset from the first;
 *  - the settings area was the only `h2` of the nine, a size smaller than its neighbours
 *    and leaving that screen with no first-level heading;
 *  - list markers were suppressed one role at a time, one of them only by accident (a flex
 *    `li` has no marker box), and the indent was left behind where the marker was gone.
 *
 * None of it is visible to a unit test, to axe, or to a reader of `screens.md`. What sees
 * it is computed style on a rendered page, which is what this file reads.
 */

const AREAS = [
  { hash: '', role: 'overview' },
  { hash: '#recovery', role: 'incident-picker' },
  { hash: '#recovery=pasted-command', role: 'recovery' },
  { hash: '#queue', role: 'queue-section' },
  { hash: '#journal', role: 'journal' },
  { hash: '#leaks', role: 'leaks-section' },
  { hash: '#extensions', role: 'extensions' },
  { hash: '#trusted', role: 'trusted' },
  { hash: '#audit', role: 'self-audit' },
  { hash: '#data', role: 'data-controls' },
] as const

/** The three pages that are not areas of the options page. */
const PAGES = [
  { file: 'popup.html', role: 'popup' },
  { file: 'first-run.html', role: 'first-run' },
  { file: 'interstitial.html', role: 'interstitial' },
] as const

interface Shape {
  readonly panels: number
  readonly role: string | null
  readonly padding: number
  readonly border: number
  readonly focusedRole: string | null
  readonly focusedPadding: number
  readonly markers: string[]
  readonly h1: number
}

/** What the page renders, read from computed style rather than from the markup. */
async function shapeOf(page: import('@playwright/test').Page): Promise<Shape> {
  return page.evaluate(() => {
    const root = document.getElementById('root') as HTMLElement
    const panels = [...root.children].filter((el) => el.getAttribute('data-role') !== 'back')
    const panel = panels[0] as HTMLElement | undefined
    const style = panel === undefined ? null : getComputedStyle(panel)
    const active = document.activeElement as HTMLElement | null
    const activeStyle = active === null ? null : getComputedStyle(active)
    return {
      panels: panels.length,
      role: panel?.getAttribute('data-role') ?? null,
      padding: style === null ? 0 : Number.parseFloat(style.paddingTop),
      border: style === null ? 0 : Number.parseFloat(style.borderTopWidth),
      focusedRole: active?.getAttribute?.('data-role') ?? null,
      focusedPadding: activeStyle === null ? 0 : Number.parseFloat(activeStyle.paddingTop),
      markers: [...document.querySelectorAll('li')]
        .filter((li) => getComputedStyle(li).listStyleType !== 'none')
        .map((li) => (li.textContent ?? '').trim().slice(0, 40)),
      h1: document.querySelectorAll('h1').length,
    }
  })
}

for (const { hash, role } of AREAS) {
  test(`the ${role} area is one card, and the card is what arrives`, async ({
    context,
    extensionId,
  }) => {
    const page = await context.newPage()
    await page.goto(`chrome-extension://${extensionId}/options.html${hash}`)
    await expect(page.locator(`[data-role=${role}]`)).toHaveCount(1)

    const shape = await shapeOf(page)
    expect(shape.panels, `${role}: the router mounted more than one panel`).toBe(1)
    expect(shape.role, `${role}: the panel is a role-less wrapper`).toBe(role)
    expect(shape.padding, `${role}: the panel has no padding`).toBeGreaterThan(0)
    expect(shape.border, `${role}: the panel has no card border`).toBeGreaterThan(0)
    expect(shape.markers, `${role}: a list renders browser markers`).toEqual([])
    expect(shape.h1, `${role}: a screen has none or several first-level headings`).toBe(1)
  })
}

test('arriving at an area puts focus on the card, not on a wrapper around it', async ({
  context,
  extensionId,
}) => {
  // Focus is what draws the ring, so focusing a box with no padding puts a rectangle on
  // screen that frames nothing and reads as a second card. Navigated rather than opened
  // directly: the router only moves focus on arrival.
  const page = await context.newPage()
  await page.goto(`chrome-extension://${extensionId}/options.html`)
  await expect(page.locator('[data-role=overview]')).toHaveCount(1)

  for (const { hash, role } of [
    { hash: '#audit', role: 'self-audit' },
    { hash: '#data', role: 'data-controls' },
    { hash: '#extensions', role: 'extensions' },
  ] as const) {
    await page.evaluate((to) => {
      location.hash = to
    }, hash)
    await expect(page.locator(`[data-role=${role}]`)).toHaveCount(1)
    const shape = await shapeOf(page)
    expect(shape.focusedRole, `arriving at ${role} focused something else`).toBe(role)
    expect(shape.focusedPadding, `${role}: the focused box has no padding`).toBeGreaterThan(0)
  }
})

test('a clickable row is drawn as a row, not as a chip', async ({ context, extensionId }) => {
  /**
   * Two rows in this product are `<button>`s — the journal's history line and the popup's
   * "nothing new since…" line — and the stylesheet's chip rule gave them a rounded bordered
   * box the width of their text, which reads as a disabled text field. Both shipped that
   * way and the screenshot is what showed it.
   *
   * The measurable property is width: a row spans its panel, a chip does not. Asserted on
   * the journal, whose row exists on a fresh profile — the popup's line needs a check to
   * have happened, and a test that seeds one would be about the seeding.
   */
  const page = await context.newPage()
  await page.goto(`chrome-extension://${extensionId}/options.html#journal`)
  // The row, not only its container: the screen is a snapshot taken as it opens, and on a
  // fresh profile the first row (the feed download) can land a moment after that. Waiting
  // for the container and reading the row at once failed on CI with "no journal row to
  // measure" (run 40868937905).
  await expectJournalRows(page, 'button[data-role=entry]')

  const shape = await page.evaluate(() => {
    const row = document.querySelector('button[data-role=entry]')
    if (row === null) return null
    const panel = document.querySelector('[data-role=journal]') as HTMLElement
    const style = getComputedStyle(row)
    return {
      width: row.getBoundingClientRect().width,
      inner: panel.clientWidth - Number.parseFloat(getComputedStyle(panel).paddingInline || '0') * 2,
      radius: Number.parseFloat(style.borderTopLeftRadius),
      border: Number.parseFloat(style.borderTopWidth) + Number.parseFloat(style.borderLeftWidth),
      align: style.textAlign,
    }
  })

  // A fresh profile has one journal row — the feed download — but if a build ever renders
  // none, say so rather than passing on an absent element.
  expect(shape, 'no journal row to measure').not.toBeNull()
  expect(shape?.radius, 'the row has a chip corner').toBe(0)
  expect(shape?.align, 'the row centres its text like a button').toBe('start')
  // Full width, allowing for the panel's own padding rounding.
  expect(shape?.width ?? 0).toBeGreaterThan((shape?.inner ?? 0) - 4)
})

for (const { file, role } of PAGES) {
  test(`${file} is one card too`, async ({ context, extensionId }) => {
    const page = await context.newPage()
    await page.goto(`chrome-extension://${extensionId}/${file}`)
    await expect(page.locator(`[data-role=${role}]`)).toHaveCount(1)

    const shape = await shapeOf(page)
    expect(shape.panels, `${role}: more than one panel at the root`).toBe(1)
    expect(shape.role, `${role}: the panel is a role-less wrapper`).toBe(role)
    expect(shape.padding, `${role}: the panel has no padding`).toBeGreaterThan(0)
    expect(shape.markers, `${role}: a list renders browser markers`).toEqual([])
  })
}
