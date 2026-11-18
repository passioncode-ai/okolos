import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * Every permission is earned, and every API asked for is permitted.
 *
 * `tools/manifest.test.ts` already asserts the permission **list**, which catches an
 * addition nobody noticed. What it cannot catch is the other direction: a feature removed
 * while its permission stays. The list still matches the expectation, the store listing
 * still explains a capability the product no longer uses, and the user still reads it —
 * "a permission that reaches store review without being used is a cost with no benefit"
 * is that gate's own comment (B-50), and nothing was checking it.
 *
 * The reverse is worth more. An API the code calls without the matching permission fails
 * at runtime, silently, in whatever code path touches it — and on a path nobody exercises
 * in a browser test that is invisible until somebody's machine.
 *
 * Measured 2026-08-20: all seven permissions are used. This exists so that stays true.
 */

const root = path.resolve(import.meta.dirname, '..')

/**
 * Which browser API each permission unlocks.
 *
 * One entry is not its own name and that is the interesting one: `activeTab` does not
 * gate a `chrome.activeTab` namespace — it grants access to the tab a person is looking
 * at, exercised here through `tabs`. Everything else is named after the namespace it
 * opens.
 */
const UNLOCKS: Readonly<Record<string, string>> = {
  storage: 'storage',
  alarms: 'alarms',
  activeTab: 'tabs',
  declarativeNetRequest: 'declarativeNetRequest',
  webNavigation: 'webNavigation',
  downloads: 'downloads',
  management: 'management',
}

/**
 * Namespaces that need no permission at all.
 *
 * `runtime` and `i18n` are available to every extension; `action` is the toolbar button,
 * which MV3 grants without asking. Listed rather than inferred, because "no permission
 * needed" is a claim about the platform and it belongs written down where the check can
 * be read.
 */
const FREE: readonly string[] = [
  'runtime',
  'i18n',
  'action',
  // `permissions` (getAll, request, remove) is callable by every extension; what the adapter
  // reads through it is Firefox's built-in data consent, which the Firefox manifest declares
  // in `browser_specific_settings.gecko.data_collection_permissions`, not in `permissions`
  // (B-199). The Chrome adapter does not touch it.
  'permissions',
]

function manifest(browser: 'chrome' | 'firefox'): { permissions: string[] } {
  return JSON.parse(
    readFileSync(path.join(root, `apps/extension/manifest.${browser}.json`), 'utf8'),
  ) as { permissions: string[] }
}

/** The adapter is the single place the product touches a browser API (ADR-0003's shape). */
function adapter(): string {
  return readFileSync(path.join(root, 'packages/platform/src/adapter.ts'), 'utf8')
}

/** Namespaces the adapter actually reaches for, as `api.<name>`. */
function touched(): Set<string> {
  const source = adapter()
  return new Set(
    [...source.matchAll(/\bapi\.([a-zA-Z]+)/g)]
      .map((m) => m[1] as string)
      // `api.i18n` reads as `api.i` when the next character is a digit, which the pattern
      // cannot see. Normalised rather than left to look like an unknown namespace.
      .map((name) => (name === 'i' ? 'i18n' : name)),
  )
}

describe('a permission is asked for because something uses it', () => {
  it('is looking at a real manifest and a real adapter', () => {
    expect(manifest('chrome').permissions.length).toBeGreaterThan(3)
    expect(touched().size).toBeGreaterThan(3)
  })

  for (const browser of ['chrome', 'firefox'] as const) {
    it(`${browser}: every permission maps to a namespace this file knows`, () => {
      // A permission added without an entry here would otherwise skip the check below.
      const unmapped = manifest(browser).permissions.filter((p) => UNLOCKS[p] === undefined)
      expect(unmapped, 'add these to UNLOCKS, with what they unlock').toEqual([])
    })

    it(`${browser}: every permission it asks for is used by the code`, () => {
      const used = touched()
      const idle = manifest(browser)
        .permissions.filter((p) => UNLOCKS[p] !== undefined)
        .filter((p) => !used.has(UNLOCKS[p] as string))
      expect(idle, 'asked for, explained to the user, and never called').toEqual([])
    })
  }

  it('calls no API it has not asked for', () => {
    const permitted = new Set(
      manifest('chrome')
        .permissions.map((p) => UNLOCKS[p])
        .filter((n): n is string => n !== undefined),
    )
    const unpermitted = [...touched()].filter((n) => !permitted.has(n) && !FREE.includes(n))
    expect(unpermitted, 'these would fail at runtime, silently, on whoever hits them').toEqual([])
  })
})
