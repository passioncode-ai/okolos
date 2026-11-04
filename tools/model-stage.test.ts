import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { MODEL } from '../packages/model/src/runtime.js'

import { filesUnder } from './tree.mjs'

/**
 * The third stage is not shipped (ADR-0006), and neither is anything that exists only for it.
 *
 * The decision was carried out by halves twice. On 2026-08-20 the offscreen document and its
 * permission went (B-50), while the background kept importing `@okolos/model` and wiring a
 * classifier host into every wake-up: a session class, a model descriptor and a contract
 * branch (`inference/score`) that nothing in any context answered. None of it could run;
 * all of it shipped (B-131).
 *
 * `grep -c ClassifierSession` was the measure the backlog row named, and it reads 0 against
 * the very build that carried the class: the bundle is minified and class names are
 * renamed. So this reads strings the minifier cannot rename — the model's id and the host
 * of its address, taken from the descriptor itself rather than retyped here.
 */

const root = path.resolve(import.meta.dirname, '..')

const BUNDLES = ['apps/extension/dist/chrome/background.js', 'apps/extension/dist/firefox/background.js']

/** What only the model package carries, and a minifier leaves alone. */
const MARKERS = [MODEL.id, new URL(MODEL.url).hostname]

describe('the model stage stays out of what ships', () => {
  it('has markers to look for, so an empty list cannot pass as a clean bundle', () => {
    expect(MARKERS.every((marker) => marker.length > 5)).toBe(true)
  })

  it('leaves no shipped source importing the model package', () => {
    const importers = filesUnder(path.join(root, 'apps'), '.ts')
      .filter((file) => !file.endsWith('.test.ts') && !file.endsWith('.bench.ts'))
      .filter((file) => /from '@okolos\/model'/.test(readFileSync(file, 'utf8')))
      .map((file) => path.relative(root, file))
    expect(importers, 'ADR-0006: the model stage is not shipped, so nothing that ships imports it').toEqual([])
  })

  it('builds background bundles that carry none of the model', () => {
    for (const bundle of BUNDLES) {
      const text = readFileSync(path.join(root, bundle), 'utf8')
      expect(text.length, `${bundle} is empty: run \`pnpm build\` first`).toBeGreaterThan(1000)
      for (const marker of MARKERS) {
        expect(text.includes(marker), `${bundle} still carries "${marker}"`).toBe(false)
      }
    }
  })
})
