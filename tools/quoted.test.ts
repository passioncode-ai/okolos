import { describe, expect, it } from 'vitest'

import { carriesLiteral } from './quoted.mjs'

describe('a string literal in a built bundle, in any quote (B-225)', () => {
  it('finds it between double quotes, single quotes and backticks', () => {
    expect(carriesLiteral('attachShadow({mode:"open"})', 'open')).toBe(true)
    expect(carriesLiteral("attachShadow({mode:'open'})", 'open')).toBe(true)
    expect(carriesLiteral('attachShadow({mode:`open`})', 'open')).toBe(true)
  })

  it('does not take a word for a literal', () => {
    expect(carriesLiteral('function open(){}', 'open')).toBe(false)
    expect(carriesLiteral('"opener"', 'open')).toBe(false)
    expect(carriesLiteral('"open`', 'open')).toBe(false)
  })

  it('reads a word with characters a pattern would take as syntax', () => {
    expect(carriesLiteral('x=`okolos:click-judged`', 'okolos:click-judged')).toBe(true)
    expect(carriesLiteral('x="a.b"', 'a+b')).toBe(false)
  })
})
