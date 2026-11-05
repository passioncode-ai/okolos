import type { ConsentState } from '../background/usage/consent.js'

/**
 * What the settings page does once the browser has answered the usage switch (B-199, SCN-051,
 * SCN-052). `answer` is Firefox's, read back after the request or the removal; `null` in Chrome
 * and Edge, where the switch is the consent and the worker is simply told.
 *
 * A switch-off counts as saved only when Firefox confirmed off. The worker follows Firefox's grant,
 * so telling it "off" while the grant stands, or while the answer could not be read, would be
 * undone at the next event with a new install number, under a switch that said it had saved.
 * A switch-on is always passed on: a declined prompt is Firefox's answer, not a failure, and the
 * worker reads the grant itself.
 */
export function switchOutcome(on: boolean, answer: ConsentState | null): 'tell-worker' | 'not-saved' {
  if (answer === null || on) return 'tell-worker'
  return answer === 'off' ? 'tell-worker' : 'not-saved'
}
