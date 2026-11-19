import { describe, expect, it } from 'vitest'

import { findChrome, sweepOrphans, type OrphanProbe } from './chrome.js'

const noOrphans: OrphanProbe = {
  readLock: () => null,
  commandOf: () => null,
  kill: () => {},
  sleep: () => Promise.resolve(),
}

describe('sweepOrphans', () => {
  function probe(alive: Set<number>, command: string): OrphanProbe & { signals: [number, string | number][] } {
    const signals: [number, string | number][] = []
    return {
      signals,
      readLock: () => 'mac.local-777',
      commandOf: (pid) => (alive.has(pid) ? command : null),
      kill: (pid, signal) => {
        signals.push([pid, signal])
        if (signal === 0) {
          if (!alive.has(Math.abs(pid))) throw new Error('ESRCH')
          return
        }
        if (signal === 'SIGKILL' || signal === 'SIGTERM') alive.delete(Math.abs(pid))
      },
      sleep: () => Promise.resolve(),
    }
  }

  it('ends the group of the browser on its own profile', async () => {
    const p = probe(new Set([777]), '/chrome --no-startup-window --user-data-dir=/profile --remote-debugging-pipe')
    expect(await sweepOrphans('/profile', p)).toBe(777)
    expect(p.signals[0]).toEqual([-777, 'SIGTERM'])
  })

  it('leaves a pid that now belongs to another program, or another profile', async () => {
    const p = probe(new Set([777]), '/usr/bin/vim notes.txt')
    expect(await sweepOrphans('/profile', p)).toBeNull()
    const q = probe(new Set([777]), '/chrome --user-data-dir=/other')
    expect(await sweepOrphans('/profile', q)).toBeNull()
    expect([...p.signals, ...q.signals]).toEqual([])
  })

  it('does nothing without a lock or with a lock that names no pid', async () => {
    expect(await sweepOrphans('/profile', noOrphans)).toBeNull()
    expect(await sweepOrphans('/profile', { ...noOrphans, readLock: () => 'garbage' })).toBeNull()
  })
})

describe('findChrome', () => {
  it('answers the first installed Chrome, or null', () => {
    expect(findChrome({ HOME: '/Users/x' }, (f) => f === '/usr/bin/google-chrome')).toBe('/usr/bin/google-chrome')
    expect(findChrome({ HOME: '/Users/x' }, () => false)).toBeNull()
  })
})
