import { describe, expect, it } from 'vitest'

import { MAX_NAME_LENGTH, checkAgentName, nameSkeleton } from './name.js'

// Spec §11 F12: the name an agent gives itself is shown on the consent page next to a six-digit
// code, so it may not be long enough to crowd the page, carry numerals that could pass for the
// code, carry characters that move or hide text, or pass itself off as Okolos. A refusal is a
// machine code; the page maps it through the catalogue.
describe('the name an agent gives itself', () => {
  it('accepts an ordinary name, in any script, up to 40 characters', () => {
    expect(MAX_NAME_LENGTH).toBe(40)
    expect(checkAgentName('Claude Code')).toBeNull()
    expect(checkAgentName('Агент Сергея')).toBeNull()
    expect(checkAgentName('a'.repeat(40))).toBeNull()
    // Characters, not UTF-16 units: forty emoji are forty characters.
    expect(checkAgentName('🦊'.repeat(40))).toBeNull()
    // At most two numeric characters in total, of any script and wherever they stand: a third,
    // even apart from the others, could pass for part of the code.
    expect(checkAgentName('gpt 45 helper')).toBeNull()
  })

  it('refuses more than 40 characters', () => {
    expect(checkAgentName('a'.repeat(41))).toBe('name_too_long')
    expect(checkAgentName('🦊'.repeat(41))).toBe('name_too_long')
  })

  it('refuses a run of three or more digits, in any script', () => {
    expect(checkAgentName('agent 123')).toBe('name_digits')
    expect(checkAgentName('123 456')).toBe('name_digits')
    // Fullwidth and Arabic-Indic digits read as digits on the page too.
    expect(checkAgentName('agent １２３')).toBe('name_digits')
    expect(checkAgentName('agent ١٢٣')).toBe('name_digits')
  })

  // Fix round 1: a name reads as a code when it carries three numeric characters in total, of any
  // kind (superscript, circled, fullwidth), whatever separates them.
  it('refuses three or more numeric characters in total, whatever separates them', () => {
    expect(checkAgentName('1 2 3 4 5 6')).toBe('name_digits')
    expect(checkAgentName('12-34-56')).toBe('name_digits')
    expect(checkAgentName('①②③④⑤⑥')).toBe('name_digits')
    expect(checkAgentName('¹²³ ⁴⁵⁶')).toBe('name_digits')
    expect(checkAgentName('agent ①②③')).toBe('name_digits')
    expect(checkAgentName('a1 b2 c3')).toBe('name_digits')
    expect(checkAgentName('agent 42')).toBeNull()
  })

  it('refuses control and other invisible characters', () => {
    expect(checkAgentName('agent\u0000x')).toBe('name_control')
    expect(checkAgentName('agent\nnext line')).toBe('name_control')
    expect(checkAgentName('agent\u007f')).toBe('name_control')
    expect(checkAgentName('agent x')).toBe('name_control')
    expect(checkAgentName('a​gent')).toBe('name_control')
    expect(checkAgentName('agent\ud800')).toBe('name_control')
  })

  it('refuses bidirectional controls', () => {
    for (const mark of ['‮', '‪', '⁦', '⁩', '‏', '‎', '؜']) {
      expect(checkAgentName(`agent${mark}x`)).toBe('name_bidi')
    }
  })

  // Fix round 2: an agent may not pass itself off as Okolos on the consent page. A name is refused
  // when what it looks like (the folding the duplicate check uses) contains what "okolos" looks like.
  it('refuses a name that looks like it contains "okolos"', () => {
    expect(checkAgentName('Okolos Agent')).toBe('name_reserved')
    expect(checkAgentName('OKOLOS')).toBe('name_reserved')
    expect(checkAgentName('Оkolos')).toBe('name_reserved') // Cyrillic capital O
    expect(checkAgentName('my okolos helper')).toBe('name_reserved')
    expect(checkAgentName('0kolos')).toBe('name_reserved') // digit zero for the o
    expect(checkAgentName('ｏkolos')).toBe('name_reserved') // fullwidth o, folded by NFKC
    expect(checkAgentName('okolos-agent')).toBe('name_reserved')
  })

  it('accepts a name that only shares letters with "okolos"', () => {
    expect(checkAgentName('Kolos')).toBeNull()
    expect(checkAgentName('Claude Code')).toBeNull()
    expect(checkAgentName('oko los')).toBeNull()
  })

  it('folds a name the way the duplicate check does: NFKC, lower case, look-alikes, spaces', () => {
    expect(nameSkeleton('  Claude   Cоde ')).toBe('claude code')
    expect(nameSkeleton('Café')).toBe(nameSkeleton('Café'))
    expect(nameSkeleton('ＯＫＯＬＯＳ')).toBe('okolos')
  })

  it('refuses an empty or blank name, and a value that is not text', () => {
    expect(checkAgentName('')).toBe('name_empty')
    expect(checkAgentName('   ')).toBe('name_empty')
    expect(checkAgentName(42 as unknown as string)).toBe('name_not_text')
  })
})
