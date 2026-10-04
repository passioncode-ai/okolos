import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { LOG_KEEP, LOG_MAX_BYTES, cleanLine, openLog } from './log.mjs'

/**
 * Every file the feed agent writes is bounded (LC-12).
 *
 * The log went to `/tmp/okolos-feed.log`: wiped at every boot, so the weeks of 401s
 * from a revoked token left no trace, mode 644, unrotated, and full of spinner
 * carriage returns — its last line read `atabase will be unavailable to serve queries.`
 */

const dir = () => mkdtempSync(path.join(os.tmpdir(), 'okolos-log-'))

describe('the feed log', () => {
  it('defaults to five files of five megabytes', () => {
    expect(LOG_MAX_BYTES).toBe(5 * 1024 * 1024)
    expect(LOG_KEEP).toBe(5)
  })

  it('is created owner-only, never world-readable', () => {
    const file = path.join(dir(), 'nested', 'feed.log')
    const log = openLog(file)
    log.write('started')
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('timestamps every line', () => {
    const file = path.join(dir(), 'feed.log')
    const log = openLog(file, { now: () => Date.parse('2026-10-03T12:00:00.000Z') })
    log.write('hello')
    expect(readFileSync(file, 'utf8')).toBe('2026-10-03T12:00:00.000Z hello\n')
  })

  it('rotates past the cap and keeps at most the stated number of files', () => {
    const d = dir()
    const file = path.join(d, 'feed.log')
    const log = openLog(file, { maxBytes: 200, keep: 3 })
    for (let i = 0; i < 100; i += 1) log.write(`line ${i} ${'x'.repeat(40)}`)

    const files = ['feed.log', 'feed.log.1', 'feed.log.2', 'feed.log.3'].filter((name) => existsSync(path.join(d, name)))
    expect(files).toEqual(['feed.log', 'feed.log.1', 'feed.log.2'])
    for (const name of files) {
      const stat = statSync(path.join(d, name))
      expect(stat.size, `${name} is past the cap`).toBeLessThanOrEqual(200 + 80)
      expect(stat.mode & 0o777, `${name} is readable by others`).toBe(0o600)
    }
    expect(readFileSync(file, 'utf8')).toContain('line 99')
  })

  it('rotates a file it finds already past the cap, before writing to it', () => {
    const d = dir()
    const file = path.join(d, 'feed.log')
    writeFileSync(file, 'y'.repeat(1000), { mode: 0o644 })
    const log = openLog(file, { maxBytes: 500, keep: 2 })
    log.write('fresh')
    expect(readFileSync(file, 'utf8')).toMatch(/ fresh\n$/)
    expect(statSync(path.join(d, 'feed.log.1')).mode & 0o777).toBe(0o600)
  })
})

describe('what reaches a line', () => {
  it('drops colour codes and keeps only what a spinner left last', () => {
    expect(cleanLine('\u001b[32m✔\u001b[0m done')).toBe('✔ done')
    expect(cleanLine('⠋ working\r⠙ working\rExecuted 2 commands')).toBe('Executed 2 commands')
  })
})
