import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { buildingDir, swapInto, sweepLeftovers } from './dist-swap.mjs'
import { directoriesIn } from './tree.mjs'

function fresh(): string {
  return mkdtempSync(path.join(tmpdir(), 'okolos-dist-swap-'))
}

describe('a build takes the place of the old one at the end', () => {
  it('replaces the old directory with the new one, and leaves nothing beside it', async () => {
    const dist = fresh()
    const final = path.join(dist, 'chrome')
    mkdirSync(final)
    writeFileSync(path.join(final, 'content.js'), 'old')
    const built = buildingDir(final, 7)
    mkdirSync(built)
    writeFileSync(path.join(built, 'content.js'), 'new')

    await swapInto(final, built, 7)

    expect(readFileSync(path.join(final, 'content.js'), 'utf8')).toBe('new')
    expect(directoriesIn(dist)).toEqual(['chrome'])
  })

  it('puts the first build in place when there was none', async () => {
    const dist = fresh()
    const final = path.join(dist, 'firefox')
    const built = buildingDir(final, 8)
    mkdirSync(built)
    await swapInto(final, built, 8)
    expect(existsSync(final)).toBe(true)
    expect(directoriesIn(dist)).toEqual(['firefox'])
  })

  it('sweeps what a killed build left behind, and only that', async () => {
    const dist = fresh()
    for (const name of ['chrome', 'chrome.building-123', 'firefox.old-9', 'release']) mkdirSync(path.join(dist, name))
    expect((await sweepLeftovers(dist)).sort()).toEqual(['chrome.building-123', 'firefox.old-9'])
    expect(directoriesIn(dist)).toEqual(['chrome', 'release'])
  })
})
