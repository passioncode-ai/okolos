import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The proxy's host name, read from `apps/extension/src/config.ts` where `PROXY_ORIGIN` lives
 * (B-235). A plain tool cannot import that TypeScript file on the Node CI runs, and a second
 * copy of the address would be a second place to change it; so the line is read and parsed.
 *
 * `tools/firefox-e2e.mjs` resolves this host to 127.0.0.1 in Firefox, so the extension's feed
 * pull fails as the Chromium suite's 503 makes it fail, instead of fetching the published feed
 * from CI and making a run depend on what was published that day.
 */
const CONFIG = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'apps/extension/src/config.ts')

/** The host of `PROXY_ORIGIN` in `source`; throws when the line is not there, never guesses. */
export function proxyHostIn(source) {
  const match = /export const PROXY_ORIGIN = '([^']+)'/.exec(source)
  if (match === null) throw new Error('PROXY_ORIGIN is not declared as a string in apps/extension/src/config.ts')
  return new URL(match[1]).hostname
}

export function proxyHost(file = CONFIG) {
  return proxyHostIn(readFileSync(file, 'utf8'))
}
