#!/usr/bin/env node
/**
 * The extension's icon, drawn rather than pasted.
 *
 *   node tools/icons.mjs        # writes apps/extension/icons/*.png and docs/brand/marks/*
 *
 * A binary nobody can regenerate is the same drift as a hand-written document
 * beside generated ones: the day the mark changes, every file has to change
 * together and one of them will not. Here every size, the SVG source and the
 * store's promo tile are derived from one description (`GEOMETRY` below), and
 * tests check that the committed files match what this script produces:
 * `tools/manifest.test.ts` for the toolbar icons, `tools/icons.test.ts` for the
 * rest.
 *
 * The mark: a closed shield around a dot. `около` is "around" — the shield is the
 * perimeter the product keeps, the dot is the person standing inside it.
 *
 * It was a closed ring around a dot until 2026-10-06. Beside Observatory's mark
 * (a ring, a dot and a satellite dot) on the same tile, in the same gold, the
 * two read as one product; the operator asked for a different sign. The shield
 * keeps the idea — a closed perimeter, the person inside — and says what the
 * product is (browser security) at 16px, where a ring only says "circle".
 *
 * The perimeter stays closed for the reason the ring was: drawn with a gap
 * first, to mean "the part left to you", it read as the letter C at 16px.
 *
 * Since 2026-10-05 the mark wears the PassionCode.ai product tile, like
 * Switchboard, Fabric Dashboards, Fabric Inbox and Observatory on
 * passioncode.ai (`assets/*-mark.svg` in passioncode-ai/passioncode-ai.github.io):
 * a gold glyph on the dark tile, in a 256 viewBox, tile at 8..248 with corner
 * radius 58 and a 2-unit hairline inside its edge. The tile numbers below are
 * those files' numbers, not an approximation of them.
 *
 * One description, two members of a family. `okolos` is the people's extension;
 * `bridge` is Okolos Bridge, the agents' extension (okolos ADR-0018). Bridge is
 * the same shield and dot, smaller and moved up and left, with a short bar at
 * the lower right: the cursor of the terminal the agent comes from, standing
 * outside the perimeter.
 *
 * Optical sizes. A 16px icon is not the 128px one shrunk: at 16 a 24-unit
 * stroke is 1.5px and turns to grey, so the small sizes carry their own
 * geometry, heavier and with edges on whole pixels. Every entry is in the same
 * 256-unit space as the SVG, so each can be compared to it directly.
 *
 * Drawn with plain arithmetic and supersampling, so it survives 16px without a
 * font, an SVG rasteriser or a dependency.
 */
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const OUT = path.join(root, 'apps/extension/icons')
export const MARKS = path.join(root, 'docs/brand/marks')
export const SIZES = [16, 32, 48, 128]
export const VARIANTS = ['okolos', 'bridge']

/**
 * The tile and the glyph colours: `--pc-bg` and `--pc-accent` of the
 * PassionCode.ai design system (`design-system/tokens.css`), and the hairline
 * every product mark draws inside the tile's edge.
 *
 * A toolbar icon is one fixed artwork rendered against a light toolbar and a
 * dark one at the same moment, so it cannot follow a theme token. What governs
 * is contrast, and the mark works by handing the silhouette over between the
 * two colours — measured (WCAG relative luminance), not asserted:
 *
 *   gold against the tile            13.81:1
 *   against a light toolbar (#ffffff)  tile 20.02:1   gold  1.45:1
 *   against a dark toolbar  (#292a2d)  tile  1.39:1   gold  9.90:1
 *
 * On light the dark tile carries the shape and the gold ring sits inside it; on
 * dark the tile nearly disappears and the gold ring alone carries it.
 * `tools/icons.test.ts` holds the rule: at least one of the two clears 3:1
 * (WCAG 2.2 non-text contrast) against every toolbar, and gold against the tile
 * clears it too.
 */
export const BACKGROUND = [0x0a, 0x07, 0x0d]
export const GOLD = [0xff, 0xd2, 0x1a]
/** @deprecated the glyph colour kept under its old name for importers; use GOLD. */
export const RING = GOLD
export const HAIRLINE = [0x34, 0x2b, 0x3a]

const hex = (rgb) => `#${rgb.map((c) => c.toString(16).padStart(2, '0')).join('')}`

