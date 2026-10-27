/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createSurfaceSlot, type SlotClaim } from './surface-slot.js'

/**
 * One panel at a time, and the rule for which one.
 *
 * Two overlays appeared on a page that was both a lookalike and poisoned — same
 * `position: fixed`, same `inset`, so one was drawn exactly on top of the other and
 * the lower one could not be read (B-69). SCN-031 had already written the rule for
 * the frame case and it had been applied to one source out of three, because the rule
 * lived in a comment about frames rather than in a place every source has to pass.
 */

function claim(kind: string, severity: SlotClaim['severity']): SlotClaim {
  return {
    kind,
    severity,
    props: {
      variant: 'injection',
      severity,
      headline: `${kind} headline`,
      detail: `${kind} detail`,
      sourceLine: 'found by a test',
    },
    handlers: {
      onPrimary: () => {},
      onRetry: () => {},
      onDispute: () => {},
      onDismiss: () => {},
    },
  }
}

/**
 * Slots made by a test, released after it.
 *
 * Not housekeeping. `document.body.replaceChildren()` between tests did not clear
 * anything, because the slot's own watch put the host straight back — the two features
 * working together, and the reason a leaked slot leaks a MutationObserver into the
 * next test rather than just a node.
 */
const made: Array<{ release: () => void }> = []

afterEach(() => {
  for (const slot of made) slot.release()
  made.length = 0
  document.body.replaceChildren()
})

function slotWith() {
  const refused: Array<{ kind: string; severity: string }> = []
  const slot = createSurfaceSlot({
    doc: document,
    noteRefused: (kind, severity) => refused.push({ kind, severity }),
    escalate: vi.fn(async () => undefined),
    alsoLine: (kinds) => `also here: ${kinds.join(', ')}`,
    wait: async () => undefined,
  })
  made.push(slot)
  return { slot, refused }
}

/** Every host this document holds, whatever name the fallback gave it. */
function panels(): number {
  return document.querySelectorAll('[data-okolos=banner]').length
}

describe('the in-page warning slot', () => {
  it('draws the first finding', () => {
    const { slot } = slotWith()
    slot.claim(claim('injection', 'major'))
    expect(panels()).toBe(1)
  })

  it('never draws two panels, whichever order they arrive in', () => {
    // The measured defect: two mounts, same `position: fixed` and the same `inset`, so
    // one panel sat exactly on top of the other and the lower one could not be read.
    const { slot } = slotWith()
    slot.claim(claim('lookalike', 'major'))
    slot.claim(claim('injection', 'major'))
    expect(panels()).toBe(1)

    slot.claim(claim('injection', 'critical'))
    slot.claim(claim('lookalike', 'minor'))
    slot.claim(claim('download', 'info'))
    expect(panels(), 'four more claims and still one panel').toBe(1)
  })

  it('keeps the panel that is up when the new finding is not worse', () => {
    const { slot, refused } = slotWith()
    const first = slot.claim(claim('injection', 'critical'))
    const second = slot.claim(claim('lookalike', 'major'))

    // The caller's `showError` must land on the panel a person can see.
    expect(second.host, 'the caller was handed a panel nobody can see').toBe(first.host)
    expect(refused).toEqual([{ kind: 'lookalike', severity: 'major' }])
    expect(slot.waiting()).toEqual(['lookalike'])
  })

  it('gives the panel to a worse finding, and does not lose the displaced one', () => {
    /**
     * A person reading "this site resembles another" must not keep reading only that
     * while something `critical` is also true. The displaced kind becomes a line on
     * the new panel rather than vanishing from the screen.
     */
    const { slot } = slotWith()
    slot.claim(claim('lookalike', 'major'))
    slot.claim(claim('injection', 'critical'))

    expect(panels()).toBe(1)
    expect(slot.waiting()).toEqual(['lookalike'])
    expect(slot.current()?.root.querySelector('[data-role=also]')?.textContent).toContain(
      'lookalike',
    )
  })

  it('does not list the holder as standing behind itself', () => {
    // A kind refused once and arriving again, worse: it takes the panel, so it cannot
    // still be named as one of the findings standing behind the panel.
    const { slot } = slotWith()
    slot.claim(claim('injection', 'major'))
    slot.claim(claim('lookalike', 'minor'))
    expect(slot.waiting()).toEqual(['lookalike'])

    slot.claim(claim('lookalike', 'critical'))
    expect(slot.waiting()).toEqual(['injection'])
  })

  it('a tie leaves the panel where it is, and says so consistently', () => {
    /**
     * First come wins on equal severity, and that is a decision rather than an
     * accident: the alternative is a panel that swaps every time another detector
     * finishes, on a page where three of them agree it is `major`.
     */
    const { slot } = slotWith()
    const first = slot.claim(claim('injection', 'major'))
    expect(slot.claim(claim('lookalike', 'major')).host).toBe(first.host)
    expect(slot.waiting()).toEqual(['lookalike'])
  })

  it('grows one line, not one per finding', () => {
    // Three kinds on one page is a real page. Three lines is a second overlay by
    // another means.
    const { slot } = slotWith()
    slot.claim(claim('injection', 'critical'))
    slot.claim(claim('lookalike', 'major'))
    slot.claim(claim('download', 'minor'))
    expect(slot.current()?.root.querySelectorAll('[data-role=also]')).toHaveLength(1)
    expect(slot.current()?.root.querySelector('[data-role=also]')?.textContent).toContain(
      'lookalike',
    )
    expect(slot.current()?.root.querySelector('[data-role=also]')?.textContent).toContain(
      'download',
    )
  })

  it('counts the same kind once however often it asks', () => {
    const { slot } = slotWith()
    slot.claim(claim('injection', 'critical'))
    slot.claim(claim('download', 'minor'))
    slot.claim(claim('download', 'minor'))
    slot.claim(claim('download', 'minor'))
    expect(slot.waiting()).toEqual(['download'])
  })

  it('takes the panel down and forgets what stood behind it', () => {
    const { slot } = slotWith()
    slot.claim(claim('injection', 'critical'))
    slot.claim(claim('lookalike', 'major'))
    slot.release()

    expect(panels()).toBe(0)
    expect(slot.waiting()).toEqual([])
    expect(slot.current()).toBeNull()
  })

  it('a module tidying up its own refused finding does not take the panel down', () => {
    /**
     * `download.ts` resolving its finding must not remove an injection warning it
     * never owned. Releasing by kind is how a caller says "mine is finished" without
     * knowing whether it is the one on screen.
     */
    const { slot } = slotWith()
    slot.claim(claim('injection', 'critical'))
    slot.claim(claim('download', 'minor'))
    slot.release('download')

    expect(panels()).toBe(1)
    expect(slot.waiting()).toEqual([])
    expect(slot.current()?.root.querySelector('[data-role=also]')).toBeNull()
  })

  it('says nothing about others when there are none', () => {
    const { slot } = slotWith()
    slot.claim(claim('injection', 'major'))
    expect(slot.current()?.root.querySelector('[data-role=also]')).toBeNull()
  })

  it('releases a slot that holds nothing without complaint', () => {
    const { slot } = slotWith()
    expect(() => slot.release()).not.toThrow()
    expect(() => slot.release('download')).not.toThrow()
  })
})

