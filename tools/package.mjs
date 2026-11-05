#!/usr/bin/env node
/**
 * The archive you upload, built by one command that refuses to lie.
 *
 *   node tools/package.mjs           # builds, checks, writes dist/release/*.zip
 *   node tools/package.mjs --check   # every check, no archive
 *
 * Why a command and not a runbook: this session has twice paid for a step that
 * lived in a document. The feeds table stayed empty because publishing was a
 * sentence someone had to remember, and the feed's own source spent a release
 * in a temporary file for the same reason. A release is the worst place to
 * discover that habit.
 *
 * What it refuses to package, in order of how badly it would end:
 *
 *   - a build carrying the test hooks. Those open the shadow roots, which is
 *     exactly the property the in-page surfaces rest on: an open root lets a
 *     hostile page read and remove the warning about itself. Shipping that is
 *     shipping the vulnerability the product exists to prevent.
 *   - a manifest naming a file the package does not contain — an icon, a
 *     locale, a page. The browser rejects it, but only after the upload.
 *   - a stale build. The archive is made from a build this command performed,
 *     not from whatever was in `dist` from an afternoon of experiments.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'

import { archivePlan, compareEntries, zipEntries } from './archive.mjs'
import { runToCompletion } from './bin.mjs'
import { carriesKey, guardKeyedBuilds, keyedTargets } from './keyed-builds.mjs'
import { toHtml } from './privacy-page.mjs'
import { PRIVACY_URL, servedPolicyBehind } from './privacy-served.mjs'
import { filesUnder } from './tree.mjs'
import { pruneReleases, RELEASES_KEPT } from './release-prune.mjs'
import { FEED_MAX_AGE_DAYS, feedAgeDays, feedTooOld, freshestFeed } from './feed-age.mjs'

const root = path.resolve(import.meta.dirname, '..')
const dist = path.join(root, 'apps/extension/dist')
const out = path.join(dist, 'release')
const TARGETS = ['chrome', 'firefox']
const checkOnly = process.argv.includes('--check')

function die(message) {
  console.error(`\npackage: ${message}`)
  keyedBuilds.drop()
  process.exit(1)
}

/**
 * dist/<target> carries the App-Key from the moment the store build starts until the keyless
 * rebuild has finished. Any way out in between (die, an exception, a signal, a first build that
 * failed half-way) removes it: it is what an unpacked load and every test read (B-199).
 */
const keyedBuilds = guardKeyedBuilds(TARGETS.map((target) => path.join(dist, target)))
let keyed = false

const ok = (message) => console.log(`   ok    ${message}`)

/**
 * Everything in a directory, relative to it.
 *
 * The walk is `tree.mjs`'s (B-58); the relative shape is this tool's, because a release
 * archive is described by paths inside itself. Nothing is skipped: what is in the
 * directory is what ships, and a `dist` inside a build output is part of the build.
 */
function filesIn(dir) {
  return filesUnder(dir, '', { skip: [] }).map((file) =>
    path.relative(dir, file).split(path.sep).join('/'),
  )
}

/**
 * Every path the manifest points at.
 *
 * Read from the JSON rather than from a list here: a manifest field added next
 * year is a file this would otherwise stop checking, silently.
 */
function referencedPaths(manifest) {
  const paths = new Set()
  const walk = (value) => {
    if (typeof value === 'string') {
      if (/\.(js|html|css|png|json)$/.test(value) && !value.startsWith('http')) paths.add(value)
    } else if (Array.isArray(value)) {
      for (const item of value) walk(item)
    } else if (value && typeof value === 'object') {
      for (const item of Object.values(value)) walk(item)
    }
  }
  walk(manifest)
  return [...paths]
}

/**
 * Before anything is built: is the blocklist still worth shipping.
 *
 * Here rather than in `pnpm test`, and the placement is the decision. Publishing
 * is a local step by ADR-0002 — the signing key never leaves the machine — so a
 * freshness gate on every commit would be red for a reason nobody can fix from
 * where they are standing, which is how a project learns to pass
 * `OKOLOS_SKIP_GATES=1`. A release is deliberate and rare, and refusing one that
 * would ship an abandoned blocklist is exactly what a release gate is for.
 */
console.log('\n── the blocklist, which is the thing this product blocks with')
{
  // The newer of the committed snapshot and the agent's published state (F1).
  const shipped = freshestFeed()
  const stale = feedTooOld(Date.now(), shipped)
  if (stale) die(stale)
  ok(`${shipped} is ${feedAgeDays(Date.now(), shipped).toFixed(1)} days old, within ${FEED_MAX_AGE_DAYS}`)
}

