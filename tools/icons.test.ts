import { readFileSync } from 'node:fs'
import path from 'node:path'
import { inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'

// @ts-expect-error — a plain .mjs generator, deliberately untyped
import { BACKGROUND, GEOMETRY, RING, SIZES, VARIANTS, draw, outputs } from './icons.mjs'

/**
 * The constraint a toolbar icon actually has to satisfy.
 *
 * `tools/manifest.test.ts` asserts the committed PNGs equal what `draw()`
 * produces — which keeps the binaries honest and says nothing about whether the
 * mark can be seen. It agrees with whatever the generator decides, so a change
 * making both colours dark would leave the icon invisible on a dark toolbar
 * with every gate green.
 *
 * One artwork is rendered against a light toolbar and a dark one at the same
 * moment, so it cannot follow a theme token — the colours here are the icon's
 * own, and this is the rule that makes that safe. WCAG 2.2 (1.4.11) asks 3:1
 * for a graphical object needed to understand the content, and a product's
 * only mark in the browser chrome is exactly that.
 */

/** Chrome's own toolbar surfaces, light and dark. */
const TOOLBARS = {
  'light toolbar': [0xff, 0xff, 0xff],
  'light toolbar, grey': [0xf1, 0xf3, 0xf4],
  'dark toolbar': [0x29, 0x2a, 0x2d],
  'dark toolbar, deeper': [0x20, 0x21, 0x24],
} as const

const MINIMUM = 3

function luminance([r, g, b]: readonly number[]): number {
  const channel = (raw: number): number => {
    const c = (raw as number) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r as number) + 0.7152 * channel(g as number) + 0.0722 * channel(b as number)
}

function contrast(a: readonly number[], b: readonly number[]): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return ((hi as number) + 0.05) / ((lo as number) + 0.05)
}

