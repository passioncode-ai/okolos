/**
 * The rules for the name an agent gives itself (spec §11 F12), and for other free text the page shows.
 *
 * Nothing verifies the name: the consent page shows it as the agent's own claim, next to the
 * six-digit code the person compares. So the name may not crowd the page, may not carry
 * numerals that could pass for the code, and may not carry a character that moves, hides or breaks
 * text. Nor may it pass the agent off as Okolos itself: the page is Okolos speaking, so a name that
 * reads as "okolos", however spelled or spaced, is reserved. A refusal is a machine code; the page
 * and the CLI map it through the catalogue.
 *
 * Fix round 4: two adversarial rounds got past a hand-made table of look-alikes with letters it did
 * not list (Greek Ι, Cyrillic і, small capitals, Lisu ꓲ, ł, ø, ɵ, ƙ, õ, ḍ, Ϲ, ɗ). A table of what to
 * refuse is never complete, so the name now passes an allowlist instead: ASCII letters, or the basic
 * Cyrillic alphabet, never both in one name; ASCII digits; the space; and - _ . ( ) ' / +. What is
 * left can be folded by a short, closed table (`nameKeys`).
 */

/** At most this many characters (code points, not UTF-16 units). */
export const MAX_NAME_LENGTH = 40

export type NameRefusal =
  | 'name_not_text'
  | 'name_empty'
  | 'name_too_long'
  | 'name_digits'
  | 'name_bidi'
  | 'name_control'
  | 'name_script'
  | 'name_reserved'

export type FreeTextRefusal = 'text_not_text' | 'text_empty' | 'text_too_long' | 'text_bidi' | 'text_control'

/** The marks that reorder or isolate text: embeddings, overrides, isolates and the directional marks. */
const BIDI = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u

/**
 * Control and invisible characters: C0 and C1 controls, the other format characters (zero-width
 * space, joiners, byte order mark), line and paragraph separators, lone surrogates, every character
 * Unicode calls default-ignorable whatever its category (the combining grapheme joiner U+034F,
 * variation selectors, the Hangul fillers U+115F, U+1160, U+3164, U+FFA0), and the enclosing marks
 * (a circle, a keycap; fix round 5), which draw over the letters around them.
 */
const CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}\p{Default_Ignorable_Code_Point}\p{Me}]/u

/**
 * The default-ignorable characters ordinary text needs (fix round 5), allowed in free text and never
 * in a name: ZWNJ U+200C (Persian), ZWJ U+200D (Indic scripts, emoji sequences) and the variation
 * selectors U+FE0E and U+FE0F (text or emoji presentation).
 */
// An alternation, not a class: a class of joiners and selectors reads as one joined character.
const TEXT_JOINERS = /\u200c|\u200d|\ufe0e|\ufe0f/gu

/** More than two combining marks in a row stack above or below one letter and crowd the page. */
const STACKED_MARKS = /\p{M}{3,}/u

type Fault = 'not_text' | 'empty' | 'too_long' | 'bidi' | 'control'

interface TextRules {
  /** The longest text, in the unit `length` counts. */
  readonly maxLength: number
  readonly length: (text: string) => number
  readonly isEmpty: (text: string) => boolean
  /** Characters taken out before the control check: what this kind of text may carry though invisible. */
  readonly allowedInvisible?: RegExp
}

/**
 * The checks a name and free text share, in their order: not text, empty (as `isEmpty` says), longer
 * than `maxLength`, a bidirectional control, a control or invisible character (other than
 * `allowedInvisible`) or a stack of combining marks. Bidirectional controls are format characters
 * too; they are named first, for a precise reason.
 */
function textFault(text: unknown, rules: TextRules): Fault | null {
  if (typeof text !== 'string') return 'not_text'
  if (rules.isEmpty(text)) return 'empty'
  if (rules.length(text) > rules.maxLength) return 'too_long'
  if (BIDI.test(text)) return 'bidi'
  const visible = rules.allowedInvisible === undefined ? text : text.replace(rules.allowedInvisible, '')
  if (CONTROL.test(visible) || STACKED_MARKS.test(visible)) return 'control'
  return null
}

/** Free text is empty when it shows no letter and no numeral: only blanks, symbols and spaces. */
const SHOWS_SOMETHING = /[\p{L}\p{N}]/u

