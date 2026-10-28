/**
 * Which downloads a page may ask the background to discard.
 *
 * `download/discard` deletes a file from the person's disk, and any content script in any
 * frame can send it. So the background acts only on a download it offered for discarding
 * itself: one whose doubted verdict it sent to a tab, asked for from that same tab, once
 * (round 5 of the B-165 certification: the handler took any id it was sent).
 */
export interface DownloadOffers {
  /** Called when a doubted verdict for `downloadId` was sent to `tabId` (null when unknown). */
  offer(downloadId: number, tabId: number | null): void
  /** True, and forgets the offer, when `downloadId` was offered to `tabId`. */
  take(downloadId: number, tabId: number | undefined): boolean
}

/** At most this many open offers; the oldest goes first. A page shows one download panel. */
const KEEP = 32

export function createDownloadOffers(): DownloadOffers {
  const offers = new Map<number, number | null>()
  return {
    offer(downloadId, tabId) {
      offers.delete(downloadId)
      offers.set(downloadId, tabId)
      while (offers.size > KEEP) offers.delete(offers.keys().next().value as number)
    },
    take(downloadId, tabId) {
      if (!offers.has(downloadId)) return false
      const offeredTo = offers.get(downloadId)
      if (offeredTo !== null && offeredTo !== tabId) return false
      offers.delete(downloadId)
      return true
    },
  }
}
