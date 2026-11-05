import { describe, expect, it, vi } from 'vitest'

import { runUsageSwitch, switchOutcome } from './usage-switch.js'

describe('what the page does with the browser\'s answer to the usage switch', () => {
  it('in Chrome and Edge tells the worker, whatever was asked', () => {
    expect(switchOutcome(false, null)).toBe('tell-worker')
    expect(switchOutcome(true, null)).toBe('tell-worker')
  })

  it('in Firefox counts a switch-off as saved only when Firefox confirmed it off', () => {
    expect(switchOutcome(false, 'off')).toBe('tell-worker')
    // Firefox kept the grant, or its answer could not be read: the worker follows the grant, so
    // "off" told to it would come back on with a new install number at the next event.
    expect(switchOutcome(false, 'on')).toBe('not-saved')
    expect(switchOutcome(false, 'unsupported')).toBe('not-saved')
  })

  it('in Firefox tells the worker after a switch-on whatever Firefox answered: a declined prompt is an answer', () => {
    expect(switchOutcome(true, 'on')).toBe('tell-worker')
    expect(switchOutcome(true, 'off')).toBe('tell-worker')
    expect(switchOutcome(true, 'unsupported')).toBe('tell-worker')
  })
})

describe('a switch whose answer comes after a later one (B-215)', () => {
  it('still repaints: the grant it left stands, and the page must show what the worker now follows', async () => {
    let latest = 0
    const repaint = vi.fn()
    let releaseFirst: (answer: 'on') => void = () => {}
    const firstAnswer = new Promise<'on'>((resolve) => {
      releaseFirst = resolve
    })
    const deps = (ask: () => Promise<'on' | 'off'>) => ({
      ticket: () => ++latest,
      latest: () => latest,
      ask,
      set: async () => undefined,
      saved: () => {},
      failed: () => {},
      repaint,
    })
    // On (slow Firefox answer), then off at once: the off finishes first and repaints.
    const first = runUsageSwitch(true, deps(() => firstAnswer))
    await runUsageSwitch(false, deps(async () => 'off'))
    expect(repaint).toHaveBeenCalledTimes(1)
    // The on's answer arrives late: it is not told to the worker, but the page paints again.
    releaseFirst('on')
    await first
    expect(repaint).toHaveBeenCalledTimes(2)
  })
})
