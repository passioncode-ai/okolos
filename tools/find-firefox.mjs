/**
 * Finds the Firefox Playwright installed, without naming its build number.
 *
 * The number changes with every Playwright upgrade, and a path that carries one
 * turns an unrelated dependency bump into a red Firefox job — which is exactly
 * the pressure that gets a browser dropped from CI. So the newest build in the
 * cache is used, and an explicit FIREFOX_BINARY still wins for anyone pointing
 * at a system install.
 *
 * Moved out of `firefox-e2e.mjs`, which starts a server on import, so the search can
 * be tested; and taught the Windows cache (B-163). It read `$HOME`, which Windows
 * does not set, looked only in the macOS and Linux caches, and expected a binary
 * with no `.exe`. On Windows Playwright keeps browsers under
 * `%LOCALAPPDATA%\ms-playwright` and the binary is `firefox\firefox.exe`.
 */
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { directoriesIn } from './tree.mjs'

/**
 * Where Playwright's browser cache can be on `platform`, most specific first.
 *
 * @param {{ platform?: string, env?: Record<string, string | undefined>, home?: string }} [options]
 * @returns {string[]}
 */
export function playwrightCaches({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local')
    return [env.PLAYWRIGHT_BROWSERS_PATH, path.join(local, 'ms-playwright')].filter(isSet)
  }
  return [
    env.PLAYWRIGHT_BROWSERS_PATH,
    path.join(home, 'Library/Caches/ms-playwright'),
    path.join(home, '.cache/ms-playwright'),
    '/root/.cache/ms-playwright',
  ].filter(isSet)
}

/**
 * The binary inside one `firefox-<build>` directory, per layout.
 *
 * @param {string} [platform]
 * @returns {string[]}
 */
export function firefoxSuffixes(platform = process.platform) {
  // macOS ships an .app bundle, Linux a bare binary, Windows an .exe.
  if (platform === 'win32') return [path.join('firefox', 'firefox.exe')]
  return ['firefox/Nightly.app/Contents/MacOS/firefox', 'firefox/firefox']
}

/** @param {string | undefined} value @returns {value is string} */
function isSet(value) {
  return typeof value === 'string' && value !== ''
}

/**
 * The newest Playwright Firefox, or FIREFOX_BINARY when set. Throws with the command
 * that installs one when there is none.
 *
 * @param {{ platform?: string, env?: Record<string, string | undefined>, home?: string,
 *   exists?: (file: string) => boolean, list?: (dir: string) => string[] }} [options]
 * @returns {string}
 */
export function findFirefox({
  platform = process.platform,
  env = process.env,
  home = os.homedir(),
  exists = existsSync,
  list = directoriesIn,
} = {}) {
  if (env.FIREFOX_BINARY) return env.FIREFOX_BINARY

  const found = []
  for (const dir of playwrightCaches({ platform, env, home })) {
    let entries
    try {
      entries = list(dir)
    } catch {
      continue
    }
    for (const entry of entries) {
      const build = /^firefox-(\d+)$/.exec(entry)
      if (!build) continue
      for (const suffix of firefoxSuffixes(platform)) {
        const candidate = path.join(dir, entry, suffix)
        if (exists(candidate)) found.push({ build: Number(build[1]), candidate })
      }
    }
  }

  if (found.length === 0) {
    throw new Error(
      'No Playwright Firefox found. Run `pnpm exec playwright install firefox`, ' +
        'or set FIREFOX_BINARY to a Firefox you already have.',
    )
  }

  // Newest build wins: an old one left behind by a previous version would
  // otherwise be tested instead of the one the suite was written against.
  found.sort((a, b) => b.build - a.build)
  return found[0].candidate
}
