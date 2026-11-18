/** @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { BannerHandlers, BannerProps } from '@okolos/ui'

import { claimWithReceipt } from './password-receipt.js'
import { createSurfaceSlot, type SurfaceSlot } from './surface-slot.js'

/**
 * The leak receipt, sent only for a panel that was drawn.
 *
 * The background holds a compromised-password verdict until a surface says it showed
 * it. The receipt went out after the dwell whether or not the claim got the panel: with
 * a link warning holding it at critical, the leak became an "also here" line, the
 * background dropped its held copy as delivered, and the line went with the link
 * warning (seam reading, round 2 of the B-165 certification).
 */

const DWELL = 1_500
const props: BannerProps = { variant: 'password', severity: 'major', headline: 'leak', detail: '', sourceLine: '' }
const handlers = (): BannerHandlers => ({
  onPrimary: vi.fn(),
  onRetry: vi.fn(),
  onDispute: vi.fn(),
  onDismiss: vi.fn(),
})

let slot: SurfaceSlot

beforeEach(() => {
  vi.useFakeTimers()
  slot = createSurfaceSlot({
    doc: document,
    noteRefused: () => undefined,
    escalate: async () => undefined,
    alsoLine: (kinds) => `also here: ${kinds.join(', ')}`,
    wait: async () => undefined,
  })
})

afterEach(() => {
  slot.release()
  vi.useRealTimers()
  document.body.replaceChildren()
})

const trapHolds = () =>
  slot.claim({
    kind: 'trap',
    severity: 'critical',
    props: { variant: 'clickfix', severity: 'critical', headline: 'link', detail: '', sourceLine: '' },
    handlers: handlers(),
  })

describe('the leak receipt', () => {
  it('is not sent when another warning holds the panel', () => {
    trapHolds()
    const send = vi.fn()
    const handle = claimWithReceipt(
      { mount: slot.mountFor('password', 'major'), send, dwellMs: DWELL, onPageHide: () => undefined },
      props,
      handlers(),
    )

    vi.advanceTimersByTime(DWELL * 2)
    expect(handle).toBeNull()
    expect(send).not.toHaveBeenCalled()
    expect(slot.waiting()).toEqual(['password'])
  })

  it('is sent after the dwell when the panel is drawn', () => {
    const send = vi.fn()
    const handle = claimWithReceipt(
      { mount: slot.mountFor('password', 'major'), send, dwellMs: DWELL, onPageHide: () => undefined },
      props,
      handlers(),
    )
    expect(handle).not.toBeNull()
    vi.advanceTimersByTime(DWELL - 1)
    expect(send).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('is sent at once, and once, when the person presses a control', () => {
    const send = vi.fn()
    const own = handlers()
    claimWithReceipt(
      { mount: slot.mountFor('password', 'major'), send, dwellMs: DWELL, onPageHide: () => undefined },
      props,
      own,
    )
    ;(slot.current()?.root.querySelector('[data-role=primary]') as HTMLButtonElement).click()
    expect(send).toHaveBeenCalledTimes(1)
    expect(own.onPrimary).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(DWELL * 2)
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('is not sent from a document that is going away', () => {
    const send = vi.fn()
    const hides: Array<() => void> = []
    claimWithReceipt(
      { mount: slot.mountFor('password', 'major'), send, dwellMs: DWELL, onPageHide: (stop) => hides.push(stop) },
      props,
      handlers(),
    )
    expect(hides).toHaveLength(1)
    for (const hide of hides) hide()
    vi.advanceTimersByTime(DWELL * 2)
    expect(send).not.toHaveBeenCalled()
  })
})

describe('the leak receipt, when the panel goes before the dwell (B-165, round 3)', () => {
  it('is not sent when a critical warning displaces the leak panel within the dwell', () => {
    const send = vi.fn()
    const handle = claimWithReceipt(
      { mount: slot.mountFor('password', 'major'), send, dwellMs: DWELL, onPageHide: () => undefined },
      props,
      handlers(),
    )
    expect(handle).not.toBeNull()
    vi.advanceTimersByTime(DWELL / 2)
    trapHolds()
    vi.advanceTimersByTime(DWELL * 2)
    expect(send).not.toHaveBeenCalled()
  })
})