/** The product tile, from passioncode.ai's marks: <rect x=8 width=240 rx=58>. */
const TILE = { inset: 8, radius: 58, hairline: 2 }

/**
 * The glyph per variant and size, in 256 units.
 *
 * The shield is a stroked centre line: a flat top from `y0` with rounded
 * shoulders (radius `c`), straight sides down to `y1`, then two curves meeting
 * at the tip `y2`; half-width `w`, stroke width `s`, round joins. `dot` is the
 * person inside (`cy`, radius `r`); `bar` a capsule from x1 to x2 at height y
 * with half-thickness r. `128` is the master: the SVG is written from it, so the
 * largest PNG and the SVG are the same drawing. The smaller entries put their
 * edges on whole pixels — at 16, 16 units is one pixel: the 2px stroke is
 * centred on a pixel boundary and the dot covers whole pixels.
 */
export const GEOMETRY = {
  okolos: {
    128: { cx: 128, y0: 66, w: 56, y1: 118, y2: 198, c: 18, s: 24, dot: { cy: 124, r: 20 } },
    48: { cx: 128, y0: 64, w: 58.67, y1: 117.33, y2: 202.67, c: 16, s: 26.67, dot: { cy: 125.33, r: 21.33 } },
    32: { cx: 128, y0: 64, w: 64, y1: 120, y2: 208, c: 16, s: 32, dot: { cy: 128, r: 24 } },
    16: { cx: 128, y0: 48, w: 80, y1: 128, y2: 224, c: 16, s: 32, dot: { cy: 128, r: 32 } },
  },
  bridge: {
    128: { cx: 112, y0: 58, w: 50, y1: 104, y2: 176, c: 16, s: 22, dot: { cy: 110, r: 18 }, bar: { x1: 166, x2: 200, y: 196, r: 11 } },
    48: { cx: 112, y0: 58.67, w: 53.33, y1: 106.67, y2: 181.33, c: 16, s: 26.67, dot: { cy: 112, r: 18.67 }, bar: { x1: 170.67, x2: 202.67, y: 202.67, r: 13.33 } },
    32: { cx: 112, y0: 56, w: 56, y1: 112, y2: 184, c: 16, s: 32, dot: { cy: 112, r: 16 }, bar: { x1: 168, x2: 200, y: 204, r: 16 } },
    16: { cx: 112, y0: 48, w: 64, y1: 112, y2: 184, c: 16, s: 32, dot: { cy: 112, r: 16 }, bar: { x1: 176, x2: 208, y: 208, r: 16 } },
  },
}

/** How far down the side the lower curves pull their control point, as a share of y1..y2. */
const TIP_PULL = 0.55

/**
 * The shield's centre line as path commands, shared by the SVG and the raster:
 * one description, so the two cannot drift apart.
 */
function shieldCommands(g) {
  const { cx, y0, w, y1, y2, c } = g
  const yq = y1 + TIP_PULL * (y2 - y1)
  return [
    ['M', [cx, y0]],
    ['L', [cx + w - c, y0]],
    ['Q', [cx + w, y0], [cx + w, y0 + c]],
    ['L', [cx + w, y1]],
    ['Q', [cx + w, yq], [cx, y2]],
    ['Q', [cx - w, yq], [cx - w, y1]],
    ['L', [cx - w, y0 + c]],
    ['Q', [cx - w, y0], [cx - w + c, y0]],
    ['Z', [cx, y0]],
  ]
}

/** The centre line flattened to a closed polyline, `steps` segments per curve. */
export function centreline(g, steps = 20) {
  const points = []
  let at = null
  for (const [op, ...args] of shieldCommands(g)) {
    if (op === 'M') { at = args[0]; points.push(at); continue }
    if (op === 'L' || op === 'Z') { at = args[0]; points.push(at); continue }
    const [ctrl, end] = args
    for (let i = 1; i <= steps; i += 1) {
      const t = i / steps
      const u = 1 - t
      points.push([u * u * at[0] + 2 * u * t * ctrl[0] + t * t * end[0], u * u * at[1] + 2 * u * t * ctrl[1] + t * t * end[1]])
    }
    at = end
  }
  return points
}

const lines = new WeakMap()
/**
 * Segments of the centre line, bucketed in a grid of `cell`-unit squares so a
 * sample only measures the few segments near it — the raster takes millions of
 * samples, and every one against the whole line made a 128px icon take seconds.
 * Cached per geometry entry.
 */
