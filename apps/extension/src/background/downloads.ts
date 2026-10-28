
import { t } from '@okolos/i18n'
import { judgeDownload, type CheckOutcome, type DownloadVerdict } from '@okolos/core-download'
import { matchUrl, type FeedSnapshot, displayFeedName } from '@okolos/core-feeds'

/**
 * Judging a download at the only moment it can be stopped.
 *
 * The check has to happen between the browser creating the item and the bytes
 * landing, which means the file itself does not exist yet — so the hash check
 * cannot run, ever, at this point. That is not a gap to paper over: it is
 * reported as a check that did not run, with the reason, and the verdict says
 * so instead of implying the file was cleared.
 */

export interface DownloadItem {
  readonly id: number
  readonly url: string
  /**
   * Where it actually came from, after redirects — absent when the browser has no such
   * field or the two are the same.
   *
   * The matrix promised the reputation check ran on `finalUrl` and the code read `url`:
   * a short link to a malicious host was checked against the short link, which is
   * listed nowhere (B-57).
   */
  readonly finalUrl?: string
  readonly filename: string
  readonly mime: string | null
}

export interface DownloadDeps {
  feed(): Promise<FeedSnapshot | null>
  cancel(id: number): Promise<void>
  journal(entry: { explain: string; outcome: string }): Promise<void>
  announce(verdict: DownloadVerdict, item: DownloadItem): Promise<void>
}

/**
 * The verdict on one download, from its addresses, name, type and the feed. Pure: the same
 * item and feed give the same verdict, so the background can judge a download again when a
 * page asks to discard it, instead of remembering what it offered (round 6 of the B-165
 * certification: an offer kept in the service worker's memory died with the worker).
 */
export function judgeItem(item: DownloadItem, feed: FeedSnapshot | null): DownloadVerdict {

  /**
   * Both addresses are checked, and either one listed is enough.
   *
   * A redirect is the ordinary way a malicious file is served: the link a page carries
   * is a shortener nobody lists, and the host it lands on is the one in the feed.
   * Checking one address was checking whichever address happened to be there.
   */
  const listed = feed !== null && [item.url, item.finalUrl].some((where) =>
    where === undefined ? false : matchUrl(where, feed),
  )
  const feedCheck: CheckOutcome = feed
    ? listed
      ? {
          ran: true,
          passed: false,
          // `displayFeedName`, not `…En`: this sentence comes out of the catalogue, and
          // an English list name substituted into a Russian one was the defect that
          // calling the other function "for the worker" made easy to miss (B-75).
          detail: t(
            'downloadListedBy',
            displayFeedName(feed.name, t) ?? feed.name,
            feed.updatedAt.slice(0, 10),
          ),
        }
      : { ran: true, passed: true }
    : { ran: false, why: t('downloadFeedUnread') }

  const verdict = judgeDownload({
    url: item.url,
    filename: item.filename,
    mimeType: item.mime,
    checks: {
      feed: feedCheck,
      'file-type': item.filename ? { ran: true, passed: true } : { ran: false, why: t('downloadNoFilename') },
      hash: {
        ran: false,
        why: t('downloadNotWritten'),
      },
    },
  })
  return verdict
}

export async function handleDownload(item: DownloadItem, deps: DownloadDeps): Promise<DownloadVerdict> {
  const feed = await deps.feed().catch(() => null)
  const verdict = judgeItem(item, feed)

  if (verdict.action === 'block') {
    // Cancelled first, explained second. The order matters: the file must not
    // reach the disk while a banner is being drawn.
    await deps.cancel(item.id).catch(() => undefined)
  }

  await deps
    .journal({
      explain: `${verdict.headline}: ${item.filename || item.url}`,
      outcome: verdict.action,
    })
    .catch(() => undefined)

  await deps.announce(verdict, item).catch(() => undefined)
  return verdict
}
