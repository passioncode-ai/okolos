import { describe, expect, it, vi } from 'vitest'

import { repaintOnReturn } from './return.js'

/**
 * The first-run tab stays open behind the settings tab its notice opens. A person who switches
 * usage and error data off there and comes back must not read «Okolos отправляет нам…» (B-215,
 * round 21): the tab paints again when it is shown.
 */
describe('the first-run tab, shown again', () => {
  it('paints again when it becomes visible, and not when it is hidden', () => {
    const doc = new EventTarget() as Document & { visibilityState: DocumentVisibilityState }
    const paint = vi.fn()
    repaintOnReturn(doc, paint)

    Object.defineProperty(doc, 'visibilityState', { value: 'hidden', configurable: true })
    doc.dispatchEvent(new Event('visibilitychange'))
    expect(paint).not.toHaveBeenCalled()

    Object.defineProperty(doc, 'visibilityState', { value: 'visible', configurable: true })
    doc.dispatchEvent(new Event('visibilitychange'))
    expect(paint).toHaveBeenCalledTimes(1)
  })
})
