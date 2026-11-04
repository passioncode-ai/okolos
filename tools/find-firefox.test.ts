import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { findFirefox, firefoxSuffixes, playwrightCaches } from './find-firefox.mjs'

/**
 * The Firefox suite finds Playwright's Firefox on Windows too (B-163): it read `$HOME`,
 * which Windows does not set, and looked for a binary without `.exe`. The platform is a
 * parameter, so each layout is checked on a real directory tree on this machine.
 */

/** A temporary directory with `files` created under it, empty. */
function tree(files: string[]): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'okolos-firefox-'))
  for (const file of files) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
    writeFileSync(path.join(dir, file), '')
  }
  return dir
}

describe('where the cache is', () => {
  it('is LOCALAPPDATA\\ms-playwright on Windows, and never a POSIX path', () => {
    const caches = playwrightCaches({ platform: 'win32', env: { LOCALAPPDATA: 'L' }, home: 'H' })
    expect(caches).toEqual([path.join('L', 'ms-playwright')])
  })

  it('falls back to the home directory when LOCALAPPDATA is unset', () => {
    expect(playwrightCaches({ platform: 'win32', env: {}, home: 'H' })).toEqual([
      path.join('H', 'AppData', 'Local', 'ms-playwright'),
    ])
  })

  it('puts PLAYWRIGHT_BROWSERS_PATH first on every platform', () => {
    expect(playwrightCaches({ platform: 'win32', env: { PLAYWRIGHT_BROWSERS_PATH: 'P' }, home: 'H' })[0]).toBe('P')
    expect(playwrightCaches({ platform: 'linux', env: { PLAYWRIGHT_BROWSERS_PATH: 'P' }, home: 'H' })[0]).toBe('P')
  })

  it('keeps the macOS and Linux caches it always read', () => {
    // Joined with the host's separator, which is what the function does: on a Windows
    // host a darwin answer is `\h\Library\…`, and the literal `/h/…` was never it (B-164).
    expect(playwrightCaches({ platform: 'darwin', env: {}, home: '/h' })).toEqual([
      path.join('/h', 'Library/Caches/ms-playwright'),
      path.join('/h', '.cache/ms-playwright'),
      '/root/.cache/ms-playwright',
    ])
  })

  it('expects firefox.exe on Windows', () => {
    expect(firefoxSuffixes('win32')).toEqual([path.join('firefox', 'firefox.exe')])
  })
})

describe('which Firefox is used', () => {
  it('finds the newest build on Windows, by its .exe', () => {
    const local = tree([
      'ms-playwright/firefox-1490/firefox/firefox.exe',
      'ms-playwright/firefox-1495/firefox/firefox.exe',
      'ms-playwright/chromium-1200/chrome-win/chrome.exe',
    ])
    expect(findFirefox({ platform: 'win32', env: { LOCALAPPDATA: local }, home: '/nowhere' })).toBe(
      path.join(local, 'ms-playwright', 'firefox-1495', 'firefox', 'firefox.exe'),
    )
  })

  it('finds the macOS bundle in the home cache', () => {
    const home = tree(['Library/Caches/ms-playwright/firefox-1495/firefox/Nightly.app/Contents/MacOS/firefox'])
    expect(findFirefox({ platform: 'darwin', env: {}, home })).toBe(
      path.join(home, 'Library/Caches/ms-playwright/firefox-1495/firefox/Nightly.app/Contents/MacOS/firefox'),
    )
  })

  it('lets FIREFOX_BINARY win', () => {
    expect(findFirefox({ platform: 'win32', env: { FIREFOX_BINARY: 'C:\\ff\\firefox.exe' } })).toBe('C:\\ff\\firefox.exe')
  })

  it('says what to run when there is none', () => {
    const empty = tree([])
    expect(() => findFirefox({ platform: 'win32', env: { LOCALAPPDATA: empty }, home: empty })).toThrow(
      /playwright install firefox/,
    )
  })
})
