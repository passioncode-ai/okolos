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
 * space, joiners, byte order mark), line and paragraph separators, lone surrogates, and every
 * character Unicode calls default-ignorable whatever its category (the combining grapheme joiner
 * U+034F, variation selectors, the Hangul fillers U+115F, U+1160, U+3164, U+FFA0).
 */
const CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}\p{Default_Ignorable_Code_Point}]/u

/** More than two combining marks in a row stack above or below one letter and crowd the page. */
const STACKED_MARKS = /\p{M}{3,}/u

type Fault = 'not_text' | 'empty' | 'too_long' | 'bidi' | 'control'

/**
 * The checks a name and free text share, in their order: not text, empty (as `isEmpty` says), longer
 * than `maxLength` code points, a bidirectional control, a control or invisible character or a stack
 * of combining marks. Bidirectional controls are format characters too; they are named first, for a
 * precise reason.
 */
function textFault(text: unknown, maxLength: number, isEmpty: (text: string) => boolean): Fault | null {
  if (typeof text !== 'string') return 'not_text'
  if (isEmpty(text)) return 'empty'
  if ([...text].length > maxLength) return 'too_long'
  if (BIDI.test(text)) return 'bidi'
  if (CONTROL.test(text) || STACKED_MARKS.test(text)) return 'control'
  return null
}

/** Free text is empty when it shows no letter and no numeral: only blanks, symbols and spaces. */
const SHOWS_SOMETHING = /[\p{L}\p{N}]/u

/**
 * Checks free text the page shows as the agent's own words (a task goal, N-009): the same checks as
 * a name up to the control one, without the allowlist and the digit rule. Null when it may be shown.
 */
export function checkFreeText(text: string, maxLength: number): FreeTextRefusal | null {
  const fault = textFault(text, maxLength, (value) => !SHOWS_SOMETHING.test(value))
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

/** The product's own name: a name any of whose keys contains it is refused (`name_reserved`). */
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
  const fault = textFault(name, MAX_NAME_LENGTH, (value) => BLANK.test(value))
  if (fault !== null) return `name_${fault}`
  if (!ALLOWED.test(name) || (LATIN.test(name) && CYRILLIC.test(name))) return 'name_script'
  if ((name.match(/[0-9]/g)?.length ?? 0) > MAX_DIGITS) return 'name_digits'
  if (nameKeys(name).some((key) => key.includes(RESERVED))) return 'name_reserved'
  return null
}

/** Cyrillic in Latin letters by sound, the fixed table of fix round 4. */
const TRANSLITERATION: Readonly<Record<string, string>> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'i', к: 'k',
  л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c',
  ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
}

/** The Cyrillic letters that look like a Latin one, written as that letter; the rest by sound. */
const LOOK: Readonly<Record<string, string>> = {
  ...TRANSLITERATION,
  а: 'a', в: 'b', е: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x',
}

/** What reads as an l (i, the digit one) or as an o (the digit zero), after lower case. */
const READS_AS: Readonly<Record<string, string>> = { i: 'l', '1': 'l', '0': 'o' }

function key(lower: string, cyrillic: Readonly<Record<string, string>>): string {
  return [...lower]
    .map((char) => cyrillic[char] ?? char)
    .join('')
    .replace(/[^a-z0-9]/g, '')
    .replace(/[i10]/g, (char) => READS_AS[char]!)
}

/**
 * The keys two names are compared on, so names a person would read as one compare equal (fix round
 * 4): NFC (fix round 5); lower case; Cyrillic written in Latin letters; every character that is not a letter or a digit
 * dropped (spaces, - _ . ( ) ' / +); i and the digit 1 as l, the digit 0 as o (a capital I is a small
 * i by then, so `CIaude` is `claude`). A Latin name has one key. A Cyrillic name has two: by sound
 * (`Околос` is `okolos`) and by look (`Сосоа` is `cocoa`), the same when they agree. The duplicate
 * check (`namesLookAlike`) and the reserved name both use them. Meant for names that pass the
 * allowlist; anything else is dropped from the key.
 */
export function nameKeys(name: string): string[] {
  const lower = name.normalize('NFC').toLowerCase()
  return [...new Set([key(lower, TRANSLITERATION), key(lower, LOOK)])]
}

/** Two names look alike when they share a key. */
export function namesLookAlike(a: string, b: string): boolean {
  const keys = new Set(nameKeys(a))
  return nameKeys(b).some((k) => keys.has(k))
}
