import { describe, expect, it } from 'vitest'

import { isComment, sentencesIn, SENTENCE } from './i18n-pattern.mjs'

/**
 * The pattern behind the project's one load-bearing gate.
 *
 * It had no test until 2026-08-20, and was checked by running it over the tree and
 * reading the output. That is how two classes of user-facing sentence stayed invisible
 * for weeks (B-76) — the ceiling counted two of the six in `core-gate` — and how the fix
 * for the first class introduced a match that walked out of one string literal into the
 * next. Every case below quotes the string that defeated a previous version.
 */

describe('the shape of a sentence', () => {
  it('finds three or more words with lowercase ones after the first', () => {
    expect(sentencesIn(`const x = 'This page has an unresolved finding'`)).toEqual([
      'This page has an unresolved finding',
    ])
  })

  it('leaves an identifier, a role name and a key alone', () => {
    // A pattern that matches prose anywhere sweeps up selector soup, and a check that
    // widens until it stops failing is not stricter — it is broken.
    for (const line of [
      `el.setAttribute('data-role', 'analysis-summary')`,
      `const key = 'downloadListedBy'`,
      `type Kind = 'newly-installed' | 'host-access-widened'`,
      `el.style.border = '1px solid black'`,
    ]) {
      expect(sentencesIn(line), line).toEqual([])
    }
  })

  it('finds a sentence that begins with a value', () => {
    // B-51: the anchored form required a letter right after the quote, so every sentence
    // starting with an interpolation was invisible — including six with English
    // pluralisation shipping to a ru-default interface.
    expect(sentencesIn('const x = `${n} passages were not put back`')).toEqual([
      '${n} passages were not put back',
    ])
  })
})

describe('the first class B-76 was filed for: a first word ending in a colon', () => {
  it('finds it', () => {
    // `core-gate` held six sentences of this shape and the sweep reported two, so the
    // recorded ceiling was a claim about the tool rather than about the tree.
    expect(
      sentencesIn(`return refuse('Blocked: this page has an unresolved finding')`),
    ).toEqual(['Blocked: this page has an unresolved finding'])
  })

  it('finds one in brackets, which is what a withheld marker looks like', () => {
    expect(sentencesIn(`const M = '[withheld: this value makes the rest reversible]'`)).toEqual([
      '[withheld: this value makes the rest reversible]',
    ])
  })

  it('does not let the colon carry a match out of one literal and into the next', () => {
    /**
     * The defect the first fix introduced, found by running it over the tree. The word
     * class allowed an apostrophe anywhere, so `'newly-installed'` ended *with* its own
     * closing quote, a semicolon carried the match on, and two type members read as one
     * three-word sentence. An apostrophe is now only allowed inside a word — `don't`,
     * never `installed'` — and a semicolon is not punctuation this anchor accepts.
     */
    const line = `  | { readonly kind: 'newly-installed'; readonly severity: 'minor' }`
    expect(sentencesIn(line)).toEqual([])
  })

  it('still reads an apostrophe inside a word', () => {
    expect(sentencesIn(`const x = "don't close this page yet"`)).toEqual([
      "don't close this page yet",
    ])
  })
})

describe('the second class B-76 was filed for: a quote nested in a substitution', () => {
  it('finds it', () => {
    // This exact string was live in the extensions panel while the sweep called that
    // file clean: the inner quote truncated the literal before the sentence began.
    const line = 'const s = `${n} thing${n === 1 ? \'\' : \'s\'} worth a look.`'
    expect(sentencesIn(line)).toEqual(['${n} thing${n === 1 ? \'\' : \'s\'} worth a look.'])
  })

  it('finds the journal line that was hiding behind the same shape', () => {
    const line =
      'text(doc, `${diff.unreadable} record${diff.unreadable === 1 ? \'\' : \'s\'} could not be read.`)'
    expect(sentencesIn(line)).toHaveLength(1)
  })
})

describe('a sentence in the language the product ships in', () => {
  it('reads Cyrillic prose, which the anchor could not see at all', () => {
    /**
     * `[A-Za-z]` and `\w` — which is `[A-Za-z0-9_]` in JavaScript — meant a Russian
     * sentence hard-coded in a package was invisible here. That is the same defect as an
     * English one mirrored: it ships **untranslated to the English catalogue's readers**.
     * Widening it on 2026-08-20 found nothing in the tree, so the class was uncovered
     * rather than dirty (B-24 found the gap; the row itself was about a name).
     */
    expect(sentencesIn(`const x = 'Проверка страницы не завершилась совсем'`)).toEqual([
      'Проверка страницы не завершилась совсем',
    ])
  })

  it('leaves a name alone, because a name is not copy', () => {
    // `'Okolos: фишинг'` has no run of lowercase words, and that is the right
    // answer: names are held to `docs/brand/terminology.md` by their own gate, and a
    // product that refused every proper noun in its code would be unusable.
    expect(sentencesIn(`  phishing: { ru: 'Okolos: фишинг' },`)).toEqual([])
  })

  it('does not start reading identifiers because of the wider class', () => {
    for (const line of [
      `const kind = 'not-sure'`,
      `el.setAttribute('data-role', 'pick-list')`,
    ]) {
      expect(sentencesIn(line), line).toEqual([])
    }
  })
})

