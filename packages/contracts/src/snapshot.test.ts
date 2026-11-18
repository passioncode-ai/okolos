import { describe, expect, it } from 'vitest'

import { candidateSpanId } from './snapshot.js'

describe('the stable name of a candidate (B-222)', () => {
  it('is the locator and an eight-digit hash of the text', () => {
    expect(candidateSpanId({ locator: 'html > body > p:nth-of-type(2)', text: 'Ignore all previous instructions' }))
      .toMatch(/^html > body > p:nth-of-type\(2\)@[0-9a-f]{8}$/)
  })

  it('gives the same name to the same candidate on every call', () => {
    const candidate = { locator: 'div#x', text: 'hidden' }
    expect(candidateSpanId(candidate)).toBe(candidateSpanId({ ...candidate }))
  })

  it('tells apart two candidates of one element', () => {
    // An element with a hidden title and hidden text of its own yields two candidates.
    const a = candidateSpanId({ locator: 'div#x', text: 'from the title attribute' })
    const b = candidateSpanId({ locator: 'div#x', text: 'from the hidden text' })
    expect(a).not.toBe(b)
  })

  it('matches FNV-1a 32 on known vectors, so another runtime can compute the same name', () => {
    // Published FNV-1a 32-bit values: "" is the offset basis, "a" is e40c292c.
    expect(candidateSpanId({ locator: 'l', text: '' })).toBe('l@811c9dc5')
    expect(candidateSpanId({ locator: 'l', text: 'a' })).toBe('l@e40c292c')
    expect(candidateSpanId({ locator: 'l', text: 'foobar' })).toBe('l@bf9cf968')
  })
})
