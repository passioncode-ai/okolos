/**
 * What a list is called, as opposed to what it is keyed by.
 *
 * `phishing` is an identifier: it names a row in a table, a file at
 * `/feeds/phishing.json`, and a value in a signed update. It is not a name, and
 * the brand pack forbids showing one in place of the other — "владелец сайта не
 * должен читать `phishing` вместо названия списка". Until this module existed
 * he did, on the public status page and on every blocked page.
 *
 * Two consumers, one table:
 *
 *   - the **extension**, which is localised and asks the catalogue via `key`;
 *   - the **worker**, which serves one English page, has no catalogue, and
 *     reads `en` directly.
 *
 * `tools/feed-names.test.ts` asserts the two never disagree — the English here
 * must equal the English in the shipped catalogue — and that the worker
 * publishes exactly the identifiers listed below.
 *
 * **Third-party lists are not in this table on purpose.** OpenPhish, PhishTank,
 * URLhaus and Hudson Rock already call themselves by a human name, and the
 * terminology says those names are not translated. They pass through unchanged;
 * inventing a display name for someone else's list would be renaming it.
 */

export interface FeedName {
  /**
   * Catalogue key for the localised surfaces.
   *
   * Named `messageKey` rather than `key` so it is unmistakable at a glance and
   * to `tools/locales.test.ts`, which has to recognise a catalogue key held in
   * a field to know the key is asked for at all.
   */
  readonly messageKey: string
  /**
   * The Russian name, for the same reason and the same reader.
   *
   * `apps/proxy` serves `lang="ru"` pages with entirely Russian text, and it printed the
   * English name into them: «числится в списке **Okolos phishing list**» to a site owner
   * reading Russian (B-24). The extension resolves this through the catalogue; the worker
   * has none, so the literal lives here — beside the English one, where both are visible
   * at once and `docs/brand/terminology.md` can be checked against them.
   */
  readonly ru: string
}

/** The lists this project publishes itself. Everything else belongs to someone. */
export const OUR_FEEDS: Readonly<Record<string, FeedName>> = {
  phishing: { messageKey: 'feedNamePhishing', ru: 'Okolos: фишинг' },
}

/** Is this identifier one of ours, and therefore ours to name? */
export const isOurFeed = (identifier: string): boolean =>
  Object.hasOwn(OUR_FEEDS, identifier)

/**
 * The name to show a person.
 *
 * `translate` is the catalogue lookup; pass the extension's `t`. Everything inside the
 * extension uses this, the service worker included. `displayFeedNameRu` is for
 * `apps/proxy`, which serves public pages in Russian and has no catalogue to look in.
 *
 * There was a `displayFeedNameEn` beside it, and an `en` literal in the table, until
 * 2026-08-20. The proxy was its only caller and it was printing English into `lang="ru"`
 * pages (B-24); the English name the extension shows comes from the English catalogue,
 * where it already lived. Two copies of one name, and the unused one was the one being
 * printed.
 *
 * An identifier we do not publish is returned unchanged, because it is already
 * a name — see the note above.
 */
export function displayFeedName(
  identifier: string | null | undefined,
  translate: (key: string) => string,
): string | null {
  if (identifier === null || identifier === undefined || identifier === '') return null
  const known = OUR_FEEDS[identifier]
  return known ? translate(known.messageKey) : identifier
}

/** The same decision, for a surface with no catalogue. */
/**
 * The name for a Russian-language page, for the same caller and the same reason.
 *
 * A list somebody else publishes is returned unchanged: `OpenPhish` and `URLhaus` call
 * themselves that in every language, and translating a name is inventing a fact.
 */
export function displayFeedNameRu(identifier: string | null | undefined): string | null {
  if (identifier === null || identifier === undefined || identifier === '') return null
  return OUR_FEEDS[identifier]?.ru ?? identifier
}