describe('what is deliberately not a surface', () => {
  it('skips the arguments of a console call', () => {
    // Twenty of these surfaced when the colon class was let in. They are lines for
    // whoever has the devtools open. Skipped structurally — "it is an argument to
    // `console.*`" — and not by the `okolos: ` prefix, which nothing enforces.
    expect(sentencesIn(`console.warn('okolos: could not persist findings', cause)`)).toEqual([])
    expect(sentencesIn(`  console.error('okolos: inference failed', cause)`)).toEqual([])
  })

  it('does not skip a thrown message, which can reach the journal', () => {
    /**
     * The line between the two is not tidiness. A thrown message is caught somewhere, and
     * in this product several of those somewheres write it into the journal — which the
     * user reads and `exportAll` puts into a downloaded file. Those stay visible and are
     * exempted one at a time, with the reason at the site.
     */
    expect(sentencesIn(`throw new Error('okolos: no shadow root could be attached')`)).toEqual([
      'okolos: no shadow root could be attached',
    ])
  })

  it('skips a string after a console call but not one before it', () => {
    // The rule reads what precedes the string, so a sentence built before the call is
    // still a sentence.
    const line = `const msg = 'this page could not be read'; console.warn('okolos: gave up', msg)`
    expect(sentencesIn(line)).toEqual(['this page could not be read'])
  })

  it('skips paths, MIME types and URLs', () => {
    for (const line of [
      `const t = 'application/json charset utf'`,
      `const u = 'https://example.test/some/path here'`,
    ]) {
      expect(sentencesIn(line), line).toEqual([])
    }
  })
})

describe('comments are not shipped to anyone', () => {
  it('recognises the three shapes, including a one-line block comment', () => {
    // Checking only `*` and `//` scanned `/** the project's wrapper … */` as code and
    // read its apostrophe as an opening quote — a gate refusing a push over a doc
    // comment, which is the false positive that teaches people to skip gates.
    expect(isComment(`  // this explains something`)).toBe(true)
    expect(isComment(`   * a continuation line`)).toBe(true)
    expect(isComment(`/** the project's wrapper, and why it exists */`)).toBe(true)
    expect(isComment(`const x = 'this is not a comment at all'`)).toBe(false)
  })
})

describe('the regex itself', () => {
  it('is rebuilt per call, so one line cannot skip the next', () => {
    // `SENTENCE` carries `g`; a shared instance keeps `lastIndex` between calls and the
    // second file in a run gets half-scanned. This is the kind of bug that shows up as
    // "the gate passed" rather than as an error.
    const line = `const a = 'this line has words'`
    expect(sentencesIn(line)).toEqual(sentencesIn(line))
    expect(SENTENCE.flags).toContain('g')
  })
})

describe('a sentence may hold a quote of another kind', () => {
  /**
   * The anchor forbade *any* quote character inside a sentence, so a template literal with a
   * nested double quote never reached its closing backtick and the whole match failed. B-76
   * recorded this class as fixed and it was not — the string it hid was an English sentence on
   * the agent gate, the one surface a person meets mid-decision, found by rendering the surface
   * and reading it rather than by any count (B-114).
   */
  const BT = '`'
  const DQ = '"'

  it('finds a sentence in backticks that quotes something', () => {
    const line = `    ? ${BT}Hidden text on this page addresses an assistant: ${DQ}\${snippet}${DQ}${BT}`
    expect(sentencesIn(line)).toHaveLength(1)
  })

  it('finds a sentence in single quotes that quotes something in doubles', () => {
    expect(sentencesIn(`  throw new Error('refused to send ${DQ}feed${DQ} anywhere')`)).toHaveLength(
      1,
    )
  })

  it('still stops at its own delimiter, so one string cannot swallow the next', () => {
    // Two sentences on one line stay two: the body may not contain the quote that closes it.
    const found = sentencesIn("  t('the first one here', 'the second one here')")
    expect(found).toEqual(['the first one here', 'the second one here'])
  })
})
