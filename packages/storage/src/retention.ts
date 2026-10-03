import type { OkolosDatabase } from './db.js'
import { RETENTION_DAYS } from './schema.js'

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Whether a record has outlived its window — and an unreadable date counts as
 * outlived, not as immortal.
 *
 * The first version read `Number.isFinite(at) && …`, so a row whose `createdAt`
 * could not be parsed was never deleted by anything, ever. Measured: after a sweep
 * the corrupt row was the one still there and the valid old one was gone. A record
 * whose age cannot be established cannot be held under a promise about age, and
 * `dueForSweep` two functions down already decided this the same way — "an
 * unreadable timestamp is not permission to skip". Deleting costs a row nobody can
 * date; keeping it breaks the only sentence the privacy page makes about time.
 */
function olderThan(iso: string, days: number, nowMs: number): boolean {
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return true
  return nowMs - at > days * DAY_MS
}

/** Whether a deferral's own deadline has passed, so the row is spent. */
function pastDeadline(iso: unknown, nowMs: number): boolean {
  if (typeof iso !== 'string') return true
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return true
  return at <= nowMs
}

/**
 * Whether enough time has passed since `lastAt` for the work to be owed again.
 *
 * An MV3 service worker starts many times a day — it wakes for every message a
 * content script sends, which is nearly every page — and `alarms.create`
 * replaces an alarm of the same name, so an alarm re-created on every start can
 * be reset before it ever fires. Any periodic job therefore needs a timestamp in
 * storage rather than a timer in memory or an alarm alone.
 *
 * Written once and used twice: the retention sweep had these four cases and the
 * feed pull had none of them, so the feed ran on every single wake-up. Four edge
 * cases duplicated across two callers are four edge cases that will disagree.
 */
export function dueAgain(
  lastAt: string | null | undefined,
  nowMs: number,
  intervalMs: number,
): boolean {
  // Never done is always owed.
  if (!lastAt) return true
  const at = Date.parse(lastAt)
  // An unreadable timestamp is not permission to skip: doing the work twice
  // costs a little, and skipping it silently costs the promise the work keeps.
  if (!Number.isFinite(at)) return true
  // A clock that moved backwards — a corrected system time, a restored profile —
  // would otherwise postpone the work indefinitely.
  if (at > nowMs) return true
  return nowMs - at >= intervalMs
}

/** How long a sweep may be skipped before the next startup owes one. */
export const SWEEP_INTERVAL_MS = 12 * 60 * 60 * 1000

/** Where the last sweep's timestamp lives, so the decision survives a restart. */
export const LAST_SWEEP_KEY = 'retention:lastSweptAt'

/**
 * How long the feed pull may be skipped. Six hours, which is the alarm's own
 * period and the cadence REQ-13 records.
 *
 * Without it, `void pullFeed()` ran on **every worker start** — and the worker
 * starts on nearly every page, because a content script messages it. Instead of
 * four requests a day the product made one per page, each writing a row to
 * `outbound_log` because the audit entry is mandatory *before* a request goes
 * out. So the self-audit panel — the screen whose whole subject is "here is what
 * left this device" — filled with `feed-update` and buried everything else.
 */
export const FEED_INTERVAL_MS = 6 * 60 * 60 * 1000

/**
 * Where the feed's last **attempt** is recorded — attempt, not success.
 *
 * A failed pull that left no mark would be retried on the next wake-up, which is
 * the flood again, with the added property that it only happens when something
 * is already wrong.
 */
export const LAST_FEED_KEY = 'feed:lastAttemptedAt'

/**
 * Whether a sweep is owed.
 *
 * The alarm alone could not be trusted with this. `alarms.create` replaces an
 * alarm of the same name, the background re-creates it on every start, and an
 * MV3 service worker starts many times a day — so a 24-hour alarm on a browser
 * in daily use can be reset before it ever fires, and the ninety-day promise
 * on the journal screen would be enforced by nothing at all.
 *
 * A timestamp in storage does not care how often the worker restarts: the
 * question at each start is only whether enough time has passed.
 */
export function dueForSweep(lastSweptAt: string | null | undefined, nowMs: number): boolean {
  return dueAgain(lastSweptAt, nowMs, SWEEP_INTERVAL_MS)
}

/**
 * How long the extension inventory may go unreviewed: a day.
 *
 * What it looks for is an extension that changed while nobody was watching, and that
 * does not need checking on every wake-up. It used to run at the top of the
 * background, so `management.getAll()` and a diff against every snapshot ran each
 * time a page messaged the worker, while the daily alarm meant to carry it was reset
 * before it could fire (LC-08).
 */
export const INVENTORY_INTERVAL_MS = 24 * 60 * 60 * 1000

/** Where the last inventory review is recorded — the attempt, like the feed's. */
export const LAST_INVENTORY_KEY = 'inventory:lastReviewedAt'

/** Whether an inventory review is owed. The same four cases, by construction. */
export function dueForInventory(lastReviewedAt: string | null | undefined, nowMs: number): boolean {
  return dueAgain(lastReviewedAt, nowMs, INVENTORY_INTERVAL_MS)
}

/** Whether a feed pull is owed. The same four cases, by construction. */
export function dueForFeed(lastAttemptedAt: string | null | undefined, nowMs: number): boolean {
  return dueAgain(lastAttemptedAt, nowMs, FEED_INTERVAL_MS)
}

/**
 * Runs on an alarm, not on a timer held in memory.
 *
 * Findings are the exception to the sweep: an unresolved one is work the user
 * still owes themselves, and deleting it because it got old would quietly
 * discard the only record that anything was wrong. Only a finding the user has
 * marked resolved ages out, and its clock starts at the resolution.
 */
export async function pruneExpired(db: OkolosDatabase, nowMs: number): Promise<void> {
  for (const entry of await db.getAll('journal')) {
    if (olderThan(entry.createdAt, RETENTION_DAYS.journal, nowMs)) {
      await db.delete('journal', entry.id)
    }
  }

  for (const entry of await db.getAll('outbound_log')) {
    if (olderThan(entry.createdAt, RETENTION_DAYS.outbound_log, nowMs)) {
      await db.delete('outbound_log', entry.id)
    }
  }

  for (const finding of await db.getAll('findings')) {
    if (finding.resolvedAt === null) continue
    if (olderThan(finding.resolvedAt, RETENTION_DAYS.resolvedFinding, nowMs)) {
      await db.delete('findings', finding.id)
    }
  }

  /**
   * `settings` holds bookkeeping and two kinds of row that accumulate.
   *
   * It was swept by nothing, which is how `seen:<host>` became a permanent
   * timestamped list of every site where a password or card field was focused —
   * the browsing history this product declined the `history` permission to avoid
   * having. The rest of the store is bookkeeping that is overwritten in place
   * (`popup:lastCheck`, the sweep's own timestamp) or a value that must outlive any
   * window: `reuse:key` cannot expire without orphaning every tag it made, and the
   * user's own HIBP credential is theirs to remove.
   */
  for (const setting of await db.getAll('settings')) {
    if (setting.key.startsWith('seen:')) {
      if (typeof setting.value !== 'string' || olderThan(setting.value, RETENTION_DAYS.seenHost, nowMs)) {
        await db.delete('settings', setting.key)
      }
      continue
    }

    // A deferral is spent the moment its own deadline passes: the popup stops
    // hiding the finding, and the row goes on saying "not now" about a moment
    // that is over.
    if (setting.key.startsWith('defer:') && pastDeadline(setting.value, nowMs)) {
      await db.delete('settings', setting.key)
    }
  }
}