function segmentsOf(g) {
  let cached = lines.get(g)
  if (!cached) {
    const points = centreline(g)
    const half = g.s / 2
    const cell = 16
    const grid = new Map()
    for (let i = 1; i < points.length; i += 1) {
      const a = points[i - 1]
      const b = points[i]
      const x0 = Math.floor((Math.min(a[0], b[0]) - half) / cell)
      const x1 = Math.floor((Math.max(a[0], b[0]) + half) / cell)
      const y0 = Math.floor((Math.min(a[1], b[1]) - half) / cell)
      const y1 = Math.floor((Math.max(a[1], b[1]) + half) / cell)
      for (let gx = x0; gx <= x1; gx += 1) {
        for (let gy = y0; gy <= y1; gy += 1) {
          const key = gx * 4096 + gy
          if (!grid.has(key)) grid.set(key, [])
          grid.get(key).push([a, b])
        }
      }
    }
    cached = { cell, grid }
    lines.set(g, cached)
  }
  return cached
}

/** Distance from (x, y) to the segment a–b. */
function toSegment(x, y, [ax, ay], [bx, by]) {
  const dx = bx - ax
  const dy = by - ay
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)))
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy))
}

/** Samples per pixel along each axis. 8×8 levels of coverage at every size. */
const SS = 8

function crc32(bytes) {
  let crc = ~0
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xed_b8_83_20 & -(crc & 1))
  }
  return ~crc >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

/** RGBA pixels → a PNG file. Colour type 6, 8 bits, no interlace. */
function png(width, height, rgba) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0 // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** Inside a rounded rectangle from `lo` to `hi` on both axes, corner radius `r`. */
function inRoundedSquare(x, y, lo, hi, r) {
  const dx = Math.max(lo + r - x, 0, x - (hi - r))
  const dy = Math.max(lo + r - y, 0, y - (hi - r))
  return Math.hypot(dx, dy) <= r
}

/** Inside the glyph: the shield's stroke (round joins), the dot, and the bar if there is one. */
function inGlyph(g, x, y) {
  if (Math.hypot(x - g.cx, y - g.dot.cy) <= g.dot.r) return true
  const { cell, grid } = segmentsOf(g)
  const near = grid.get(Math.floor(x / cell) * 4096 + Math.floor(y / cell))
  if (near) {
    const half = g.s / 2
    for (const [a, b] of near) if (toSegment(x, y, a, b) <= half) return true
  }
  if (!g.bar) return false
  const { x1, x2, y: by, r } = g.bar
  return Math.hypot(x - Math.min(Math.max(x, x1), x2), y - by) <= r
}

/**
 * One sample of the tiled mark at (x, y) in 256 units: the colour, or null
 * outside the tile.
 */
function sample(g, x, y) {
  const { inset, radius, hairline } = TILE
  if (!inRoundedSquare(x, y, inset, 256 - inset, radius)) return null
  if (inGlyph(g, x, y)) return GOLD
  if (!inRoundedSquare(x, y, inset + hairline, 256 - inset - hairline, radius - hairline)) return HAIRLINE
  return BACKGROUND
}

/**
 * Paint `width`×`height` pixels where `place(px, py)` maps a pixel-space point
 * to a 256-unit point of the mark (or null for the canvas around it), and
 * `canvas` is the colour behind it (null: transparent). Pixels outside `box`
 * ([x0, y0, x1, y1), the mark's own square) are canvas without sampling.
 */
function paint(width, height, g, place, canvas, box = [0, 0, width, height]) {
  const rgba = Buffer.alloc(width * height * 4)
  for (let py = 0; py < height; py += 1) {
    for (let px = 0; px < width; px += 1) {
      if (canvas && (px < box[0] || py < box[1] || px >= box[2] || py >= box[3])) {
        rgba.set([...canvas, 255], (py * width + px) * 4)
        continue
      }
      let r = 0
      let gr = 0
      let b = 0
      let hits = 0
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const point = place(px + (sx + 0.5) / SS, py + (sy + 0.5) / SS)
          const colour = (point && sample(g, point[0], point[1])) ?? canvas
          if (!colour) continue
          r += colour[0]
          gr += colour[1]
          b += colour[2]
          hits += 1
        }
      }
      const at = (py * width + px) * 4
      if (hits === 0) continue
      rgba[at] = Math.round(r / hits)
      rgba[at + 1] = Math.round(gr / hits)
      rgba[at + 2] = Math.round(b / hits)
      rgba[at + 3] = Math.round((255 * hits) / (SS * SS))
    }
  }
  return png(width, height, rgba)
}

