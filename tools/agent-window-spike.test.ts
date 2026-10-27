import { describe, expect, it } from 'vitest'

import { NATIVE_MESSAGE_LIMIT, chunksNeeded, compactAxTree } from './agent-window-spike.mjs'

// The pipe's frame splitter moved to packages/cdp-pipe (N-002); its tests moved with it
// to packages/cdp-pipe/src/frames.test.ts.

describe('the snapshot an agent is handed', () => {
  const node = (nodeId: string, role: string, name?: string, ignored = false) => ({
    nodeId,
    ignored,
    role: { value: role },
    ...(name === undefined ? {} : { name: { value: name } }),
  })

  it('keeps what an agent can act on or orient by, with a reference it can name back', () => {
    const { text, kept } = compactAxTree([node('1', 'button', 'Send'), node('2', 'link', 'Docs'), node('3', 'heading', 'Inbox')])
    expect(text).toBe('e1 button "Send"\ne2 link "Docs"\ne3 heading "Inbox"')
    expect(kept).toBe(3)
  })

  it('drops ignored nodes and anonymous layout', () => {
    const { kept } = compactAxTree([node('1', 'button', 'Hidden', true), node('2', 'generic'), node('3', 'none', 'x')])
    expect(kept).toBe(0)
  })

  it('drops text runs without words and cuts long names', () => {
    const long = 'a'.repeat(300)
    const { text } = compactAxTree([node('1', 'StaticText', ' '), node('2', 'StaticText', long)], 120)
    expect(text).toBe(`e2 text "${'a'.repeat(120)}…"`)
  })

  it('collapses whitespace inside a name', () => {
    expect(compactAxTree([node('9', 'link', 'Read\n   more')]).text).toBe('e9 link "Read more"')
  })
})

describe('the Native Messaging ceiling', () => {
  it('is one mebibyte per host-to-extension message', () => {
    expect(NATIVE_MESSAGE_LIMIT).toBe(1048576)
  })

  it('counts the messages a payload needs', () => {
    expect(chunksNeeded(0)).toBe(0)
    expect(chunksNeeded(1)).toBe(1)
    expect(chunksNeeded(NATIVE_MESSAGE_LIMIT)).toBe(1)
    expect(chunksNeeded(NATIVE_MESSAGE_LIMIT + 1)).toBe(2)
  })
})
