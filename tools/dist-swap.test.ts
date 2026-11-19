import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { buildingDir, settledDir, swapInto, sweepLeftovers } from './dist-swap.mjs'
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

describe('a reader waits out a swap in flight, and only that (B-215)', () => {
  it('answers at once when the directory is there, or when no build is swapping it', () => {
    const dist = fresh()
    const final = path.join(dist, 'chrome')
    expect(settledDir(final)).toBe(false)
    mkdirSync(final)
    expect(settledDir(final)).toBe(true)
  })

  it('waits for the second rename while the first one left the old directory beside the target', async () => {
    const dist = fresh()
    const final = path.join(dist, 'chrome')
    mkdirSync(`${final}.old-7`)
    // Another process ends the swap, as a build in another vitest worker does.
    const child = spawn(process.execPath, ['-e', `setTimeout(() => require('node:fs').mkdirSync(${JSON.stringify(final)}), 150)`])
    const exited = new Promise((resolve) => child.on('exit', resolve))
    expect(settledDir(final)).toBe(true)
    await exited
  })

  it('gives up after its budget while a swap never ends', () => {
    const dist = fresh()
    const final = path.join(dist, 'chrome')
    mkdirSync(`${final}.building-7`)
    expect(settledDir(final, 100)).toBe(false)
  })
})
