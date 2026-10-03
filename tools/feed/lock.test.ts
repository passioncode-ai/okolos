import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { acquireLock, LockHeldError } from './lock.mjs'

/**
 * One feed run at a time, whatever started it (LC-03).
 *
 * A manual `pnpm feed:refresh` overlapping the agent read the same previous version,
 * signed two different `N+1` feeds and wrote both to fixed temp paths; D1 kept the
 * last, and an extension that had taken the other refused it as a replay.
 */

const lockFile = () => path.join(mkdtempSync(path.join(os.tmpdir(), 'okolos-lock-')), 'state', 'feed.lock')

describe('the feed lock', () => {
  it('refuses a second holder while the first is alive', () => {
    const file = lockFile()
    const first = acquireLock(file)
    expect(() => acquireLock(file)).toThrow(LockHeldError)
    first.release()
  })

  it('names the holder, so the refusal can say who is running', () => {
    const file = lockFile()
    const first = acquireLock(file)
    try {
      acquireLock(file)
    } catch (cause) {
      expect((cause as Error).message).toContain(String(process.pid))
    }
    first.release()
  })

  it('takes over a lock whose holder is dead', () => {
    const file = lockFile()
    const held = acquireLock(file)
    held.release()
    // A pid far above anything the kernel hands out stands for a crashed run.
    writeFileSync(file, JSON.stringify({ pid: 2 ** 22 + 12345, token: 'stale', at: '2026-10-01T00:00:00Z' }))
    const taken = acquireLock(file)
    expect(JSON.parse(readFileSync(file, 'utf8')).pid).toBe(process.pid)
    taken.release()
  })

  it('takes over an unreadable lock instead of refusing forever', () => {
    const file = lockFile()
    acquireLock(file).release()
    writeFileSync(file, 'not json')
    const taken = acquireLock(file)
    taken.release()
    expect(existsSync(file)).toBe(false)
  })

  it('lets a child of the holder through on the inherited token, and nobody else', () => {
    const file = lockFile()
    const held = acquireLock(file)
    const inherited = acquireLock(file, { inherited: held.token })
    expect(inherited.inherited).toBe(true)
    inherited.release()
    expect(existsSync(file), 'a child does not release its parent’s lock').toBe(true)
    expect(() => acquireLock(file, { inherited: 'someone-else' })).toThrow(LockHeldError)
    held.release()
    expect(existsSync(file)).toBe(false)
  })

  it('does not remove a lock that another run took over', () => {
    const file = lockFile()
    const held = acquireLock(file)
    writeFileSync(file, JSON.stringify({ pid: process.pid, token: 'another-run', at: '' }))
    held.release()
    expect(existsSync(file)).toBe(true)
  })
})
