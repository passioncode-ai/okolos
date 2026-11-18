import type { DBSchema } from 'idb'
import type { AuditEntry, Verdict } from '@okolos/contracts'

export const DB_NAME = 'okolos'
export const DB_VERSION = 4

/**
 * Retention windows in days. They are short on purpose: a security tool that
 * accumulates a year of your browsing is the thing this product exists
 * against, and a window nobody can state is a window nobody enforces.
 */
export const RETENTION_DAYS = {
  journal: 90,
  outbound_log: 90,
  /** Counted from the moment the user resolved it, not from when it appeared. */
  resolvedFinding: 30,
  /**
   * `seen:<host>` — the "have I met this host before" note the credential guard
   * asks for.
   *
   * It had no window at all, so it grew into a permanent list of every site where
   * the user has ever focused a password or card field, timestamped to the second.
   * That is a browsing history, and the product refused the `history` permission
   * precisely so as not to have one. A year is long because the question it answers
   * is "is this site new to me", and a site visited eleven months ago is not new;
   * it is finite because "never" is what turned a lookup into a log.
   */
  seenHost: 365,
  /**
   * A row of the password-reuse index, counted from the **last** time that password was
   * submitted on that host (B-134).
   *
   * It had no window, and that was argued as a choice: ageing a row would understate
   * reuse. What it did instead was overstate it with rows nobody could clear: a password
   * changed a year ago still answered "already used on old.test", and the store was a
   * permanent list of every site where a password was ever submitted, the browsing
   * history `seenHost` above was given a window to stop being. Each submission refreshes
   * its row, so a password still in use is never aged out; only one not typed on that
   * host for a year is, and a year is the window `seenHost` already uses for the same
   * question of "is this site still part of my life".
   */
  reuse: 365,
  /**
   * The snapshot of an extension the daily review no longer finds, counted from the
   * first review that missed it (B-134).
   *
   * Until the user accepts the removal it keeps being reported, which is the point; but
   * an unaccepted removal used to be kept, and re-journalled every time the journal aged
   * its row out, forever. Ninety days is the journal's own window: by then the removal
   * has been on the journal screen for the whole time the journal keeps anything.
   */
  removedExtension: 90,
} as const

/**
 * Settings whose value is withheld from the export.
 *
 * Not because they are private — everything in this database is — but because
 * they are not *about* the user. They are what makes the rest of the file
 * reversible, and shipping them beside the data they protect turns one honest
 * button into the worst thing this product could hand someone.
 *
 * `reuse:key` is the HMAC key the reuse index is tagged with. Exported next to
 * the `reuse` store, it lets anyone holding the file run a dictionary of common
 * passwords against the tags and recover which password is used on which sites —
 * the exact inference the index exists to make impossible for anyone but the
 * device. `hibp:apiKey` is the user's own paid credential, which belongs to them
 * and to nobody who is handed their log.
 *
 * The tags themselves are exported. They *are* about the user — "these three
 * sites share a password" is the answer the feature gives — and without the key
 * they say nothing more than that.
 */
export const WITHHELD_SETTINGS: ReadonlySet<string> = new Set(['reuse:key', 'hibp:apiKey'])

/**
 * The token every withheld value is marked with, whatever language the note is in.
 *
 * It used to be the whole sentence — `'[withheld: this value is what makes the rest
 * reversible]'` — written in a package with two dependencies and no catalogue, into the
 * file a person downloads (B-75). The words are the caller's now; this stays so that
 * "is anything withheld from this file" is answerable by search, in any locale, by a
 * reader and by a test.
 */
export const WITHHELD_MARKER = '[withheld]'

export const STORES = [
  'findings',
  'journal',
  'outbound_log',
  'exceptions',
  'settings',
  'snapshots',
  'models',
  'feeds',
  'reuse',
] as const

export type StoreName = (typeof STORES)[number]

/**
 * One catalogue key per store, for the confirmation that asks before a wipe.
 *
 * `Record<StoreName, …>` and not an array, because the guarantee this needs is
 * exhaustiveness and TypeScript can hold it: adding a store to `STORES` fails the
 * build here until the confirmation has words for it. The wipe listed five kinds
 * while `wipeAll` cleared nine — `models`, `feeds`, `snapshots` and `reuse` went
 * unnamed, the last of them the index derived from the user's password that
 * `docs/privacy.md` gives its own section to. The user agreed to five and nine
 * went. Safe in direction and still a confirmation that did not ask, which is what
 * REQ-32 is about: the question names what is about to go, because "are you sure?"
 * tells the reader nothing they did not already know.
 *
 * It lives here rather than in `packages/ui` because completeness is a fact about
 * the stores, and `ui` does not depend on this package — the renderer cannot know
 * whether a list it was handed is all of them, so it is handed the whole list by
 * something that can.
 */
export const DATA_KIND_KEY: Readonly<Record<StoreName, string>> = {
  findings: 'dataKindFindings',
  journal: 'dataKindJournal',
  outbound_log: 'dataKindAudit',
  exceptions: 'dataKindExceptions',
  settings: 'dataKindSettings',
  snapshots: 'dataKindSnapshots',
  models: 'dataKindModels',
  feeds: 'dataKindFeeds',
  reuse: 'dataKindReuse',
}

