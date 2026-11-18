#!/usr/bin/env node
/**
 * The pages' own stylesheet, laid out by Gecko.
 *
 *   node tools/gecko-layout.mjs      # part of `pnpm test:e2e:firefox`
 *
 * The Firefox harness beside this file records a limit in its own words: the extension's own
 * pages are not opened in that engine, because geckodriver refuses to navigate to
 * `moz-extension://` from the content context. Two things were measured on 2026-08-21 and both
 * belong here rather than in a memory:
 *
 *   - the **chrome context** does allow it, through `openTrustedLinkIn`, and needs Firefox to
 *     be started with `-remote-allow-system-access`. geckodriver's own
 *     `--allow-system-access` is not enough, and passing the browser flag through capabilities
 *     is refused outright: "Argument --remote-allow-system-access can't be set via
 *     capabilities". So the limit has a named blocker now, not an absence of attempts.
 *   - what the limit leaves untested is the catalogue **and the stylesheet**. The catalogue
 *     needs the extension; the stylesheet does not. So this replays the markup Chromium
 *     renders against the built CSS inside Firefox, and measures the one class of defect that
 *     has come back four times in this project: two pieces of text with nothing between them.
 *
 * It is a layout check, said plainly: the data comes from Chromium, the layout is Gecko's.
 */
import { chromium, firefox } from '@playwright/test'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BUILD = path.join(root, 'apps/extension/dist/chrome')
/**
 * Each area with the element its finished paint carries, the same pairs `e2e/no-flush-text.spec.ts`
 * waits for. An area is painted once, after its reads; the overview paints a counting shell
 * first, so it is finished when the counting line is gone.
 */
const AREAS = [
  { hash: '', role: 'overview' },
  { hash: '#queue', role: 'queue-section' },
  { hash: '#journal', role: 'journal' },
  { hash: '#leaks', role: 'leaks-section' },
  { hash: '#extensions', role: 'extensions' },
  { hash: '#trusted', role: 'trusted' },
  { hash: '#audit', role: 'self-audit' },
  { hash: '#data', role: 'data-controls' },
]

/** Two element siblings carrying text, on one line, with nothing between them. */
const FLUSH = () => {
  const touching = []
  for (const parent of document.querySelectorAll('#root *')) {
    const kids = [...parent.children].filter((el) => {
      // Through the element's own window rather than the global: this body runs in the page,
      // and a lint that reads the file as Node is right that no such global exists here.
      const style = el.ownerDocument.defaultView.getComputedStyle(el)
      return style.display.startsWith('inline') && (el.textContent ?? '').trim().length > 1
    })
    for (let i = 1; i < kids.length; i += 1) {
      const left = kids[i - 1].getBoundingClientRect()
      const right = kids[i].getBoundingClientRect()
      if (Math.abs(left.top - right.top) < 4 && right.left - left.right < 1.5) {
        touching.push(
          `${kids[i - 1].dataset.role ?? kids[i - 1].tagName}+${kids[i].dataset.role ?? kids[i].tagName}`,
        )
      }
    }
  }
  return touching
}

const staged = mkdtempSync(path.join(tmpdir(), 'okolos-gecko-'))
cpSync(BUILD, staged, { recursive: true })
rmSync(path.join(staged, '_locales/en'), { recursive: true, force: true })

const failures = []
const context = await chromium.launchPersistentContext('', {
  channel: 'chromium',
  args: [`--disable-extensions-except=${staged}`, `--load-extension=${staged}`, '--lang=ru'],
  locale: 'ru-RU',
  viewport: { width: 1280, height: 900 },
})
let [worker] = context.serviceWorkers()
if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20_000 })
const id = new URL(worker.url()).host

// The built sheet, read through the page's own link: its name carries a content hash.
const href = readFileSync(path.join(staged, 'options.html'), 'utf8').match(/href="([^"]*\.css)"/)?.[1]
if (!href) throw new Error('options.html links no stylesheet')
const css = readFileSync(path.join(staged, href.replace(/^\//, '')), 'utf8')

const markup = {}
const page = await context.newPage()
for (const { hash, role } of AREAS) {
  await page.goto(`chrome-extension://${id}/options.html${hash}`)
  // The page's own word that it has painted, not 600 ms: a fixed wait read whatever was there
  // when it ran out, the counting shell included on a loaded machine (B-189).
  await page.locator(`#root [data-role=${role}]`).first().waitFor({ state: 'attached', timeout: 30_000 })
  await page.locator('[data-role=attention-counting]').waitFor({ state: 'detached', timeout: 30_000 })
  markup[hash || 'overview'] = await page.evaluate(() => document.getElementById('root')?.outerHTML ?? '')
}
await context.close()

const gecko = await firefox.launch()
const geckoPage = await gecko.newPage({ viewport: { width: 1280, height: 900 }, locale: 'ru-RU' })
for (const [name, html] of Object.entries(markup)) {
  const file = path.join(staged, `${name.replace('#', '')}.html`)
  writeFileSync(
    file,
    `<!doctype html><html lang="ru"><head><meta charset="utf-8"><style>${css}</style></head><body>${html}</body></html>`,
  )
  await geckoPage.goto(`file://${file}`)
  const flush = await geckoPage.evaluate(FLUSH)
  if (flush.length > 0) failures.push(`${name}: ${flush.join(', ')}`)
  console.log(`  ${flush.length === 0 ? 'ok  ' : 'FAIL'} ${name}`)
}
await gecko.close()
rmSync(staged, { recursive: true, force: true })

if (failures.length > 0) {
  console.error(
    `\n  ${failures.length} area(s) render two pieces of text with nothing between them in Gecko:\n` +
      failures.map((line) => `    ${line}`).join('\n') +
      '\n\n  Chromium may hide this: the engines break lines differently.\n',
  )
  process.exit(1)
}
console.log('\n  Gecko lays the pages out with nothing touching.\n')