/**
 * Checks free text the page shows as the agent's own words (a task goal, N-009): the same checks as
 * a name up to the control one, without the allowlist and the digit rule, and with the joiners and
 * emoji variation selectors ordinary text needs allowed (`TEXT_JOINERS`, fix round 5). `maxLength`
 * is in UTF-16 code units (`string.length`), the unit validateScope in packages/contracts counts a
 * goal in, so the two agree on what is too long; a name is counted in code points instead. Null when
 * it may be shown. Throws a TypeError when `maxLength` is not a positive integer: that is the
 * caller's bug, not the agent's text.
 */
export function checkFreeText(text: string, maxLength: number): FreeTextRefusal | null {
  if (!Number.isInteger(maxLength) || maxLength <= 0) throw new TypeError(`checkFreeText: maxLength must be a positive integer, got ${String(maxLength)}`) // i18n-exempt: a programming error in the daemon, thrown to its caller, never shown to a person
  const fault = textFault(text, {
    maxLength,
    length: (value) => value.length,
    isEmpty: (value) => !SHOWS_SOMETHING.test(value),
    allowedInvisible: TEXT_JOINERS,
  })
  return fault === null ? null : `text_${fault}`
}

const LATIN = /[A-Za-z]/
const CYRILLIC = /[\u0401\u0410-\u044f\u0451]/u
/** Every character a name may carry (the allowlist of fix round 4): letters, digits, space, - _ . ( ) ' / +. */
const ALLOWED = /^[A-Za-z\u0401\u0410-\u044f\u0451 0-9\-_.()'/+]*$/u
/** A name is empty when it holds nothing but spaces and the allowed punctuation. */
const BLANK = /^[\p{White_Space}\-_.()'/+]*$/u

/**
 * A name reads as a code when it carries more than this many digits in total, whatever separates
 * them ("1 2 3", "12-34-56"). Only ASCII digits pass the allowlist, so only they are counted. Letters
 * that look like numerals (З, О, б) are not counted: the page shows the code in an element of its
 * own (SCR-23).
 */
const MAX_DIGITS = 2

/** The product's own name: a name any of whose reserved keys contains it is refused (`name_reserved`). */
const RESERVED = 'okolos'

/**
 * The reason the name is refused, or null when it may be shown. Every check reads the name in NFC
 * (fix round 5), so a letter written as a base and a combining mark (И and a breve) counts as the one
 * letter it composes to (Й); the caller stores and shows that NFC form. The checks run in this order, so
 * each reason stays the precise one: not text; empty; longer than MAX_NAME_LENGTH; a bidirectional
 * control; a control or invisible character; a character outside the allowlist, or Latin and
 * Cyrillic letters in one name (`name_script`); more than two digits; reads as "okolos".
 */
export function checkAgentName(raw: string): NameRefusal | null {
  if (typeof raw !== 'string') return 'name_not_text'
  const name = raw.normalize('NFC')
  const fault = textFault(name, { maxLength: MAX_NAME_LENGTH, length: (value) => [...value].length, isEmpty: (value) => BLANK.test(value) })
  if (fault !== null) return `name_${fault}`
  if (!ALLOWED.test(name) || (LATIN.test(name) && CYRILLIC.test(name))) return 'name_script'
  if ((name.match(/[0-9]/g)?.length ?? 0) > MAX_DIGITS) return 'name_digits'
  if (reservedKeys(name).some((key) => key.includes(RESERVED))) return 'name_reserved'
  return null
}

/** Cyrillic in Latin letters by sound, the fixed table of fix round 4. */
const TRANSLITERATION: Readonly<Record<string, string>> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'i', к: 'k',
  л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c',
  ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
}

/**
 * The Cyrillic letters that look like a Latin one, written as that letter; the rest by sound. Fix
 * round 6 adds the shapes п as n, г as r, ь and б as b, and з as e (it looks like a 3, read as e).
 */
const LOOK: Readonly<Record<string, string>> = {
  ...TRANSLITERATION,
  а: 'a', в: 'b', е: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x',
  п: 'n', г: 'r', ь: 'b', б: 'b', з: 'e',
}

/** The letter each digit reads as (fix round 5): 0 o, 1 l, 2 z, 3 e, 4 a, 5 s, 6 g, 7 t, 8 b, 9 g. */
const DIGIT_AS_LETTER: Readonly<Record<string, string>> = {
  '0': 'o', '1': 'l', '2': 'z', '3': 'e', '4': 'a', '5': 's', '6': 'g', '7': 't', '8': 'b', '9': 'g',
}

/** Shapes two letters make that read as one (fix round 5), folded after the single letters. */
const TWO_LETTER_SHAPES: readonly (readonly [RegExp, string])[] = [
  [/rn/g, 'm'],
  [/vv/g, 'w'],
  [/cl/g, 'd'],
]

/** How a key treats digits: `drop` them, or read each `asLetter`. */
type Digits = 'drop' | 'asLetter'

/**
 * One key of a name already in NFC and lower case: Cyrillic by the given table; everything but a-z
 * and 0-9 dropped; digits dropped or read as letters; i as l (a capital I is a small i by then).
 */
function letters(lower: string, cyrillic: Readonly<Record<string, string>>, digits: Digits): string {
  return [...lower]
    .map((char) => cyrillic[char] ?? char)
    .join('')
    .replace(/[^a-z0-9]/g, '')
    .replace(/[0-9]/g, (digit) => (digits === 'drop' ? '' : DIGIT_AS_LETTER[digit]!))
    .replace(/i/g, 'l')
}

function lowerNfc(name: string): string {
  return name.normalize('NFC').toLowerCase()
}

/**
 * The keys the reserved name is tested on (fix round 5): by sound and by look for Cyrillic, every
 * digit read as the letter it resembles, i as l; no two-letter shapes ("okolos" holds none).
 */
function reservedKeys(name: string): string[] {
  const lower = lowerNfc(name)
  return [letters(lower, TRANSLITERATION, 'asLetter'), letters(lower, LOOK, 'asLetter')]
}

/**
 * The keys two names are compared on, so names a person would read as one compare equal (fix rounds
 * 4 and 5): NFC; lower case; Cyrillic written in Latin letters; every character that is not a letter
 * or a digit dropped (spaces, - _ . ( ) ' / +); i as l (a capital I is a small i by then, so `CIaude`
 * is `claude`); then rn as m, vv as w, cl as d. Digits: one key drops them, so a number added to a
 * name does not make it another (`Claude 2` is `Claude`); one reads each as the letter it resembles,
 * so `C1aude` is `Claude`. A Cyrillic name has both of those by sound (`Околос` is `okolos`) and by
 * look (`Сосоа` is `cocoa`, `Сгоп` is `cron`). Duplicates are dropped, in this order: sound with digits
 * dropped, sound with digits as letters, look with digits dropped, look with digits as letters. An
 * empty key is dropped too (fix round 6): a name of digits alone has no letter left once they are
 * dropped, and two such names ("12", "34") are not one name. Used by the duplicate check
 * (`namesLookAlike`); the reserved name has keys of its own. Meant for names that pass the
 * allowlist; anything else is dropped from the key.
 */
export function nameKeys(name: string): string[] {
  const lower = lowerNfc(name)
  const keys: string[] = []
  for (const table of [TRANSLITERATION, LOOK]) {
    for (const digits of ['drop', 'asLetter'] as const) {
      keys.push(TWO_LETTER_SHAPES.reduce((key, [shape, letter]) => key.replace(shape, letter), letters(lower, table, digits)))
    }
  }
  return [...new Set(keys)].filter((key) => key !== '')
}

/** Two names look alike when they share a key; an empty key is no key (fix round 6). */
export function namesLookAlike(a: string, b: string): boolean {
  const keys = new Set(nameKeys(a))
  return nameKeys(b).some((k) => keys.has(k))
}

/**
 * The characters a stored name may never carry: controls, format characters, separators, lone
 * surrogates and the default-ignorables. Frozen for the store rule; the request rule has its own.
 */
const STORE_CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}\p{Default_Ignorable_Code_Point}]/u

/**
 * Whether a name read back from the pairing store may stand (fix round 5): a string in NFC, 1 to
 * MAX_NAME_LENGTH code points, with no bidirectional control and no control or default-ignorable
 * character. This store rule is deliberately looser than the request rule (`checkAgentName`: the
 * allowlist, the digits, the reserved name) and must stay so: the request rule may tighten in a later
 * release, and an agent paired under the old one must not lose its access when the daemon opens its
 * store. So this rule only ever loosens, and the schema carries no rule version.
 */
export function isStorableName(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name === name.normalize('NFC') &&
    [...name].length <= MAX_NAME_LENGTH &&
    !BIDI.test(name) &&
    !STORE_CONTROL.test(name)
  )
}
