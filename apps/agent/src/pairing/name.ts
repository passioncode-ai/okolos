/**
 * The rules for the name an agent gives itself (spec §11 F12).
 *
 * Nothing verifies the name: the consent page shows it as the agent's own claim, next to the
 * six-digit code the person compares. So the name may not crowd the page, may not carry
 * numerals that could pass for the code, and may not carry a character that moves, hides or breaks
 * text. Nor may it pass the agent off as Okolos itself: the page is Okolos speaking, so a name that
 * looks like it contains "okolos" is reserved. A refusal is a machine code; the page and the CLI map
 * it through the catalogue.
 */
import { skeleton } from '@okolos/core-lookalike'

/** At most this many characters (code points, not UTF-16 units). */
export const MAX_NAME_LENGTH = 40

export type NameRefusal =
  | 'name_not_text'
  | 'name_empty'
  | 'name_too_long'
  | 'name_digits'
  | 'name_bidi'
  | 'name_control'
  | 'name_reserved'

/**
 * A name reads as a code when it carries more than this many numeric characters in total, whatever
 * separates them ("1 2 3", "12-34-56"), counting every kind Unicode calls numeric (\p{N}: fullwidth,
 * Arabic-Indic, superscript, circled, Roman). Fix round 1 of N-007, stricter than F12's "in a row".
 * Fix round 3: they are counted after NFKC too, so one character that reads as two numerals (the
 * circled 21, U+3251) counts as two; the larger count decides, so a Roman numeral, which NFKC turns
 * into letters, still counts as one. Letters that look like numerals (З, О, б) are not counted: the
 * page shows the code in an element of its own (SCR-23).
 */
const MAX_NUMERIC = 2
const NUMERIC = /\p{N}/gu

function numerals(name: string): number {
  const count = (text: string): number => text.match(NUMERIC)?.length ?? 0
  return Math.max(count(name), count(name.normalize('NFKC')))
}

/** The marks that reorder or isolate text: embeddings, overrides, isolates and the directional marks. */
const BIDI = /[؜‎‏‪-‮⁦-⁩]/u

/**
 * Control and invisible characters: C0 and C1 controls, the other format characters (zero-width
 * space, joiners, byte order mark), line and paragraph separators, lone surrogates, and every
 * character Unicode calls default-ignorable whatever its category (fix round 3: the combining
 * grapheme joiner U+034F, variation selectors, the Hangul fillers U+115F, U+1160, U+3164, U+FFA0).
 */
const CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}\p{Default_Ignorable_Code_Point}]/u

/** More than two combining marks in a row stack above or below one letter and crowd the page. */
const STACKED_MARKS = /\p{M}{3,}/u

/** A name shows something: at least one letter or numeral, not only blanks, symbols and spaces. */
const VISIBLE = /[\p{L}\p{N}]/u

/**
 * What a name looks like, so two names a person would read as one compare equal: NFKC, case folded,
 * reduced by the Latin, Cyrillic and Greek look-alike table of @okolos/core-lookalike (`skeleton`,
 * the same one the link check uses), with runs of white space collapsed and the ends trimmed. The
 * pairing's duplicate check and the reserved name below both use it.
 */
export function nameSkeleton(name: string): string {
  return skeleton(name.normalize('NFKC').toLowerCase()).replace(/\s+/gu, ' ').trim()
}

/** The product's own name, as it looks: a name that contains it is refused (`name_reserved`). */
const RESERVED = nameSkeleton('okolos')

/** The reason the name is refused, or null when it may be shown. */
export function checkAgentName(name: string): NameRefusal | null {
  if (typeof name !== 'string') return 'name_not_text'
  if (name.trim() === '') return 'name_empty'
  if ([...name].length > MAX_NAME_LENGTH) return 'name_too_long'
  // Bidirectional marks are format characters too; they are named first, for a precise reason.
  if (BIDI.test(name)) return 'name_bidi'
  if (CONTROL.test(name) || STACKED_MARKS.test(name)) return 'name_control'
  if (!VISIBLE.test(name)) return 'name_empty'
  if (numerals(name) > MAX_NUMERIC) return 'name_digits'
  if (nameSkeleton(name).includes(RESERVED)) return 'name_reserved'
  return null
}