console.log('\n── usage and error data: the App-Key is the store archive\'s, and only its')
// Both modes, before anything is built: a run killed before its keyless rebuild leaves a keyed
// dist/<target> behind, which an unpacked load would carry; it is removed, not trusted (B-215).
for (const target of keyedTargets(dist, TARGETS)) {
  rmSync(path.join(dist, target), { recursive: true, force: true })
  console.log(`   removed dist/${target}: a run that was stopped left it carrying an App-Key`)
}
/**
 * B-198, B-199. The store archive sends usage and error events as `production`, with the App-Key
 * the secret runner puts in the environment for this command only; nothing else ever carries the
 * key, and a build without it sends nothing. `--check` (CI) builds no store archive, so it
 * needs no key.
 */
const usageKey = process.env.APTABASE_APP_KEY_OKOLOS ?? ''
if (!checkOnly) {
  if (!/^A-SH-\d{10}$/i.test(usageKey)) {
    die(
      'the store archive needs its App-Key, from the vault and for this command only:\n' +
        '     python3 "$(project-observatory full-path)/tools/use_secret.py" run --vault-only --env prod ' +
        'passioncode-platform APTABASE_APP_KEY_OKOLOS -- pnpm package',
    )
  }
  process.env.OKOLOS_USAGE_ENV = 'production'
  ok('the App-Key is in the environment of this command, and the build will be production')
} else {
  ok('--check builds no store archive, so it carries no App-Key')
}

console.log('\n── the policy the listing names, which must already say what this archive sends')
if (!checkOnly) {
  let served
  try {
    const response = await fetch(PRIVACY_URL, { signal: AbortSignal.timeout(15_000) })
    // A delivery failure is named as one, not as a policy that differs (B-215).
    if (!response.ok) die(`${PRIVACY_URL} answered ${response.status}; a store archive waits until it serves the policy`)
    served = await response.text()
  } catch (cause) {
    die(`could not read ${PRIVACY_URL} (${cause instanceof Error ? cause.message : String(cause)}); a store archive waits until it can`)
  }
  const policy = readFileSync(path.join(root, 'docs/privacy.md'), 'utf8')
  const behind = servedPolicyBehind(served, policy, toHtml(policy))
  if (behind) die(`${behind}. Deploy the worker first (docs/runbooks/worker-deploy.md), then package`)
  ok(`${PRIVACY_URL} is the policy of docs/privacy.md`)
} else {
  ok('--check builds no store archive, so it does not read the served policy')
}

console.log('\n── build, so the archive is of something this command made')
// Per target, not per `dist`. `dist` also holds `release/` and the two e2e
// builds, so it exists long after a target directory has been deleted — and then
// `--check` reported "chrome was not built" instead of building it, on a tree
// where `pnpm build` would have taken three seconds. In CI this changes nothing:
// the build step runs first and every target is already there.
const built = TARGETS.every((target) => existsSync(path.join(dist, target)))
if (!checkOnly || !built) {
  // pnpm is pnpm.cmd on Windows, which Node will not spawn without a shell (B-163).
  // At the deadline the whole tree ends, not only that cmd.exe (B-164).
  if (checkOnly) {
    // A check never builds with the key, whatever the shell it runs in exported.
    delete process.env.APTABASE_APP_KEY_OKOLOS
    delete process.env.OKOLOS_USAGE_ENV
  } else {
    // Before the first byte: build.mjs writes chrome whole before firefox, so a build that
    // fails on firefox has already left a keyed chrome.
    keyed = true
    keyedBuilds.arm()
  }
  await runToCompletion('pnpm', ['build'], { cwd: root, timeoutMs: 10 * 60_000, onSpawn: keyedBuilds.watch })
}

