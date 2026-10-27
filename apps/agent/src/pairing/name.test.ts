import { describe, expect, it } from 'vitest'

import { MAX_NAME_LENGTH, checkAgentName, checkFreeText, nameKeys, namesLookAlike } from './name.js'

// Spec §11 F12: the name an agent gives itself is shown on the consent page next to a six-digit
// code, so it may not be long enough to crowd the page, carry numerals that could pass for the
// code, carry characters that move or hide text, or pass itself off as Okolos. A refusal is a
// machine code; the page maps it through the catalogue.
//
// Fix round 4: two adversarial rounds got past a hand-made fold table with letters it did not list
// (Greek, small capitals, Lisu, letters with a stroke or a hook). The name now passes an allowlist:
// ASCII letters or the basic Cyrillic alphabet (never both), ASCII digits, the space and - _ . ( ) ' / +.
describe('the name an agent gives itself', () => {
  it('accepts an ordinary Latin or Cyrillic name up to 40 characters', () => {
    expect(MAX_NAME_LENGTH).toBe(40)
    for (const name of ['Claude Code', 'Codex CLI', 'Cursor', 'gpt-4o', 'Агент Иван', 'Kolos', 'Агент Сергея', 'Ёжик', "O'Brien (bot)", 'a/b+c_d.e']) {
      expect(checkAgentName(name), name).toBeNull()
    }
    expect(checkAgentName('a'.repeat(40))).toBeNull()
    expect(checkAgentName('gpt 45 helper')).toBeNull()
  })

  it('refuses more than 40 characters, counted in code points', () => {
    expect(checkAgentName('a'.repeat(41))).toBe('name_too_long')
    // Too long is said before the script: 41 emoji are too long first.
    expect(checkAgentName('🦊'.repeat(41))).toBe('name_too_long')
  })

  it('refuses more than two ASCII digits in total, whatever separates them', () => {
    for (const name of ['agent 123', '123 456', '1 2 3 4 5 6', '12-34-56', 'a1 b2 c3']) {
      expect(checkAgentName(name), name).toBe('name_digits')
    }
    expect(checkAgentName('agent 42')).toBeNull()
    expect(checkAgentName('42')).toBeNull()
    // Letters that look like numerals are not counted: the page shows the code in an element of its own (SCR-23).
    expect(checkAgentName('Зоя')).toBeNull()
    expect(checkAgentName('ЗОб')).toBeNull()
  })

  it('refuses every numeral that is not an ASCII digit as outside the allowlist', () => {
    for (const name of ['agent １２３', 'agent ١٢٣', '①②③', '¹²', 'agent ⅠⅡⅢ', 'agent ㉑']) {
      expect(checkAgentName(name), name).toBe('name_script')
    }
  })

  it('refuses control and other invisible characters', () => {
    expect(checkAgentName('agent\u0000x')).toBe('name_control')
    expect(checkAgentName('agent\nnext line')).toBe('name_control')
    expect(checkAgentName('agent\tx')).toBe('name_control')
    expect(checkAgentName('agent\u007f')).toBe('name_control')
    expect(checkAgentName('agent\u0085x')).toBe('name_control')
    expect(checkAgentName('a\u200bgent')).toBe('name_control')
    expect(checkAgentName('agent\ud800')).toBe('name_control')
  })

  it('refuses a default-ignorable character of any category', () => {
    for (const mark of ['\u034f', '\ufe00', '\ufe0f', '\u{e0100}', '\u3164', '\u115f', '\u1160', '\uffa0', '\u200b', '\u2060', '\u180e']) {
      expect(checkAgentName(`agent${mark}x`), mark.codePointAt(0)!.toString(16)).toBe('name_control')
    }
    expect(checkAgentName('Okol\u034fos')).toBe('name_control')
    expect(checkAgentName('\u3164\u3164')).toBe('name_control')
  })

  it('refuses bidirectional controls', () => {
    for (const mark of ['\u202e', '\u202a', '\u2066', '\u2069', '\u200f', '\u200e', '\u061c']) {
      expect(checkAgentName(`agent${mark}x`)).toBe('name_bidi')
    }
  })

  it('refuses an empty name: nothing but spaces and the allowed punctuation', () => {
    for (const name of ['', '   ', '-- . --', '()', "'/+_"]) {
      expect(checkAgentName(name), JSON.stringify(name)).toBe('name_empty')
    }
    expect(checkAgentName(42 as unknown as string)).toBe('name_not_text')
  })

  // Fix round 4: the letters that broke the fold table, and anything else outside the allowlist.
  it('refuses every character outside the allowlist as name_script', () => {
    for (const name of [
      'Oko\u0399os', // Greek capital iota
      'Oko\u0456os', // Cyrillic і, outside the basic alphabet
      'Oko\u0142os',
      'Oko\u00f8os',
      'Oko\u0275os',
      '\u1d0f\u1d0b\u1d0f\u029f\u1d0f\ua731', // small capitals
      'Oko\ua4f2os', // Lisu
      '\u0199olos',
      'Claude C\u00f5de', // precomposed
      'Claude Co\u0303de', // a combining tilde
      'Oko\u1e0dos',
      '\u03f9laude', // Greek capital lunate sigma
      '\u0257oc',
      'C\u0399aude', // Greek capital iota
      '\u4e03\u4e09\u4e5d',
      '\u2764',
      '🦊 Fox',
      '🦊🦊',
      '⠀', // braille blank
      '-- ** --',
      'Caf\u00e9',
      'Agent Vi\u1ec7t',
      '\uff4fkolos', // fullwidth
      'agent\u00a0x', // no-break space
      'a@b',
      'a,b',
    ]) {
      expect(checkAgentName(name), name).toBe('name_script')
    }
  })

  it('refuses Latin and Cyrillic letters in one name', () => {
    for (const name of ['\u041ekolos', '\u0421odex', 'claude c\u043ede', 'Агент Ivan', 'Oko\u043bos']) {
      expect(checkAgentName(name), name).toBe('name_script')
    }
  })

  // A heart with the emoji presentation selector (U+FE0F) carries an invisible character, and the
  // control check comes before the script check (decision of round 4: existing reasons keep their
  // order), so it is refused as control. The bare heart is refused as script.
  it('refuses the emoji heart as control, for its invisible selector, and the bare heart as script', () => {
    expect(checkAgentName('\u2764\ufe0f')).toBe('name_control')
    expect(checkAgentName('\u2764')).toBe('name_script')
  })

  it('keeps a stack of combining marks a control refusal, said before the script', () => {
    expect(checkAgentName('e\u0301\u0302\u0303gent')).toBe('name_control')
  })

  // The reserved name is compared on the comparison key: lower case, i and 1 as l, 0 as o, Cyrillic
  // in Latin letters, every character that is not a letter or a digit dropped.
  it('refuses a name whose key contains "okolos"', () => {
    for (const name of [
      'Okolos',
      'OKOLOS',
      'Okolos Agent',
      'my okolos helper',
      'okolos-agent',
      'OkoIos',
      '0kolos',
      'Oko-los',
      'O k o l o s',
      'O.k.o.l.o.s',
      'oko_los',
      'Ok0l0s',
      'Okoios',
      'Околос',
      'ОКОЛОС',
      'мой околос',
    ]) {
      expect(checkAgentName(name), name).toBe('name_reserved')
    }
  })

  // Known false positives of the rule, recorded on purpose: spaces are dropped from the key, so a
  // name that runs "okolos" across two words is refused too.
  it('refuses "Joko Lost" and "Echo Kolos" as reserved: the rule knows it errs here', () => {
    expect(checkAgentName('Joko Lost')).toBe('name_reserved')
    expect(checkAgentName('Echo Kolos')).toBe('name_reserved')
  })

  it('accepts a name that only shares letters with "okolos"', () => {
    for (const name of ['Kolos', 'Claude Code', 'oko', 'Cursor', 'Колос', 'Око', 'Okolo agent']) {
      expect(checkAgentName(name), name).toBeNull()
    }
  })
})

