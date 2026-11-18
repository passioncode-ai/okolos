/** How many entries of one name a document keeps before they are cleared (B-190). */
export const MARK_CAP = 100

/** The part of `Performance` the cap needs, so a test can hand in its own. */
export type Timeline = Pick<Performance, 'getEntriesByName' | 'clearMarks' | 'clearMeasures'>

/**
 * Writes an entry that accumulates, clearing that name once it holds `MARK_CAP`.
 *
 * `okolos:collect` was written on every scan and never cleared, and a page that keeps
 * changing is rescanned up to twice a second: 7 200 entries an hour on a page left open
 * (B-190). A reader counting rescans still sees them climb to the cap; past it the count
 * starts again from one, which no reader waits for.
 *
 * A page can have replaced the API, and a measurement is a fact for observers, never a reason
 * for a scan to fail: so nothing here throws.
 */
export function capped(timeline: Timeline, name: string, write: () => void): void {
  try {
    if (timeline.getEntriesByName(name).length >= MARK_CAP) {
      timeline.clearMarks(name)
      timeline.clearMeasures(name)
    }
    write()
  } catch {
    // Nothing to report is better than a scan reported as failed.
  }
}
