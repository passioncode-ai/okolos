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
    // x has no precomposed form with these marks, so NFC leaves all three stacked (fix round 5).
    expect(checkAgentName('x\u0301\u0302\u0303gent')).toBe('name_control')
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

  // Fix round 5: every digit reads as the letter it resembles before the reserved test (0 o, 1 l,
  // 2 z, 3 e, 4 a, 5 s, 6 g, 7 t, 8 b, 9 g), so a 5 for the final s does not get past it.
  it('reads every digit as the letter it resembles before the reserved test (fix round 5)', () => {
    for (const name of ['OKOLO5', 'Okolo5', 'OK0LO5', '0KOLO5', '\u041e\u041a\u041e\u041b\u041e5', 'okoIo5', 'Oko1o5']) {
      expect(checkAgentName(name), name).toBe('name_reserved')
    }
    // Ordinary names with digits stay accepted.
    for (const name of ['gpt-4o', 'Claude 2', 'agent 42', 'Kolos 5', 'Oko 5']) {
      expect(checkAgentName(name), name).toBeNull()
    }
  })

  // Fix round 6: before the signs are dropped, the reserved key reads their shapes as letters: "()"
  // as o, "/" as l (and "\\" and "|" as l too, though the allowlist refuses them first).
  it('reads the shapes of signs as letters before the reserved test (fix round 6)', () => {
    for (const name of ['Okol()s', 'Oko/os', '()kolos', 'Ok()l()s', '0ko/()s', 'Око/ос']) {
      expect(checkAgentName(name), name).toBe('name_reserved')
    }
    // Still refused by what drops the signs: a sign inside the name is not read into a new letter only.
    expect(checkAgentName('Oko(l)os')).toBe('name_reserved')
    expect(checkAgentName('Okolo/s')).toBe('name_reserved')
    // The allowlist answers first for the signs it does not admit.
    expect(checkAgentName('Oko\\os')).toBe('name_script')
    expect(checkAgentName('Oko|os')).toBe('name_script')
    // Ordinary names with these signs stay accepted.
    for (const name of ["O'Brien (bot)", 'a/b+c_d.e', 'Kolos ()', 'ok/os', 'Claude (Code)']) {
      expect(checkAgentName(name), name).toBeNull()
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

// Fix round 5: a name is normalised to NFC before every check and key, so a letter written as a
// base and a combining mark behaves like the same letter written precomposed.
describe('a name in NFC (fix round 5)', () => {
  const composed = 'Йван' // Йван, Й precomposed
  const decomposed = 'Йван' // И and a combining breve

  it('accepts a decomposed letter that NFC makes one the allowlist holds', () => {
    expect(decomposed).not.toBe(composed)
    expect(checkAgentName(composed)).toBeNull()
    expect(checkAgentName(decomposed)).toBeNull()
    expect(checkAgentName('Й'.repeat(40))).toBeNull() // 80 code points, 40 after NFC
    expect(checkAgentName('Й'.repeat(41))).toBe('name_too_long')
  })

  it('gives the decomposed and the precomposed name the same keys', () => {
    expect(nameKeys(decomposed)).toEqual(nameKeys(composed))
    expect(namesLookAlike(decomposed, composed)).toBe(true)
  })

  it('still refuses what NFC turns into a letter outside the allowlist', () => {
    expect(checkAgentName('Café')).toBe('name_script')
  })
})

describe('the comparison key of a name', () => {
  it('folds case, punctuation, spaces, the l and o look-alikes', () => {
    for (const name of ['Claude-Code', 'Claude_Code', 'Claude Code.', 'claude code', 'CIaude Code', '  Claude   Code ', 'C1aude C0de']) {
      expect(namesLookAlike(name, 'Claude Code'), name).toBe(true)
    }
    expect(namesLookAlike('Codex', 'Claude Code')).toBe(false)
  })

  // Fix round 5: look-alikes compare letters only. A digit is dropped, so a number added to a name
  // does not make it a new one; this reverses what round 4 asserted on purpose ("Agent 2" and
  // "Agent 3" apart). A second key reads each digit as the letter it resembles, so "C1aude" still
  // matches "Claude". Then the shapes two letters make are folded: rn as m, vv as w, cl as d.
  it('drops digits, so a number added to a name looks like the name (fix round 5)', () => {
    expect(namesLookAlike('Claude 2', 'Claude')).toBe(true)
    expect(namesLookAlike('Agent 2', 'Agent 3')).toBe(true)
    expect(namesLookAlike('gpt-4', 'gpt-5')).toBe(true)
    expect(namesLookAlike('gpt-4o', 'gpt-5')).toBe(false)
    expect(nameKeys('gpt-4o')).toEqual(['gpto', 'gptao'])
    expect(namesLookAlike('C1aude C0de', 'Claude Code')).toBe(true)
  })

  it('folds rn to m, vv to w and cl to d, in both names (fix round 5)', () => {
    expect(namesLookAlike('Gernini', 'Gemini')).toBe(true)
    expect(namesLookAlike('VVindsurf', 'Windsurf')).toBe(true)
    expect(namesLookAlike('Windsurf', 'VVindsurf')).toBe(true)
    expect(namesLookAlike('Dlaude', 'Claude')).toBe(false)
    expect(namesLookAlike('Daude', 'Claude')).toBe(true)
    expect(nameKeys('Claude Code')).toEqual(['daudecode'])
    expect(namesLookAlike('Cursor', 'Gemini')).toBe(false)
  })

  it('gives a Cyrillic name two keys: its transliteration and its look in Latin letters', () => {
    expect(nameKeys('Околос')).toEqual(['okolos', 'okoloc'])
    expect(nameKeys('Агент Иван')).toEqual(['agentlvan', 'arehtlbah'])
    expect(nameKeys('Щука')).toEqual(['schuka', 'schyka'])
    // An all-Cyrillic name that reads as a Latin one looks alike by its look.
    expect(namesLookAlike('\u0421\u043e\u0441\u043e\u0430', 'Cocoa')).toBe(true)
    expect(namesLookAlike('\u041c\u043e\u0445\u0430', 'Moxa')).toBe(true)
    // ... and a transliteration is a look-alike too.
    expect(namesLookAlike('Кодекс', 'Kodeks')).toBe(true)
    expect(namesLookAlike('Колос', 'Codex')).toBe(false)
  })

  // Fix round 6: a key with no letter left is no key. Names of digits alone drop to an empty key, and
  // two different numbers are not one name.
  it('never marks two names on an empty key (fix round 6)', () => {
    expect(namesLookAlike('12', '34')).toBe(false)
    expect(namesLookAlike('42', '-- 7 --')).toBe(false)
    expect(nameKeys('42')).toEqual(['az'])
    expect(namesLookAlike('12', '12')).toBe(true)
  })

  // Fix round 6: more Cyrillic letters are read by their shape, on top of the table of round 4:
  // п as n, г as r, ь and б as b, з as e (it looks like a 3, which reads as e).
  it('reads п, г, ь, б and з by their shape in the look key (fix round 6)', () => {
    expect(namesLookAlike('\u0421\u0433\u043e\u043f', 'Cron')).toBe(true) // Сгоп
    expect(namesLookAlike('\u0431\u043e\u0442', 'bot')).toBe(true) // бот
    expect(namesLookAlike('\u044c\u043e\u0442', 'bot')).toBe(true) // ьот
    expect(namesLookAlike('\u0437\u0441\u043e', 'eco')).toBe(true) // зсо
    expect(nameKeys('\u0421\u0433\u043e\u043f')).toEqual(['sgop', 'cron'])
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
    expect(checkFreeText('goal\ufe00x', 20)).toBe('text_control')
    expect(checkFreeText('e\u0301\u0302\u0303goal', 20)).toBe('text_control')
  })
})

// Fix round 5: a task goal is ordinary text in any language. The joiners and the emoji variation
// selectors are default-ignorable, but Persian, Hindi and emoji need them; length is in UTF-16 code
// units, the unit validateScope in packages/contracts counts a goal in.
describe('free text in any language (fix round 5)', () => {
  it('accepts ZWNJ, ZWJ and the variation selectors U+FE0E and U+FE0F', () => {
    for (const text of [
      '\u2764\ufe0f \u043f\u0440\u043e\u0432\u0435\u0440\u0438\u0442\u044c \u043f\u043e\u0447\u0442\u0443', // ❤️ проверить почту
      // A ZWJ family next to a word: emoji alone shows no letter or numeral and stays text_empty.
      '\u{1f468}\u200d\u{1f469}\u200d\u{1f467} \u0441\u0435\u043c\u044c\u044f',
      '\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645', // Persian میخواهم with ZWNJ
      '\u0915\u094d\u200d\u0937', // Hindi क्‍ष with ZWJ
      'snow \u2603\ufe0e',
    ]) {
      expect(checkFreeText(text, 200), text).toBeNull()
    }
  })

  it('still refuses bidi controls, Cc controls and the other default-ignorables', () => {
    expect(checkFreeText('goal\u202ex', 200)).toBe('text_bidi')
    expect(checkFreeText('goal\u0007x', 200)).toBe('text_control')
    for (const mark of ['\u200b', '\u2060', '\u034f', '\ufe00', '\u3164', '\u00ad']) {
      expect(checkFreeText(`goal${mark}x`, 200), mark.codePointAt(0)!.toString(16)).toBe('text_control')
    }
  })

  it('counts the length in UTF-16 code units, as validateScope does', () => {
    // 'goal ' is 5 units and each fox 2: 7 foxes make 19 units, 8 make 21 (13 code points).
    expect(checkFreeText(`goal ${'\u{1f98a}'.repeat(7)}`, 20)).toBeNull()
    expect(checkFreeText(`goal ${'\u{1f98a}'.repeat(8)}`, 20)).toBe('text_too_long')
  })

  it('refuses enclosing marks as control, in free text and in a name', () => {
    expect(checkFreeText('1\ufe0f\u20e3 goal', 200)).toBe('text_control') // keycap
    expect(checkFreeText('a\u20dd goal', 200)).toBe('text_control')
    expect(checkAgentName('a\u20dd agent')).toBe('name_control')
  })

  it('throws a TypeError when maxLength is not a positive integer', () => {
    for (const max of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '20' as unknown as number]) {
      expect(() => checkFreeText('goal', max), String(max)).toThrow(TypeError)
    }
    expect(checkFreeText('goal', 1)).toBe('text_too_long')
  })
})
