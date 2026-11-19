import { describe, expect, it } from 'vitest'

import { splitFrames } from './frames.js'

describe('reading the CDP pipe', () => {
  it('splits NUL-terminated messages', () => {
    expect(splitFrames('', '{"id":1}\0{"id":2}\0')).toEqual({ messages: ['{"id":1}', '{"id":2}'], pending: '' })
  })

  it('carries a message cut by the read into the next one instead of dropping it', () => {
    const first = splitFrames('', '{"id":1}\0{"id"')
    expect(first).toEqual({ messages: ['{"id":1}'], pending: '{"id"' })
    expect(splitFrames(first.pending, ':2}\0')).toEqual({ messages: ['{"id":2}'], pending: '' })
  })

  it('returns nothing for a read that ends before any message does', () => {
    expect(splitFrames('', '{"id":3')).toEqual({ messages: [], pending: '{"id":3' })
  })

  it('skips the empty pieces between two NULs', () => {
    expect(splitFrames('', '\0\0{"id":4}\0\0')).toEqual({ messages: ['{"id":4}'], pending: '' })
  })

  it('keeps what was pending when a read brings nothing', () => {
    expect(splitFrames('{"id":5', '')).toEqual({ messages: [], pending: '{"id":5' })
  })
})