/** The tiled mark at `size` pixels, as a PNG. `draw(size)` is the people's extension. */
export function draw(size, variant = 'okolos') {
  const g = GEOMETRY[variant]?.[size]
  if (!g) throw new Error(`no geometry for ${variant} at ${size}px — sizes are ${SIZES.join(', ')}`)
  const k = 256 / size
  return paint(size, size, g, (x, y) => [x * k, y * k], null)
}

/**
 * The mark as SVG, in the same shape as passioncode.ai's product marks, from
 * the 128 master — so a site can show it at any size and it is still this file.
 */
export function svg(variant = 'okolos') {
  const g = GEOMETRY[variant][128]
  const title = variant === 'okolos' ? 'Okolos' : 'Okolos Bridge'
  const n = (v) => String(Math.round(v * 100) / 100)
  const d = shieldCommands(g)
    .map(([op, ...args]) => (op === 'Z' ? 'Z' : op + args.map(([x, y]) => `${n(x)} ${n(y)}`).join(' ')))
    .join('')
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" fill="none"><title>${title}</title>`,
    `<rect x="8" y="8" width="240" height="240" rx="58" fill="${hex(BACKGROUND)}"/>`,
    `<rect x="9" y="9" width="238" height="238" rx="57" stroke="${hex(HAIRLINE)}" stroke-width="2"/>`,
    `<path d="${d}" stroke="${hex(GOLD)}" stroke-width="${n(g.s)}" stroke-linejoin="round"/>`,
    `<circle cx="${n(g.cx)}" cy="${n(g.dot.cy)}" r="${n(g.dot.r)}" fill="${hex(GOLD)}"/>`,
  ]
  if (g.bar) {
    const { x1, x2, y, r } = g.bar
    parts.push(
      `<path d="M${n(x1)} ${n(y)}H${n(x2)}" stroke="${hex(GOLD)}" stroke-width="${n(2 * r)}" stroke-linecap="round"/>`,
    )
  }
  parts.push('</svg>\n')
  return parts.join('')
}

/**
 * Chrome Web Store's small promo tile, 440×280: the 128 master at 176px,
 * centred on the tile colour.
 *
 * No wordmark. Lettering needs a font, and this generator has none on purpose
 * (no rasteriser, no dependency); the store prints the name beside the tile
 * anyway. A tile with the name on it waits for an outlined wordmark in the
 * brand's typeface, which does not exist yet.
 */
export const PROMO = { width: 440, height: 280, mark: 176 }

export function promo(variant = 'okolos') {
  const { width, height, mark } = PROMO
  const left = (width - mark) / 2
  const top = (height - mark) / 2
  const k = 256 / mark
  const place = (x, y) => {
    const u = (x - left) * k
    const v = (y - top) * k
    return u >= 0 && u < 256 && v >= 0 && v < 256 ? [u, v] : null
  }
  const box = [Math.floor(left), Math.floor(top), Math.ceil(left + mark), Math.ceil(top + mark)]
  return paint(width, height, GEOMETRY[variant][128], place, BACKGROUND, box)
}

/** Every file this script writes, by path relative to the repository root. */
export function outputs() {
  const files = new Map()
  for (const size of SIZES) files.set(`apps/extension/icons/${size}.png`, () => draw(size))
  for (const variant of VARIANTS) {
    files.set(`docs/brand/marks/${variant === 'okolos' ? 'okolos' : 'okolos-bridge'}-mark.svg`, () => svg(variant))
  }
  for (const size of SIZES) files.set(`docs/brand/marks/okolos-bridge-${size}.png`, () => draw(size, 'bridge'))
  files.set('docs/brand/marks/okolos-promo-440x280.png', () => promo())
  return files
}

if (import.meta.filename === process.argv[1]) {
  mkdirSync(OUT, { recursive: true })
  mkdirSync(MARKS, { recursive: true })
  for (const [file, make] of outputs()) {
    writeFileSync(path.join(root, file), make())
    console.log(`wrote ${file}`)
  }
}
