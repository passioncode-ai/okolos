#!/usr/bin/env node
/**
 * Builds a loadable extension for each browser.
 *
 * Three separate passes, because the targets genuinely differ:
 *   - the content script must be one self-contained IIFE (Chrome does not
 *     support modules in content scripts, and a split chunk would simply fail
 *     to load on the page it is meant to protect);
 *   - the background is a module in both browsers;
 *   - the pages are ordinary multi-page HTML.
 *
 * The manifests are hand-written per browser rather than generated. They are
 * the security surface of the whole product — the permission list is the
 * promise a reviewer and a user actually read — and a generated manifest is
 * one indirection away from nobody noticing a permission appear.
 */

import { readFile, writeFile, mkdir, rm, cp } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { build } from 'vite'
import { pageMarks } from './build-flags.mjs'
import { buildingDir, swapInto, sweepLeftovers } from './dist-swap.mjs'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const app = path.join(root, 'apps/extension')
const targets = ['chrome', 'firefox']

/**
 * `--with-test-hooks` produces a parallel build in dist/<target>-e2e whose
 * in-page surfaces use an open shadow root, so end-to-end tests can drive the
 * controls a user clicks. The production build never carries it, and a bundle
 * gate asserts that.
 */
const withTestHooks = process.argv.includes('--with-test-hooks')
/**
 * The build the store screenshots are taken from (`pnpm screenshots`): closed shadow roots and no
 * key, like `dist/<target>`, but the usage notice and switch as the store build shows them
 * (B-209). Written to `dist/<target>-shots`, which the screenshot tool removes when it is done.
 */
const forStoreShots = process.argv.includes('--store-shots')

const shared = {
  configFile: false,
  logLevel: 'warn',
  resolve: { conditions: ['import', 'module', 'browser', 'default'] },
  define: {
    __OKOLOS_TEST_HOOKS__: JSON.stringify(withTestHooks),
    // Marks in the page's performance timeline, which a page can read: none in the store build (B-190).
    __OKOLOS_PAGE_MARKS__: JSON.stringify(pageMarks({ withTestHooks, env: process.env })),
    /**
     * Usage and error data (B-198, B-199). Only the store build made by `pnpm package` sets
     * these, through the secret runner; every other build carries no App-Key and `sandbox`, and
     * a build with no key sends nothing. A test-hook build never carries a key.
     */
    __OKOLOS_USAGE__: JSON.stringify({
      // The vault slot passioncode-platform/prod/APTABASE_APP_KEY_OKOLOS, set only by the secret
      // runner around `pnpm package` (docs/runbooks/development.md, «Выпуск»).
      // Only together with the production flag `pnpm package` sets: a plain `pnpm build` from a
      // shell that happens to hold the key builds without it.
      appKey: withTestHooks || process.env.OKOLOS_USAGE_ENV !== 'production' ? null : (process.env.APTABASE_APP_KEY_OKOLOS || null),
      environment: !withTestHooks && process.env.OKOLOS_USAGE_ENV === 'production' ? 'production' : 'sandbox',
      // The test build shows the switch and the notice as the store build does, with no key to
      // send with (B-209); every other keyless build says it sends nothing.
      asIfSending: withTestHooks || forStoreShots,
    }),
  },
}

// A killed earlier run may have left a half-written directory beside a target (B-226).
await sweepLeftovers(path.join(app, 'dist'))

for (const target of targets) {
  // Written beside the target and swapped in at the end, so a reader never finds it empty (B-226).
  const finalDir = path.join(app, 'dist', withTestHooks ? `${target}-e2e` : forStoreShots ? `${target}-shots` : target)
  const outDir = buildingDir(finalDir)
  await rm(outDir, { recursive: true, force: true })
  await mkdir(outDir, { recursive: true })

  // 1. Content script — single file, IIFE, no code splitting.
  await build({
    ...shared,
    build: {
      outDir,
      emptyOutDir: false,
      target: 'chrome116',
      rollupOptions: {
        input: path.join(app, 'src/content/index.ts'),
        output: { entryFileNames: 'content.js', format: 'iife', codeSplitting: false },
      },
    },
  })

  // 1b. Page watcher — MAIN world, so it can see the page's own requests.
  // Same constraints as the content script: one self-contained IIFE.
  await build({
    ...shared,
    build: {
      outDir,
      emptyOutDir: false,
      target: 'chrome116',
      rollupOptions: {
        input: path.join(app, 'src/page-watch/index.ts'),
        output: { entryFileNames: 'page-watch.js', format: 'iife', codeSplitting: false },
      },
    },
  })

  // 2. Background — module.
  await build({
    ...shared,
    build: {
      outDir,
      emptyOutDir: false,
      target: 'chrome116',
      rollupOptions: {
        input: path.join(app, 'src/background/index.ts'),
        output: { entryFileNames: 'background.js', format: 'es', codeSplitting: false },
      },
    },
  })

  // 3. Pages.
  await build({
    ...shared,
    root: app,
    build: {
      outDir,
      emptyOutDir: false,
      target: 'chrome116',
      rollupOptions: {
        input: {
          options: path.join(app, 'src/options/index.html'),
          popup: path.join(app, 'src/popup/index.html'),
          'first-run': path.join(app, 'src/first-run/index.html'),
          interstitial: path.join(app, 'src/interstitial/index.html'),
        },
        output: { entryFileNames: '[name].js', chunkFileNames: 'chunks/[name].js' },
      },
    },
  })

  // Vite keeps the source folder structure for HTML; flatten it so the
  // manifest can name popup.html and options.html directly.
  for (const page of ['options', 'popup', 'first-run', 'interstitial']) {
    await cp(path.join(outDir, 'src', page, 'index.html'), path.join(outDir, `${page}.html`))
  }
  await rm(path.join(outDir, 'src'), { recursive: true, force: true })

  const manifest = await readFile(path.join(app, `manifest.${target}.json`), 'utf8')
  await writeFile(path.join(outDir, 'manifest.json'), manifest)

  /**
   * Copy the product, not the directory.
   *
   * `cp` with `recursive` takes everything, and everything includes what nobody
   * wrote on purpose: macOS puts a `.DS_Store` into any folder its Finder has
   * displayed. Both of these directories are hand-maintained, so both get
   * displayed. The file was reaching `dist/<target>/_locales/` and going into
   * the store archive — `unzip -l` found it — while `pnpm package:check` passed
   * all eight checks, because it asks whether every file the manifest names is
   * present and never whether the package holds a file nobody named.
   *
   * Dotfiles only, and the narrowness is the design. This filter drops what
   * nobody wrote — a tool put it there and there is no one to tell. Anything a
   * person wrote and misplaced (`icons/notes.txt`) is copied on purpose, so that
   * `tools/gates/bundle-scan.test.ts` and `package.mjs` can refuse it out loud;
   * silently dropping that would hide a mistake instead of reporting it. Both
   * were shown red by exactly that file.
   */
  const product = (from) => !path.basename(from).startsWith('.')

  // The manifest names icon files; a package without them installs with a
  // placeholder and uploads as a broken listing.
  await cp(path.join(app, 'icons'), path.join(outDir, 'icons'), { recursive: true, filter: product })

  // Without these the manifest's `__MSG_appName__` is what the browser shows.
  await cp(path.join(app, '_locales'), path.join(outDir, '_locales'), {
    recursive: true,
    filter: product,
  })

  await swapInto(finalDir, outDir)
  console.log(`built ${target}${withTestHooks ? ' (test hooks)' : ''} → ${path.relative(root, finalDir)}`)
}
