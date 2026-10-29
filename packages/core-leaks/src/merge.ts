/**
 * Putting several leak sources together, and saying which ones spoke.
 *
 * Every product in this category shows a number. Almost none say what that
 * number is a count *of* — and when one of three sources timed out, the number
 * silently shrinks and reads as good news. That is the failure this module
 * exists to prevent: coverage is reported alongside the findings, always, and
 * an inventory assembled from two of three sources says so in the same breath
 * as its total.
 *
 * Deduplication is by breach name and date rather than by source, because the
 * same breach appears in several corpora and counting it three times turns a
 * bad week into a catastrophe on screen.
 */

export interface Leak {
  /** The breach as its source names it — shown verbatim. */
  readonly name: string
  /** ISO date of the breach, when known. */
  readonly occurredAt: string | null
  readonly source: string
  /** What was exposed, in the source's own words. */
  readonly classes: readonly string[]
  /**
   * The breached service's domain, when the source gives one. It is what makes
   * "Change password" able to go somewhere rather than describe somewhere.
   */
  readonly domain?: string
}

/**
 * Why a source was not checked, when the reason is the person's own key: none is saved,
 * the source refused the one that is, or the one that is could not be read from the
 * device. Absent for every other reason, whose remedy is waiting rather than the key
 * (B-125). Only `missing` and `refused` have the key field as their remedy.
 */
export type KeyRemedy = 'missing' | 'refused' | 'unreadable'

/**
 * The breached-account source's name, as it calls itself. One constant because the screen
 * credits this source's data only when this source answered, and a second spelling would
 * make the credit vanish without a test noticing.
 */
export const HIBP_SOURCE = 'Have I Been Pwned'

/**
 * How a breach lookup records, in the outbound log's payload shape, that the person's key
 * went in its header: the header's name, never its value. The background writes it and the
 * self-audit summary counts it; one constant so the count cannot silently stop matching.
 */
export const HIBP_KEY_HEADER_SHAPE = 'header:hibp-api-key'

export type SourceStatus =
  | { readonly name: string; readonly answered: true; readonly leaks: readonly Leak[] }
  | {
      readonly name: string
      readonly answered: false
      readonly why: string
      readonly needsKey?: KeyRemedy
    }

export interface SourceReport {
  readonly name: string
  readonly answered: boolean
  readonly why?: string
  readonly needsKey?: KeyRemedy
}

export interface LeakInventory {
  readonly leaks: readonly Leak[]
  readonly sources: readonly SourceReport[]
  /** True when every source answered. */
  readonly complete: boolean
}

export function mergeLeaks(statuses: readonly SourceStatus[]): LeakInventory {
  const seen = new Map<string, Leak>()

  for (const status of statuses) {
    if (!status.answered) continue
    for (const leak of status.leaks) {
      // The same breach in three corpora is one breach. Counting it three times
      // turns a bad week into a catastrophe on screen.
      const key = `${leak.name.trim().toLowerCase()}|${leak.occurredAt ?? ''}`
      const existing = seen.get(key)
      if (!existing) {
        seen.set(key, leak)
        continue
      }
      seen.set(key, {
        ...existing,
        classes: [...new Set([...existing.classes, ...leak.classes])],
      })
    }
  }

  const sources: SourceReport[] = statuses.map((status) =>
    status.answered
      ? { name: status.name, answered: true }
      : {
          name: status.name,
          answered: false,
          why: status.why,
          ...(status.needsKey === undefined ? {} : { needsKey: status.needsKey }),
        },
  )
  const silent = sources.filter((source) => !source.answered)
  const leaks = [...seen.values()].sort(byDateDescending)

  return {
    leaks,
    sources,
    complete: silent.length === 0,
  }
}

function byDateDescending(a: Leak, b: Leak): number {
  if (a.occurredAt === b.occurredAt) return a.name.localeCompare(b.name)
  // Undated breaches go last: a missing date is not a recent one.
  if (a.occurredAt === null) return 1
  if (b.occurredAt === null) return -1
  return b.occurredAt.localeCompare(a.occurredAt)
}