describe('a panel closed by the module that drew it (B-165, round 1)', () => {
  /**
   * The slot's watch puts back a panel the page removed. Every module closed its own
   * panel with `handle.destroy()`, which only removes the host, and nothing told the
   * slot: the watch read the person's "This is wrong" as the page attacking the
   * warning and drew it again a quarter-second later (measured on the ClickFix,
   * tech-support and outside-link warnings; the defect dates from 16bcaa5).
   */
  const realWait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

  function realSlot() {
    const slot = createSurfaceSlot({
      doc: document,
      noteRefused: () => undefined,
      escalate: vi.fn(async () => undefined),
      alsoLine: (kinds) => `also here: ${kinds.join(', ')}`,
      wait: realWait,
    })
    made.push(slot)
    return slot
  }

  it('stays closed, and the slot is free again', async () => {
    const slot = realSlot()
    const handle = slot.claim(claim('trap', 'critical'))
    handle.destroy()
    await realWait(1000)

    expect(panels()).toBe(0)
    expect(slot.current()).toBeNull()
    // Free means the next finding is drawn, not refused.
    slot.claim(claim('lookalike', 'major'))
    expect(panels()).toBe(1)
    expect(slot.waiting()).toEqual([])
  })

  it('a handle handed out on a refusal cannot take the holder down', async () => {
    const slot = realSlot()
    slot.claim(claim('injection', 'critical'))
    const refused = slot.claim(claim('lookalike', 'major'))
    refused.destroy()
    await realWait(400)

    expect(panels()).toBe(1)
    expect(slot.current()?.root.querySelector('[data-role=headline]')?.textContent).toBe('injection headline')
    // Its own line goes with it.
    expect(slot.waiting()).toEqual([])
  })

  it('tells a module whose claim was refused that it holds nothing', () => {
    const slot = realSlot()
    slot.claim(claim('injection', 'critical'))
    const mount = slot.mountFor('trap', 'critical')
    const lower = claim('trap', 'critical')

    expect(mount(lower.props, lower.handlers)).toBeNull()
    expect(slot.waiting()).toEqual(['trap'])

    slot.release()
    expect(mount(lower.props, lower.handlers)).not.toBeNull()
    expect(panels()).toBe(1)
  })

  it('a handle displaced by a worse finding closes nothing', () => {
    const slot = realSlot()
    const first = slot.claim(claim('lookalike', 'major'))
    slot.claim(claim('injection', 'critical'))
    first.destroy()

    expect(panels()).toBe(1)
    expect(slot.current()?.root.querySelector('[data-role=headline]')?.textContent).toBe('injection headline')
  })
})
