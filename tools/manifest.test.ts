import { inflateSync } from 'node:zlib'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The manifests are the security surface a store reviewer and a user actually
 * read. A permission that appears without anyone noticing is the failure this
 * file exists to prevent, so the allowed list is written here too and the two
 * have to agree.
 */

const app = path.join(process.cwd(), 'apps/extension')

function manifest(browser: 'chrome' | 'firefox'): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(app, `manifest.${browser}.json`), 'utf8')) as Record<
    string,
    unknown
  >
}

/**
 * Everything the product needs today, and nothing that anticipates a later
 * module. `offscreen` is Chrome-only and arrives with the classifier host: a
 * service worker has no DOM, so there is nowhere else a model could run.
 */
const ALLOWED_PERMISSIONS = [
  'storage',
  'alarms',
  'activeTab',
  // Both arrive with the phishing block: stopping a page after it has rendered
  // means its scripts have already run.
  'declarativeNetRequest',
  'webNavigation',
  // The only moment a dangerous file can be stopped is before it is written.
  'downloads',
  // Reading what the other extensions may do, to notice the update that widens it.
  'management',
]
/**
 * Permissions Chrome's manifest may hold and Firefox's may not.
 *
 * `offscreen` was the only entry and it is gone: the third stage is not shipped, so the
 * document it would have hosted is not either, and a permission that reaches store review
 * without being used is a cost with no benefit (B-50). The list stays because the *rule*
 * is what this gate is about — the two manifests differ on purpose and the difference is
 * named here — and an empty list says "no exceptions today" rather than "we stopped
 * checking".
 */
const CHROME_ONLY_PERMISSIONS: readonly string[] = []

/**
 * What belongs to the agents' extension and never to this one (ADR-0016).
 *
 * Okolos protects a person; Okolos Bridge lets agents into that person's browser.
 * `debugger` cannot be an optional permission, so the day it lands in this manifest
 * every installed copy shows "read and change all your data" again — on a security
 * product, the worst signal there is. The bridge is a second extension in this
 * repository instead, and these keys are the line between the two.
 *
 * `externally_connectable` is on the list as a key, not a permission: the two
 * extensions meet through the local agent, never page-to-extension or
 * extension-to-extension, which is the channel ClaudeBleed went through.
 */
const BRIDGE_ONLY_PERMISSIONS = ['debugger', 'nativeMessaging', 'tabGroups', 'sidePanel', 'history', 'bookmarks']
const BRIDGE_ONLY_KEYS = ['externally_connectable', 'side_panel']

function bridgeSurfaceIn(m: Record<string, unknown>): string[] {
  const asked = [
    ...((m.permissions as string[] | undefined) ?? []),
    ...((m.optional_permissions as string[] | undefined) ?? []),
  ]
  return [...BRIDGE_ONLY_PERMISSIONS.filter((p) => asked.includes(p)), ...BRIDGE_ONLY_KEYS.filter((k) => k in m)]
}

describe('the line between Okolos and Okolos Bridge (ADR-0016)', () => {
  for (const browser of ['chrome', 'firefox'] as const) {
    it(`${browser}: the people's extension carries none of the bridge's permissions or keys`, () => {
      expect(bridgeSurfaceIn(manifest(browser)), 'this belongs to Okolos Bridge, see docs/adr/0016').toEqual([])
    })
  }

  it('would notice the bridge creeping in — the check is not blind', () => {
    const crept = { permissions: ['storage', 'debugger'], optional_permissions: ['history'], externally_connectable: {} }
    expect(bridgeSurfaceIn(crept)).toEqual(['debugger', 'history', 'externally_connectable'])
  })
})