describe('the comparison key of a name', () => {
  it('folds case, punctuation, spaces, the l and o look-alikes', () => {
    expect(nameKeys('Claude Code')).toEqual(['claudecode'])
    for (const name of ['Claude-Code', 'Claude_Code', 'Claude Code.', 'claude code', 'CIaude Code', '  Claude   Code ', 'C1aude C0de']) {
      expect(namesLookAlike(name, 'Claude Code'), name).toBe(true)
    }
    expect(namesLookAlike('Codex', 'Claude Code')).toBe(false)
    expect(nameKeys('gpt-4o')).toEqual(['gpt4o'])
    expect(namesLookAlike('Agent 2', 'Agent 3')).toBe(false)
  })

  it('gives a Cyrillic name two keys: its transliteration and its look in Latin letters', () => {
    expect(nameKeys('Околос')).toEqual(['okolos', 'okoloc'])
    expect(nameKeys('Агент Иван')).toEqual(['agentlvan', 'agehtlbah'])
    expect(nameKeys('Щука')).toEqual(['schuka', 'schyka'])
    // An all-Cyrillic name that reads as a Latin one looks alike by its look.
    expect(namesLookAlike('\u0421\u043e\u0441\u043e\u0430', 'Cocoa')).toBe(true)
    expect(namesLookAlike('\u041c\u043e\u0445\u0430', 'Moxa')).toBe(true)
    // ... and a transliteration is a look-alike too.
    expect(namesLookAlike('Кодекс', 'Kodeks')).toBe(true)
    expect(namesLookAlike('Колос', 'Codex')).toBe(false)
  })
})

// For N-009: free text the page shows (a task goal) gets the same bidi and control checks, without
// the allowlist and the digit rule.
describe('free text the page shows', () => {
  it('accepts any script, symbols and digits up to the given length', () => {
    expect(checkFreeText('Найти билеты в Kraków на 12.11, 2 взрослых 🧳', 200)).toBeNull()
    expect(checkFreeText('Café 七三九 ①②③', 20)).toBeNull()
    expect(checkFreeText('a'.repeat(20), 20)).toBeNull()
  })

  it('refuses what is not text, empty, or too long', () => {
    expect(checkFreeText(42 as unknown as string, 20)).toBe('text_not_text')
    expect(checkFreeText('', 20)).toBe('text_empty')
    expect(checkFreeText('  🦊 -- ', 20)).toBe('text_empty')
    expect(checkFreeText('a'.repeat(21), 20)).toBe('text_too_long')
    expect(checkFreeText('🦊'.repeat(20) + 'a', 20)).toBe('text_too_long')
  })

  it('refuses bidirectional controls, control and invisible characters, and stacked marks', () => {
    expect(checkFreeText('goal\u202ex', 20)).toBe('text_bidi')
    expect(checkFreeText('goal\nx', 20)).toBe('text_control')
    expect(checkFreeText('goal\u200bx', 20)).toBe('text_control')
    expect(checkFreeText('goal\ufe0fx', 20)).toBe('text_control')
    expect(checkFreeText('e\u0301\u0302\u0303goal', 20)).toBe('text_control')
  })
})
