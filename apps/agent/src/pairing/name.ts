/**
 * The rules for the name an agent gives itself (spec §11 F12).
 *
 * Nothing verifies the name: the consent page shows it as the agent's own claim, next to the
 * six-digit code the person compares. So the name may not crowd the page, may not carry
 * numerals that could pass for the code, and may not carry a character that moves, hides or breaks
 * text. A refusal is a machine code; the page and the CLI map it through the catalogue.
 */

/** At most this many characters (code points, not UTF-16 units). */
export const MAX_NAME_LENGTH = 40

export type NameRefusal = 'name_not_text' | 'name_empty' | 'name_too_long' | 'name_digits' | 'name_bidi' | 'name_control'

/**
 * A name reads as a code when it carries this many numeric characters in total, whatever separates
 * them ("1 2 3", "12-34-56"), counting every kind Unicode calls numeric (\p{N}: fullwidth,
 * Arabic-Indic, superscript, circled, Roman). Fix round 1 of N-007, stricter than F12's "in a row".
 */
const MAX_NUMERIC = 2
const NUMERIC = /\p{N}/gu

/** The marks that reorder or isolate text: embeddings, overrides, isolates and the directional marks. */
const BIDI = /[؜‎‏‪-‮⁦-⁩]/u

/**
 * Control and invisible characters: C0 and C1 controls, the other format characters (zero-width
 * space, joiners, byte order mark), line and paragraph separators, and lone surrogates.
 */
const CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u

/** The reason the name is refused, or null when it may be shown. */
export function checkAgentName(name: string): NameRefusal | null {
  if (typeof name !== 'string') return 'name_not_text'
  if (name.trim() === '') return 'name_empty'
  if ([...name].length > MAX_NAME_LENGTH) return 'name_too_long'
  // Bidirectional marks are format characters too; they are named first, for a precise reason.
  if (BIDI.test(name)) return 'name_bidi'
  if (CONTROL.test(name)) return 'name_control'
  if ((name.match(NUMERIC)?.length ?? 0) > MAX_NUMERIC) return 'name_digits'
  return null
}
