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

/** What one press of the usage switch needs from the page. */
export interface UsageSwitchDeps {
  /** Numbers this press; a later press makes it stale. */
  ticket(): number
  /** The latest press's number. */
  latest(): number
  /** Asks the browser (Firefox) inside the press, or answers `null` (Chrome, Edge). */
  ask(on: boolean): Promise<ConsentState | null>
  /** Tells the worker. */
  set(on: boolean): Promise<unknown>
  saved(): void
  failed(): void
  repaint(): void
}

/**
 * One press of the usage switch. The browser is asked first, inside the press (Firefox refuses a
 * request after the gesture); only the latest press tells the worker and says saved or not saved.
 * Every press repaints when its answer is in, the stale one too: its request may have left a grant
 * the worker now follows, and a page that stayed on the later press's paint would say «off» over
 * collection that is on (B-215).
 */
export async function runUsageSwitch(on: boolean, deps: UsageSwitchDeps): Promise<void> {
  const mine = deps.ticket()
  const asked = deps.ask(on)
  try {
    const answer = await asked
    if (mine !== deps.latest()) return
    // i18n-exempt: caught below into failed(), which shows usageSaveFailed; this text is never drawn
    if (switchOutcome(on, answer) === 'not-saved') throw new Error('Firefox did not confirm the switch-off')
    await deps.set(on)
    if (mine === deps.latest()) deps.saved()
  } catch {
    if (mine === deps.latest()) deps.failed()
  } finally {
    deps.repaint()
  }
}