describe('the mark stays visible on both toolbars', () => {
  it('reads the generator, so an empty import cannot pass as agreement', () => {
    expect(BACKGROUND).toHaveLength(3)
    expect(RING).toHaveLength(3)
  })

  it('keeps its own two colours legible against each other', () => {
    // If the ring stopped standing out from the plate there would be no mark
    // to be visible, whatever the toolbar behind it.
    expect(contrast(BACKGROUND as number[], RING as number[])).toBeGreaterThanOrEqual(MINIMUM)
  })

  for (const [name, toolbar] of Object.entries(TOOLBARS)) {
    it(`is carried by at least one of its colours against the ${name}`, () => {
      const plate = contrast(BACKGROUND as number[], toolbar)
      const ring = contrast(RING as number[], toolbar)
      // Either is enough, and which one changes by toolbar: on light the dark
      // tile carries the silhouette at 20.02:1 while the gold is faint against
      // the chrome at 1.45:1, and on dark they swap (tile 1.39:1, gold 9.90:1).
      // Requiring both would fail an icon that works.
      expect(
        Math.max(plate, ring),
        `neither colour clears ${MINIMUM}:1 on the ${name} — plate ${plate.toFixed(2)}:1, ring ${ring.toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(MINIMUM)
    })
  }
})

/** A PNG's rows, unfiltered — the generator writes filter 0 on every row. */
function rows(png: Buffer): { width: number; at: (x: number, y: number) => number[] } {
  const width = png.readUInt32BE(16)
  const raw = inflateOf(png)
  return {
    width,
    at: (x, y) => {
      const o = y * (width * 4 + 1) + 1 + x * 4
      return [raw[o] as number, raw[o + 1] as number, raw[o + 2] as number, raw[o + 3] as number]
    },
  }
}

/**
 * How much of a pixel is gold, 0..1, read on the green channel — the one where
 * the tile (7) and the gold (210) are furthest apart.
 */
const gold = (pixel: number[]): number =>
  ((pixel[1] as number) - (BACKGROUND[1] as number)) / ((RING[1] as number) - (BACKGROUND[1] as number))

describe('the mark reads as a ring around a dot at every size', () => {
  /**
   * The mark's one idea is that the ring is closed: a gap at 16px reads as the
   * letter C (see the header of tools/icons.mjs). Looking settles it once; this
   * keeps it settled. Every degree of the ring's centre line is sampled in the
   * drawn pixels, the space between ring and dot must stay tile-dark (or the
   * two fuse into a blob), and the dot must be there.
   */
  const cases = (VARIANTS as string[]).flatMap((variant) => (SIZES as number[]).map((size) => [variant, size] as const))

  it('covers both members of the family at all four sizes', () => {
    expect(cases).toHaveLength(8)
  })

  for (const [variant, size] of cases) {
    const g = GEOMETRY[variant][size] as { cx: number; cy: number; outer: number; inner: number; dot: number }
    const k = size / 256
    const png = rows(draw(size, variant) as Buffer)
    const around = (radius: number): number[] =>
      Array.from({ length: 360 }, (_, degree) => {
        const t = (degree * Math.PI) / 180
        return gold(png.at(Math.floor((g.cx + radius * Math.cos(t)) * k), Math.floor((g.cy + radius * Math.sin(t)) * k)))
      })

    it(`${variant} ${size}px: the ring has no gap`, () => {
      expect(Math.min(...around((g.outer + g.inner) / 2))).toBeGreaterThanOrEqual(0.85)
    })

    it(`${variant} ${size}px: ring and dot stay apart`, () => {
      expect(Math.max(...around((g.dot + g.inner) / 2))).toBeLessThanOrEqual(0.15)
    })

    it(`${variant} ${size}px: the dot is drawn`, () => {
      expect(gold(png.at(Math.floor(g.cx * k), Math.floor(g.cy * k)))).toBeGreaterThanOrEqual(0.7)
    })
  }
})

describe('the brand files are what the generator draws', () => {
  /**
   * ADR-0007: a generated file is compared to its generator. The toolbar PNGs
   * are held in tools/manifest.test.ts beside the manifest entries that name
   * them; this holds the rest — the SVG sources the site can reuse, the Okolos
   * Bridge set and the store promo tile. PNGs are compared by pixels, not
   * bytes, for the reason given there: deflate is not byte-stable across zlib
   * builds.
   */
  const root = path.resolve(import.meta.dirname, '..')
  const files = [...(outputs() as Map<string, () => Buffer | string>)].filter(
    ([file]) => !file.startsWith('apps/extension/icons/'),
  )

  it('has brand files to compare, so an empty list cannot pass', () => {
    expect(files.map(([file]) => file)).toEqual(
      expect.arrayContaining([
        'docs/brand/marks/okolos-mark.svg',
        'docs/brand/marks/okolos-bridge-mark.svg',
        'docs/brand/marks/okolos-promo-440x280.png',
      ]),
    )
  })

  for (const [file, make] of files) {
    it(`${file} matches tools/icons.mjs`, () => {
      const committed = readFileSync(path.join(root, file))
      const drawn = make()
      const same = file.endsWith('.svg')
        ? committed.toString('utf8') === drawn
        : inflateOf(committed).equals(inflateOf(drawn as Buffer))
      expect(same, `${file} differs from tools/icons.mjs — run \`node tools/icons.mjs\``).toBe(true)
    })
  }
})

/** A PNG's decompressed image data: its pixels, not its packaging. */
function inflateOf(png: Buffer): Buffer {
  const idat: Buffer[] = []
  let at = 8
  while (at + 8 <= png.length) {
    const length = png.readUInt32BE(at)
    const type = png.toString('ascii', at + 4, at + 8)
    if (type === 'IDAT') idat.push(png.subarray(at + 8, at + 8 + length))
    at += 12 + length
    if (type === 'IEND') break
  }
  return inflateSync(Buffer.concat(idat))
}