describe('what the extension asks for', () => {
  for (const browser of ['chrome', 'firefox'] as const) {
    it(`${browser}: requests only the permissions the skeleton needs`, () => {
      const expected =
        browser === 'chrome'
          ? ['storage', 'alarms', 'activeTab', ...CHROME_ONLY_PERMISSIONS, 'declarativeNetRequest', 'webNavigation', 'downloads', 'management']
          : ['storage', 'alarms', 'activeTab', 'declarativeNetRequest', 'webNavigation', 'downloads', 'management']
      expect(manifest(browser).permissions).toEqual(expected)
      expect(ALLOWED_PERMISSIONS.every((p) => expected.includes(p))).toBe(true)
    })

    /**
     * The page-facing surface, and nothing was checking it.
     *
     * `web_accessible_resources` is the list of files **any** page may reach. One file is on
     * it, and it has to be: the blocker redirects a tab to `interstitial.html`, and that
     * redirect is the block. A second file added here would be a new opening nobody
     * reviewed, and until 2026-08-21 no test read this key at all.
     *
     * `use_dynamic_url` is Chrome-only and is the difference between "any page can embed our
     * block page" and "the address answers only to a per-session URL a page cannot learn".
     * Firefox does not support the flag, which is why the two manifests differ here and why
     * the extension also refuses to draw when it is not the top document — the browser-level
     * defence is not available on both engines (B-94, B-95).
     */
    it(`${browser}: opens exactly one file to the web, and only the one the blocker needs`, () => {
      /**
       * The expectation branches; the assertion does not. `tools/test-quality.test.ts`
       * refuses a test whose `expect` sits inside an `if`, and it is right: a conditional
       * assertion is one that can quietly assert nothing. Same shape as the permissions
       * check above.
       */
      const expected =
        browser === 'chrome'
          ? // Chrome-only: the resource then answers to a per-session address a page cannot
            // learn, so an embed by the fixed address never loads.
            [{ resources: ['interstitial.html'], matches: ['<all_urls>'], use_dynamic_url: true }]
          : // Firefox has no such flag, and declaring it would be a claim this engine cannot
            // keep. The page's own refusal to draw when framed is what holds here (B-94).
            [{ resources: ['interstitial.html'], matches: ['<all_urls>'] }]

      expect(
        manifest(browser).web_accessible_resources,
        'this is the whole list of files any page may reach',
      ).toEqual(expected)
    })

    it(`${browser}: asks for host access only to the web, and only http(s)`, () => {
      // Broad host access arrived with the feature that needs it — blocking a
      // page before it renders — and it is bounded: no file://, no other
      // schemes, nothing the store listing does not explain.
      expect(manifest(browser).host_permissions).toEqual(['http://*/*', 'https://*/*'])
    })

    it(`${browser}: is manifest v3`, () => {
      expect(manifest(browser).manifest_version).toBe(3)
    })
  }

  it('keeps both browsers on the same version', () => {
    expect(manifest('chrome').version).toBe(manifest('firefox').version)
  })

  it('runs the content script in every frame — injections hide in iframes too', () => {
    for (const browser of ['chrome', 'firefox'] as const) {
      const scripts = manifest(browser).content_scripts as Array<{ all_frames: boolean }>
      expect(scripts[0]?.all_frames).toBe(true)
    }
  })

  it('uses the background form each browser actually supports', () => {
    const chrome = manifest('chrome').background as Record<string, unknown>
    const firefox = manifest('firefox').background as Record<string, unknown>
    expect(chrome.service_worker).toBe('background.js')
    expect(firefox.scripts).toEqual(['background.js'])
  })

  it('declares minimum browsers that can run the crypto the feed check needs', () => {
    /**
     * The two facts that drifted apart, tied together so they cannot again.
     *
     * The design named `@noble/ed25519`, which runs on any engine. The
     * implementation moved to WebCrypto, which does not. Nobody moved the
     * manifests, so they went on inviting Chrome 116 and Firefox 128 — and on
     * that whole range `importKey` rejects, every feed update is refused,
     * `currentFeed()` stays null and the number of blocking rules is zero. The
     * product installed, ran, showed no error, and blocked nothing.
     *
     * The floors come from caniuse's data for `SubtleCrypto.verify` with Ed25519
     * (Chrome and Edge 137, Firefox 129, Safari 17.0), read 2026-08-19. The
     * algorithm is read out of the source rather than repeated here, so swapping
     * the primitive for one with a different floor fails this instead of shipping.
     */
    const FLOOR: Record<string, { chrome: number; firefox: number; source: string }> = {
      Ed25519: {
        chrome: 137,
        firefox: 129,
        source: 'caniuse mdn-api_subtlecrypto_verify_ed25519, read 2026-08-19',
      },
    }

    const verifier = readFileSync(path.join(app, 'src/background/feeds.ts'), 'utf8')
    const algorithm = /export const SIGNATURE_ALGORITHM = '([^']+)'/.exec(verifier)?.[1]
    expect(algorithm, 'feeds.ts no longer names the signature algorithm').toBeDefined()
    const floor = FLOOR[algorithm as string]
    expect(
      floor,
      `feeds.ts signs with ${algorithm}, and no browser floor is recorded for it. ` +
        `Add one with its source before shipping — a primitive whose support nobody ` +
        `looked up is a primitive some declared browser cannot run.`,
    ).toBeDefined()

    const chromeFloor = Number(manifest('chrome').minimum_chrome_version)
    const gecko = (
      manifest('firefox').browser_specific_settings as { gecko: { strict_min_version: string } }
    ).gecko
    const firefoxFloor = Number.parseFloat(gecko.strict_min_version)

    expect(Number.isFinite(chromeFloor), 'chrome manifest declares no usable minimum').toBe(true)
    expect(Number.isFinite(firefoxFloor), 'firefox manifest declares no usable minimum').toBe(true)
    expect(
      chromeFloor,
      `chrome invites ${chromeFloor}, where ${algorithm} does not exist (${floor?.source})`,
    ).toBeGreaterThanOrEqual(floor?.chrome as number)
    expect(
      firefoxFloor,
      `firefox invites ${firefoxFloor}, where ${algorithm} does not exist (${floor?.source})`,
    ).toBeGreaterThanOrEqual(floor?.firefox as number)
  })

  it('pins a Firefox extension id, so updates cannot be hijacked by a rebuild', () => {
    const settings = manifest('firefox').browser_specific_settings as {
      gecko: { id: string }
    }
    expect(settings.gecko.id).toMatch(/@/)
  })
})


