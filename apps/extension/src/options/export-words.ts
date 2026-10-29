import { WITHHELD_MARKER, type ExportWords, type Withheld } from '@okolos/storage'
import { t } from '@okolos/i18n'

import { HIBP_KEY_SETTING } from './leak-key.js'

/**
 * The words inside the file the user downloads.
 *
 * `exportAll` decides what is withheld — that is a promise about the data, and it lives
 * with the data. Until 2026-08-20 it also wrote the sentences explaining the decision,
 * in English, from a package whose dependencies are `@okolos/contracts` and `idb`
 * (B-75). The decision stayed; the words came here, where the catalogue is.
 *
 * Its own module rather than a const in the page, for the reason `gate-words.ts` is one:
 * `options/index.ts` builds the whole settings surface at import, so nothing in it can
 * be called from a test — and the note explaining what a file withholds is the last
 * thing that should be checked only by reading it.
 *
 * Resolved at write time, unlike a journal row. The file is a snapshot the user keeps
 * and re-reads in a text editor, not through this product: there is no later moment at
 * which anything could resolve a key, so the language is the one in force when they
 * asked for the file.
 */
export const EXPORT_WORDS: ExportWords = {
  /**
   * The marker stays, in every locale, and the reason follows it.
   *
   * `WITHHELD_MARKER` is a fixed token so that "is anything withheld from this file" is
   * answerable by search — by a reader who does not speak the interface language, and by
   * a test. The sentence after it says which of the two kinds of omission this is: a
   * value whose export would make the rest reversible, or a buffer named by its size.
   */
  marker: (item) => `${WITHHELD_MARKER} ${reasonFor(item)}`,

  /**
   * Paths, joined here rather than in the package: a comma between two of them is
   * punctuation, and punctuation belongs to the language it is read in. The paths
   * themselves are how the database names its own stores and fields, and stay as they
   * are — a person asking us about one has to be able to quote it back.
   */
  note: (withheld) =>
    withheld.length === 0
      ? t('exportNothingWithheld')
      : [
          t('exportWithheldNote', withheld.map((item) => item.path).join(', ')),
          ...[...new Set(withheld.map(kindOf))].map((kind) => WHY[kind]()),
        ].join(' '),
}

/**
 * Three kinds of omission, each with its own reason (B-125 round 2).
 *
 * There was one sentence for every value that was not a size, written for the
 * password-reuse key: "this value is what makes the rest reversible". Once a person could
 * save their Have I Been Pwned key, the file said that about it too, and it is false: that
 * key reverses nothing in the file. It is left out because it is theirs, which is the
 * reason the privacy page gives. The note likewise names only the reasons that apply to
 * what this file actually left out.
 */
type OmissionKind = 'own-key' | 'reversible' | 'size'

/** From the constant the settings screen writes with, so the path cannot drift from the key. */
const OWN_KEY_PATHS: ReadonlySet<string> = new Set([`settings/${HIBP_KEY_SETTING}`])

function kindOf(item: Withheld): OmissionKind {
  if (item.bytes !== undefined) return 'size'
  return OWN_KEY_PATHS.has(item.path) ? 'own-key' : 'reversible'
}

function reasonFor(item: Withheld): string {
  const kind = kindOf(item)
  if (kind === 'size') return t('exportWithheldBytes', String(item.bytes))
  return kind === 'own-key' ? t('exportWithheldOwnKey') : t('exportWithheldSecret')
}

/** Spelled out per kind: the locale gate reads keys from `t('…')`, not from a table of strings. */
const WHY: Readonly<Record<OmissionKind, () => string>> = {
  'own-key': () => t('exportWhyOwnKey'),
  reversible: () => t('exportWhyReuseKey'),
  size: () => t('exportWhyBytes'),
}