for (const target of TARGETS) {
  const dir = path.join(dist, target)
  console.log(`\n── ${target}`)
  if (!existsSync(dir)) die(`${target} was not built`)

  const manifestPath = path.join(dir, 'manifest.json')
  if (!existsSync(manifestPath)) die(`${target} has no manifest.json`)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))

  // The one that would ship the vulnerability.
  const content = readFileSync(path.join(dir, 'content.js'), 'utf8')
  if (content.includes('"open"') || content.includes("'open'")) {
    die(
      `${target} carries the test hooks: its shadow roots are open, which lets a page ` +
        `read and remove the warning about itself. Build without --with-test-hooks.`,
    )
  }
  ok('shadow roots are closed — no test hooks in this build')

  const leaked = carriesKey(dir, usageKey)
  if (leaked.length > 0) die(`${target} carries the App-Key outside its background: ${leaked.join(', ')}`)
  if (!checkOnly && !readFileSync(path.join(dir, 'background.js'), 'utf8').includes(usageKey)) {
    die(`${target}'s background was built without the App-Key, so it would send nothing`)
  }

  const contents = filesIn(dir)
  const present = new Set(contents)
  const missing = referencedPaths(manifest).filter((file) => !present.has(file))
  if (missing.length > 0) {
    die(`${target}'s manifest names files the package does not contain:\n     ${missing.join('\n     ')}`)
  }
  ok(`every file the manifest names is in the package (${present.size} files)`)

  /**
   * And the other direction, which is the one that was missing.
   *
   * The check above asks whether every file the manifest names is present. It
   * cannot ask the reverse, and a release needs both: a `.DS_Store` written by
   * Finder into `_locales` was copied into both builds and packaged into the
   * archive — found with `unzip -l` — while all eight checks passed and reported
   * a clean release.
   *
   * Closed by extension rather than by a list of names, because the next one
   * will not be called `.DS_Store`: `Thumbs.db`, a stray `.map`, a `README.md`
   * that wandered in. And no dotfile at any depth, since that is the shape of
   * the thing a tool writes without being asked.
   *
   * Not a reachability walk, deliberately. Most of the package is named by an
   * HTML `<script src>` or a JS import rather than by the manifest, so "named by
   * the manifest" would reject the chunks and the stylesheet; the honest claim
   * this can make is narrower and it is stated as such — nothing here is of a
   * kind the product does not produce.
   */
  const SHIPPED = new Set(['.js', '.html', '.css', '.png', '.json'])
  const foreign = contents.filter(
    (file) =>
      file.split('/').some((part) => part.startsWith('.')) || !SHIPPED.has(path.extname(file)),
  )
  if (foreign.length > 0) {
    die(
      `${target} contains files the product does not produce:\n     ${foreign.join('\n     ')}\n` +
        `     Nothing outside ${[...SHIPPED].join(' ')} ships, and no dotfile at any depth.`,
    )
  }
  ok(`nothing in the package that the product does not produce (${present.size} files)`)

  if (manifest.default_locale !== undefined) {
    const locale = `_locales/${manifest.default_locale}/messages.json`
    if (!present.has(locale)) die(`${target} declares default_locale ${manifest.default_locale} and has no ${locale}`)
    const messages = JSON.parse(readFileSync(path.join(dir, locale), 'utf8'))
    const asked = [...JSON.stringify(manifest).matchAll(/__MSG_([A-Za-z0-9_]+)__/g)].map((m) => m[1])
    const absent = asked.filter((key) => messages[key] === undefined)
    if (absent.length > 0) die(`${target}'s manifest asks for messages that are not in ${locale}: ${absent.join(', ')}`)
    ok(`default locale ${manifest.default_locale} answers every __MSG__ the manifest uses`)
  }

  if (Object.keys(manifest.icons ?? {}).length === 0) die(`${target} declares no icons`)
  ok(`icons declared: ${Object.keys(manifest.icons).join(', ')}`)

  if (checkOnly) continue

  mkdirSync(out, { recursive: true })
  const archive = path.join(out, `okolos-${target}-${manifest.version}.zip`)
  rmSync(archive, { force: true })
  // `zip -X` on macOS and Linux; the System32 tar on Windows, which has no zip (B-163).
  const plan = archivePlan(archive, contents)
  execFileSync(plan.command, plan.args, { cwd: dir, timeout: 120_000 })

  // Checked by contents, not bytes: two tools write two byte streams, and what the
  // store unpacks is the list of files. Every file of the build, and nothing else.
  const { missing: unpacked, extra } = compareEntries(zipEntries(readFileSync(archive)), contents)
  if (unpacked.length > 0 || extra.length > 0) {
    die(
      `${path.relative(root, archive)} does not hold the build:` +
        (unpacked.length > 0 ? `\n     missing: ${unpacked.join(', ')}` : '') +
        (extra.length > 0 ? `\n     extra: ${extra.join(', ')}` : ''),
    )
  }
  ok(`the archive holds exactly the ${contents.length} files of the build`)

  const bytes = statSync(archive).size
  const digest = createHash('sha256').update(readFileSync(archive)).digest('hex')
  console.log(`\n   ${path.relative(root, archive)}`)
  console.log(`   ${bytes.toLocaleString('en-US')} bytes`)
  console.log(`   sha256 ${digest}`)

  // LC-15: the current release and the one before it, nothing older.
  for (const name of pruneReleases(out)) {
    console.log(`   pruned ${name} (keeping the newest ${RELEASES_KEPT} per browser)`)
  }
}

if (keyed) {
  console.log('\n── dist/<target> again, without the App-Key: only the archive carries it')
  delete process.env.APTABASE_APP_KEY_OKOLOS
  delete process.env.OKOLOS_USAGE_ENV
  try {
    await runToCompletion('pnpm', ['build'], { cwd: root, timeoutMs: 10 * 60_000, onSpawn: keyedBuilds.watch })
  } catch (cause) {
    die(`the keyless rebuild failed (${cause instanceof Error ? cause.message : String(cause)})`)
  }
  for (const target of TARGETS) {
    if (readFileSync(path.join(dist, target, 'background.js'), 'utf8').includes(usageKey)) {
      die(`${target} still carries the App-Key after the keyless rebuild`)
    }
  }
  keyed = false
  keyedBuilds.disarm()
  ok('dist/chrome and dist/firefox carry no App-Key')
}

console.log(
  checkOnly
    ? '\nevery check passed; no archive written (--check)'
    : '\nready to upload. The sha256 above is what you compare against the store listing.',
)