/**
 * A PNG's pixels, not its packaging.
 *
 * This gate compared whole files until 2026-08-13, and it passed on every
 * machine that had run the generator — because the generator's `deflateSync`
 * does not emit identical bytes across zlib builds. The committed files were
 * drawn on macOS; the first CI run that ever reached this test was on Linux,
 * and it reported the icon as changed when not one pixel had moved.
 *
 * The promise was never about compression. It is that the committed artwork is
 * the artwork this script draws, and that survives being re-packed.
 */
function pixels(png: Buffer): Buffer {
  const idat: Buffer[] = []
  let at = 8 // past the PNG signature
  while (at + 8 <= png.length) {
    const length = png.readUInt32BE(at)
    const type = png.toString('ascii', at + 4, at + 8)
    if (type === 'IDAT') idat.push(png.subarray(at + 8, at + 8 + length))
    at += 12 + length // length + type + data + crc
    if (type === 'IEND') break
  }
  return inflateSync(Buffer.concat(idat))
}

describe('the icon the browser and the store will actually show', () => {
  /**
   * `"icons": {}` shipped in both manifests until 2026-08-08, and the project
   * carried no image file at all. The browser draws a placeholder and the store
   * refuses the upload — a defect visible to every user before they open
   * anything.
   *
   * Existence is not the check. A file named `128.png` that is 64 pixels wide
   * passes an existence test and fails in the listing, so the size is read out
   * of the PNG header. And the committed bytes are compared against what the
   * generator produces, because an icon nobody can regenerate is the drift this
   * repository already refuses for its wireframes.
   */
  const iconRoot = path.join(app, 'icons')

  /** Width and height out of the IHDR chunk, which is always the first one. */
  const dimensions = (file: string): { width: number; height: number } => {
    const png = readFileSync(file)
    expect(png.subarray(1, 4).toString('latin1'), `${file} is not a PNG`).toBe('PNG')
    return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
  }

  for (const target of ['chrome', 'firefox']) {
    const manifest = JSON.parse(
      readFileSync(path.join(app, `manifest.${target}.json`), 'utf8'),
    ) as { icons?: Record<string, string>; action?: { default_icon?: Record<string, string> } }

    it(`${target} declares icons at all`, () => {
      expect(Object.keys(manifest.icons ?? {}).length).toBeGreaterThanOrEqual(4)
    })

    it(`${target} declares a toolbar icon, so the button is not a placeholder`, () => {
      expect(Object.keys(manifest.action?.default_icon ?? {}).length).toBeGreaterThan(0)
    })

    it(`${target} names files that exist and are the size they claim`, () => {
      const declared = { ...(manifest.icons ?? {}), ...(manifest.action?.default_icon ?? {}) }
      for (const [size, file] of Object.entries(declared)) {
        const onDisk = path.join(app, file)
        expect(existsSync(onDisk), `${target} names ${file}, which is not there`).toBe(true)
        expect(dimensions(onDisk), `${file} is declared as ${size}`).toEqual({
          width: Number(size),
          height: Number(size),
        })
      }
    })
  }

  it('carries exactly the image the generator draws', async () => {
    // @ts-expect-error — a plain .mjs tool, imported for the drawing it does.
    const { SIZES, draw } = await import('./icons.mjs')
    for (const size of SIZES) {
      const committed = readFileSync(path.join(iconRoot, `${size}.png`))
      expect(
        pixels(committed).equals(pixels(draw(size) as Buffer)),
        `icons/${size}.png differs from tools/icons.mjs — run \`node tools/icons.mjs\``,
      ).toBe(true)
    }
  })

  it('would notice a changed pixel — the comparison is not blind', () => {
    // The rule above compares decompressed pixels, so it has to be shown that
    // it still sees a difference. A comparison that unpacks two files into
    // empty buffers agrees with itself perfectly.
    const one = readFileSync(path.join(iconRoot, '16.png'))
    const other = readFileSync(path.join(iconRoot, '32.png'))
    expect(pixels(one).length).toBeGreaterThan(0)
    expect(pixels(one).equals(pixels(other))).toBe(false)
  })
})
