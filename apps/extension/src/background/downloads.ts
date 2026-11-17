
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
  /**
   * Stops a download and removes its file if the browser already wrote it, by the state the
   * browser reports (the adapter's `discard`). `true` only when nothing of it is left on disk.
   */
  stop(id: number): Promise<boolean>
  /**
   * One journal line. `whatKey` is a catalogue key resolved when the line is read, so the
   * reader's language decides; the line used to store the headline code itself, and a person
   * read "blocked: setup.exe" in their journal.
   */
  journal(entry: { whatKey: string; file: string; outcome: string }): Promise<void>
  /** `stopped` is present on a block only: whether the stop is confirmed (B-180, round 9). */
  announce(verdict: DownloadVerdict, item: DownloadItem, outcome?: { stopped: boolean }): Promise<void>
}

/**
 * Headline codes to the catalogue's sentences, for the journal line. A `*_KEY` table, the form
 * the locale gate reads; the content script keeps its own for the warning it draws.
 */
export const DOWNLOAD_HEADLINE_KEY: Record<DownloadVerdict['headline'], string> = {
  blocked: 'downloadHeadlineBlocked',
  unchecked: 'downloadHeadlineUnchecked',
  'needs-a-look': 'downloadHeadlineNeedsLook',
  'passed-all': 'downloadHeadlinePassedAll',
  'passed-what-ran': 'downloadHeadlinePassedWhatRan',
}

/** The journal's sentence for a block the browser outran (B-202); a table, for the locale gate. */
const JOURNAL_DOWNLOAD_KEY = { leftOnDisk: 'journalDownloadLeftOnDisk' } as const

/**
 * The verdict on one download, from its addresses, name, type and the feed. Pure: the same
 * item and feed give the same verdict.
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

/**
 * `named` is the same download once the browser has named the file (Chrome names it after
 * creating it). The feed check needs only the addresses, so it runs on the item as created and
 * a listed download is cancelled at once; only the checks that read the name wait for it
 * (round 8 of the B-165 certification: waiting for the name first let a listed file finish
 * before its cancel, under a panel saying nothing reached the disk).
 */
export async function handleDownload(
  created: DownloadItem,
  deps: DownloadDeps,
  named: Promise<DownloadItem> = Promise.resolve(created),
): Promise<DownloadVerdict> {
  const feed = await deps.feed().catch(() => null)
  const byAddress = judgeItem(created, feed)

  let item = created
  let verdict = byAddress
  let outcome: { stopped: boolean } | undefined
  if (byAddress.action === 'block') {
    // Stopped first, explained second. The order matters: the file must not
    // reach the disk while a banner is being drawn. A bare cancel was not enough
    // (round 9 of the B-180 certification): Chrome's cancel resolves for a download
    // that already finished and leaves the file, and a file of a few hundred bytes
    // finishes inside the feed read. So the stop looks again and removes what was
    // written, and the panel says "nothing reached the disk" only when it is confirmed.
    outcome = { stopped: await deps.stop(created.id).catch(() => false) }
  } else {
    item = await named.catch(() => created)
    verdict = item === created ? byAddress : judgeItem(item, feed)
  }

  // A block the browser outran is its own outcome: the file may be on the disk, and the line
  // says so even when no page was open to show the warning (B-202).
  const leftOnDisk = outcome !== undefined && !outcome.stopped
  await deps
    .journal({
      whatKey: leftOnDisk ? JOURNAL_DOWNLOAD_KEY.leftOnDisk : DOWNLOAD_HEADLINE_KEY[verdict.headline],
      file: item.filename || item.url,
      outcome: leftOnDisk ? 'block-left-on-disk' : verdict.action,
    })
    .catch(() => undefined)

  await (outcome ? deps.announce(verdict, item, outcome) : deps.announce(verdict, item)).catch(() => undefined)
  return verdict
}

/**
 * The person asked to delete a doubted download from its warning ("Delete file").
 *
 * Only the top frame's content script may ask: a frame inside the page is not where the warning
 * stands, and a page cannot message the extension at all. The download is not judged again here
 * (round 7): the warning the person answered is the judgement, and a second one could disagree
 * with it (a feed refreshed since, a name the browser reported late) and leave the button dead.
 */
export async function discardDownload(
  payload: unknown,
  from: { frameId?: number; tabId?: number },
  discard: (id: number) => Promise<boolean>,
  warnedTab: (id: number) => Promise<number | undefined>,
): Promise<{ ok: boolean }> {
  const downloadId = (payload as { downloadId?: unknown } | null)?.downloadId
  if (from.frameId !== 0 || typeof downloadId !== 'number' || !Number.isInteger(downloadId)) {
    return { ok: false }
  }
  /**
   * Only the tab the warning was shown in (B-181). Any top frame used to be able to name any
   * download id and have its file deleted; the id is a small counter, so a content script of
   * another tab could reach a file the person never saw a warning about.
   */
  const shownIn = await warnedTab(downloadId).catch(() => undefined)
  if (shownIn === undefined || from.tabId !== shownIn) return { ok: false }
  return { ok: await discard(downloadId).catch(() => false) }
}

/** How many warned downloads are remembered: enough for any session, bounded for storage. */
export const WARNED_DOWNLOADS_MAX = 50

/** Download id and the tab its warning went to. */
export type WarnedTabs = ReadonlyArray<readonly [number, number]>

/**
 * The record of which tab each download warning went to, newest last, bounded. Kept in the
 * extension's storage rather than memory, because the worker sleeps after half a minute and a
 * person may press "Delete file" later than that. A list of pairs, not an object: an object
 * orders integer keys by value, not by when they were written.
 */
export function rememberWarnedTab(
  record: WarnedTabs | undefined,
  downloadId: number,
  tabId: number,
): Array<[number, number]> {
  const kept: Array<[number, number]> = (Array.isArray(record) ? record : [])
    .filter((pair) => pair[0] !== downloadId)
    .map((pair) => [pair[0], pair[1]])
  kept.push([downloadId, tabId])
  return kept.slice(-WARNED_DOWNLOADS_MAX)
}

/** The tab the warning for this download went to, if it is still remembered. */
export function warnedTabOf(record: WarnedTabs | undefined, downloadId: number): number | undefined {
  if (!Array.isArray(record)) return undefined
  return record.find((pair) => pair[0] === downloadId)?.[1]
}