export interface FindingRecord {
  id: string
  createdAt: string
  /** `page:<origin+path>` — the subject as the verdict named it. */
  subject: string
  /** ISO timestamp when the user handled it; null while it still needs them. */
  resolvedAt: string | null
  verdict?: Verdict
}

export interface JournalRecord {
  id: string
  createdAt: string
  /**
   * Three kinds, and `detector-disabled` was a fourth until 2026-08-20.
   *
   * It had four readers and no writer: the m0/m1 spec described a fuse that quenches a
   * failing detector for the session, and that was never built — nor should it be. A
   * quenched detector leaves a page unprotected in silence, while what the product
   * actually does is fail open, mark the page, and journal the cause once (`scan-failed`,
   * an `error` row). Vocabulary for a state that cannot occur makes every exhaustive
   * `Record<kind, …>` look complete while one entry can never be exercised.
   * `tools/journal-kinds.test.ts` now refuses a kind nothing writes.
   */
  kind: 'verdict' | 'action' | 'error'
  /**
   * `readonly string[]` is here for `explainArgs`.
   *
   * A journal entry stores what happened, not a sentence about it: a key and
   * its substitutions, resolved when the entry is read so the reader's language
   * decides rather than the language in force when the event occurred.
   *
   * `readonly (string | null)[]` for `explainArgKeys`, which is parallel to
   * `explainArgs` and holds a key where that position is a message of ours rather than
   * data — with `null` where it is data. Half-resolving at write time was how a reader
   * who switched language got their own sentence with one word of the old one in it
   * (B-77).
   */
  detail?: Readonly<
    Record<string, string | number | boolean | readonly string[] | readonly (string | null)[]>
  >
}

export interface ExceptionRecord {
  scope: 'domain' | 'rule' | 'extension'
  ref: string
  createdAt: string
  /**
   * A catalogue key, resolved when the row is read, so the reader's language
   * decides rather than the language in force when they clicked. The same
   * shape the journal already uses for `explainKey`.
   */
  reasonKey?: string
  /**
   * A sentence stored before that move. It stays as written — rewriting it to
   * look translated would be inventing which key it came from, and the trusted
   * list is a record of decisions, not a place to guess.
   */
  reason?: string
}

export interface SettingRecord {
  key: string
  value: string | number | boolean | null
}

/**
 * Classifier weights, kept whole rather than re-fetched.
 *
 * They live beside everything else so a wipe takes them too: a user who erases
 * their data would not expect a few dozen megabytes of downloaded model to
 * survive it.
 */
export interface ModelRecord {
  /** `<id>@<version>` — a version bump is a different row, never an overwrite. */
  key: string
  id: string
  version: string
  bytes: ArrayBuffer
  storedAt: string
}

/** The last verified snapshot of a feed, one row per feed name. */
export interface FeedRecord {
  name: string
  version: number
  updatedAt: string
  storedAt: string
  entries: string[]
}

/**
 * One password tag seen on one host.
 *
 * The tag is an HMAC over the digest the leak check already computes, keyed by
 * a random value generated on this device and never synchronised. It is not
 * reversible to a password without that key, and the key is wiped with
 * everything else — a device where it is readable is a device whose browser
 * password store is readable too, which is strictly more than this.
 *
 * `seenAt` is the **first** time this tag was recorded for this host, not the
 * latest: refreshing it on every login would make the index a record of when
 * the user last visited a site, which is browsing history under another name.
 */
export interface ReuseRecord {
  tag: string
  host: string
  seenAt: string
}

export interface SnapshotRecord {
  extensionId: string
  takenAt: string
  version: string
  permissions: readonly string[]
  publisher?: string
  /**
   * The extension's own name, so a removal can be reported in the words the
   * user knows it by.
   *
   * Absent in rows written before 2026-08-20, and the reader must not invent
   * one: it used to substitute the extension id, so "jhkfbmnopqrs is no longer
   * installed" was the sentence a person got about the thing they had chosen.
   */
  name?: string
  /**
   * The hosts it could read. **Optional because it was not stored at all** until
   * 2026-08-20, and the difference between "none" and "not recorded" is the whole
   * defect: read as none, every extension holding host permissions was reported
   * as having just widened its access, at severity `critical`, on every single
   * run. A row without this field means unknown, and unknown is not a comparison.
   */
  hostPermissions?: readonly string[]
  /** Whether it was enabled when the snapshot was taken. */
  enabled?: boolean
  /**
   * When the daily review first did not find this extension installed (B-134). Absent
   * while it is installed; the sweep deletes the row once this is older than
   * `RETENTION_DAYS.removedExtension`, and takes it back if the extension returns.
   */
  goneSince?: string
}

export interface OkolosDB extends DBSchema {
  findings: { key: string; value: FindingRecord; indexes: { 'by-created': string; 'by-subject': string } }
  journal: { key: string; value: JournalRecord; indexes: { 'by-created': string; 'by-kind': string } }
  outbound_log: { key: string; value: AuditEntry; indexes: { 'by-created': string; 'by-purpose': string } }
  exceptions: { key: [string, string]; value: ExceptionRecord; indexes: { 'by-created': string } }
  settings: { key: string; value: SettingRecord }
  models: { key: string; value: ModelRecord; indexes: { 'by-id': string } }
  feeds: { key: string; value: FeedRecord }
  snapshots: { key: string; value: SnapshotRecord }
  reuse: { key: [string, string]; value: ReuseRecord; indexes: { 'by-tag': string } }
}
