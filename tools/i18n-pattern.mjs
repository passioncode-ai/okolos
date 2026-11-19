/**
 * What counts as a user-facing sentence written in code, and what does not.
 *
 * Its own module because the sweep that uses it is a script with side effects — it
 * scans, it prints, it exits — so nothing in it could ever be called from a test. The
 * one load-bearing gate of this project had its pattern checked only by running it over
 * the tree and reading the output, which is how two whole classes of sentence stayed
 * invisible for weeks (B-76) and how a widening fix introduced a match that walked out
 * of one string literal and into the next.
 *
 * Every rule here is pinned by `tools/i18n-pattern.test.ts`, one case per class, with
 * the string that defeated the previous version quoted in the test.
 */

/**
 * One word — Latin or Cyrillic — optionally with an interpolation glued to it.
 *
 * Cyrillic joined on 2026-08-20. The anchor read `[A-Za-z]` and `\w`, which is
 * `[A-Za-z0-9_]` in JavaScript, so a Russian sentence hard-coded in a package was
 * invisible to this gate — and a Russian sentence in code ships **untranslated to the
 * English catalogue's readers**, which is the same defect as an English one mirrored.
 * Widening it found nothing in the tree, which is the answer worth having: the class was
 * uncovered rather than dirty.
 *
 * A short name is still not matched — `'Okolos: фишинг'` has no run of lowercase
 * words — and that is right. A name is not copy in the sense this gate is about, and
 * `tools/feed-names.test.ts` holds names to `docs/brand/terminology.md`.
 *
 * The apostrophe may only appear *inside* a word — `don't`, never `installed'`. Allowing
 * it at the end let a match walk out of one string literal and into the next: the union
 * in `core-extensions/src/diff.ts` reads `'newly-installed'; readonly severity: 'minor'`,
 * and a trailing apostrophe plus a semicolon turned that into a three-word "sentence"
 * spanning two quotes. Found by running the widened pattern over the tree, which is the
 * only way this class of defect ever shows up.
 */
export const WORD = String.raw`[A-Za-zА-ЯЁа-яё](?:[\wА-ЯЁа-яё-]|'(?=[A-Za-z]))*(?:\$\{[^}]*\})?`
export const LOWER = String.raw`[a-zа-яё](?:[\wА-ЯЁа-яё-]|'(?=[A-Za-z]))*(?:\$\{[^}]*\})?`

/**
 * What may sit between the quote and the first word.
 *
 * Interpolations — that is B-51's half. A single bracket, because a marker written as
 * `'[withheld: …]'` is a sentence in brackets and was invisible for it. And that is all:
 * a lead that swallows arbitrary characters is how a pattern stops being anchored.
 */
export const LEAD = String.raw`\s*[\[(]?\s*(?:\$\{[^}]*\}[\s,.:;!?-]*)*`

/**
 * **The body may hold a quote of another kind, and could not until 2026-08-21.** It was
 * `[^'"`]*` — no quote character at all — so a sentence in backticks with a nested double
 * quote never reached its closing delimiter and the whole match failed. That is exactly what
 * hid `\`Hidden text on this page addresses an assistant: "…"\`` in the content script: an
 * English sentence on the agent gate, the one surface a person meets mid-decision, in a
 * product that ships Russian first. Found by rendering the gate and reading it — this file's
 * own header already said a screenshot, not a count, is what finds these. The negated class
 * is now a lookahead against the delimiter itself, so group numbering is unchanged.
 *
 * A colon after the first word, and nothing else.
 *
 * `'Blocked: this page has an unresolved finding…'` was invisible to the anchored form:
 * the first word ends in punctuation, so the run of lowercase words never started. Four
 * of the six sentences in `core-gate` were hidden by exactly this, and the ceiling
 * counted two (B-76). A semicolon is *not* in the set — that is the character that let
 * a match cross a quote boundary, and no sentence worth catching needs it.
 */
export const SENTENCE = new RegExp(
  String.raw`(['"` +
    '`' +
    String.raw`])(${LEAD}${WORD}:?(?: ${LOWER}){2,}(?:(?!\1)[^\n])*)\1`,
  'g',
)

/**
 * A console call, whose arguments are not a product surface.
 *
 * Widening the anchor to catch a first word ending in a colon (B-76) surfaced twenty of
 * these at once — `console.warn('okolos: could not persist findings', cause)` — and every
 * one is a line for whoever has the devtools open. Skipped structurally rather than by
 * the `okolos: ` prefix: a naming convention nothing enforces would exempt any string
 * that copied the prefix, while "it is an argument to `console.*`" is a fact about the
 * code that a reader and this regex can both check.
 *
 * Not extended to `throw new Error(...)`, deliberately. A thrown message is caught
 * somewhere, and in this product several of those somewheres write it into the journal —
 * which the user reads and `exportAll` puts in a file. Those stay visible here and are
 * exempted one at a time, with the reason.
 */
export const CONSOLE = /\bconsole\.(?:warn|error|log|info|debug|trace)\s*\(/

/** Values that look like prose and are not: paths, MIME types, URLs. */
export const NOISE = /^(data-|https?:|chrome-extension:|application\/|text\/|[a-z]+\/[a-z]+$)/

/**
 * Every sentence in one line of source, as this project defines one.
 *
 * The line rather than the file: a marker sits above the code it explains, the comment
 * filter is a line rule, and the console rule needs to see what precedes the string.
 * `SENTENCE` carries `g`, so it is rebuilt per call — a shared regex with `lastIndex`
 * is a bug that only shows up on the second file.
 *
 * @param {string} line
 * @returns {string[]}
 */
export function sentencesIn(line) {
  const found = []
  const pattern = new RegExp(SENTENCE.source, 'g')
  for (const match of line.matchAll(pattern)) {
    const value = match[2]
    if (NOISE.test(value)) continue
    if (CONSOLE.test(line.slice(0, match.index))) continue
    found.push(value)
  }
  return found
}

/**
 * Is this line a comment? Comments explain; they are not shipped to anyone.
 *
 * `/*` is in the list because a one-line block comment starts with it and with nothing
 * else — checking only `*` and `//` scanned `/** the project's wrapper … *\/` as code
 * and read its apostrophe as an opening quote. The gate refused a push over a doc
 * comment, which is the false positive that teaches people to reach for a skip flag.
 *
 * @param {string} line
 * @returns {boolean}
 */
export function isComment(line) {
  const trimmed = line.trim()
  return trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')
}
