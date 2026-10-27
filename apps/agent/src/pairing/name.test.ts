import { describe, expect, it } from 'vitest'

import { MAX_NAME_LENGTH, checkAgentName } from './name.js'

// Spec §11 F12: the name an agent gives itself is shown on the consent page next to a six-digit
// code, so it may not be long enough to crowd the page, carry a run of digits that could pass for
// the code, or carry characters that move or hide text. A refusal is a machine code; the page maps
// it through the catalogue.
describe('the name an agent gives itself', () => {
  it('accepts an ordinary name, in any script, up to 40 characters', () => {
    expect(MAX_NAME_LENGTH).toBe(40)
    expect(checkAgentName('Claude Code')).toBeNull()
    expect(checkAgentName('Агент Сергея')).toBeNull()
    expect(checkAgentName('a'.repeat(40))).toBeNull()
    // Characters, not UTF-16 units: forty emoji are forty characters.
    expect(checkAgentName('🦊'.repeat(40))).toBeNull()
    // Two digits in a row are fine; only a run of three can pass for part of the code.
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

  it('refuses an empty or blank name, and a value that is not text', () => {
    expect(checkAgentName('')).toBe('name_empty')
    expect(checkAgentName('   ')).toBe('name_empty')
    expect(checkAgentName(42 as unknown as string)).toBe('name_not_text')
  })
})
