import { describe, expect, it } from 'vitest'

import { switchOutcome } from './usage-switch.js'

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
