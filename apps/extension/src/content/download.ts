import { t } from '@okolos/i18n'
import { mountBanner, type BannerHandle, type BannerHandlers, type BannerProps } from '@okolos/ui'

/**
 * The banner for a download the background judged.
 *
 * The judging happens in the worker, because that is where the browser reports
 * a download starting and where it can still be cancelled. The telling has to
 * happen here, because a worker has nowhere to say anything — and for a while
 * it did not happen at all: the worker announced its verdict to a message type
 * nobody listened for, so a blocked file was journalled and the person who
 * started it saw nothing.
 *
 * A blocked download has already been cancelled by the time this runs. The
 * banner says so rather than offering to stop it, and the way back is to fetch
 * the file again deliberately — an offer this surface does not make, because
 * re-downloading something the feeds named is a decision that belongs on the
 * page the user came from, not in a banner.
 */

export interface DownloadVerdictMessage {
  readonly action: string
  /** A code, not a sentence: the words are this module's (B-75). */
  readonly headline: string
  /** Facts about the file, as codes with the values their sentences need. */
  readonly shape: ReadonlyArray<{
    readonly code: string
    readonly filename?: string
    readonly mimeType?: string
  }>
  /** Words, resolved by whoever ran the checks. */
  readonly reasons: string
  readonly skipped: string
  /** The browser's id of the download; absent from an older background. */
  readonly downloadId?: number
}

/**
 * Headline codes to catalogue keys, and shape codes to theirs.
 *
 * `*_KEY` tables rather than a computed key, because that is the form the locale gate
 * reads — with `t(\`downloadHeadline${code}\`)` all ten of these messages would look
 * dead to it and the next sweep would offer to delete them.
 */
const HEADLINE_KEY: Record<string, string> = {
  blocked: 'downloadHeadlineBlocked',
  unchecked: 'downloadHeadlineUnchecked',
  'needs-a-look': 'downloadHeadlineNeedsLook',
  'passed-all': 'downloadHeadlinePassedAll',
  'passed-what-ran': 'downloadHeadlinePassedWhatRan',
}

const SHAPE_KEY: Record<string, string> = {
  'double-extension': 'downloadShapeDoubleExtension',
  'name-hides-a-program': 'downloadShapeNameHidesProgram',
  'type-is-a-program': 'downloadShapeTypeIsProgram',
  'is-a-program': 'downloadShapeIsProgram',
  'is-an-archive': 'downloadShapeIsArchive',
}

/**
 * The sentence for one shape fact.
 *
 * The substitutions are positional and the order differs per message, so each code
 * names its own arguments rather than passing a tuple every message has to accept.
 */
function shapeSentence(entry: DownloadVerdictMessage['shape'][number]): string {
  const key = SHAPE_KEY[entry.code]
  // An unknown code shows itself rather than nothing: wrong and visible beats wrong
  // and invisible, on a banner about a file somebody is about to open.
  if (key === undefined) return entry.code
  if (entry.code === 'double-extension') return t(key, entry.filename ?? '')
  if (entry.code === 'name-hides-a-program') return t(key, entry.mimeType ?? '')
  if (entry.code === 'type-is-a-program') return t(key, entry.filename ?? '', entry.mimeType ?? '')
  return t(key)
}

export interface DownloadNoticeDeps {
  readonly doc: Document
  /** Opens the journal, where the full record of the download lives. */
  openJournal: () => void
  /**
   * Asks the browser to cancel the download and delete its file; true when it did.
   * "Discard the file" used to only close the panel and leave the file on disk (B-165,
   * round 4 of the certification).
   */
  discard?: (downloadId: number) => Promise<boolean>
  /**
   * How a warning reaches the screen.
   *
   * Injected rather than imported so every source passes through the same slot. Six
   * modules mounted their own banner, and on a page that was both a lookalike and
   * poisoned two of them drew panels at identical coordinates — one exactly on top of
   * the other, the lower one unreadable (B-69). "One in-page panel" is a rule about
   * the surface, not about the source, so it cannot live in any one source.
   *
   * Optional so a test can leave it out and get the real thing; the entry point always
   * supplies the slot.
   */
  mountWarning?: (props: BannerProps, handlers: BannerHandlers) => BannerHandle
}

/** The injected mount, or the real one when a caller did not supply a slot. */
function mounting(deps: { readonly doc: Document; mountWarning?: (p: BannerProps, h: BannerHandlers) => BannerHandle }) {
  return (props: BannerProps, handlers: BannerHandlers): BannerHandle =>
    (deps.mountWarning ?? ((p, h) => mountBanner(deps.doc, p, h)))(props, handlers)
}

export function showDownloadVerdict(
  message: DownloadVerdictMessage,
  deps: DownloadNoticeDeps,
): BannerHandle | null {
  const mount = mounting(deps)
  // A file that passed everything is not news. Saying so on every download is
  // how a banner becomes wallpaper.
  if (message.action === 'inform') return null

  const blocked = message.action === 'block'
  let banner: BannerHandle | null = null
  const dismiss = () => {
    banner?.destroy()
    banner = null
  }
  const discard = () => {
    const id = message.downloadId
    const ask = deps.discard && typeof id === 'number' ? deps.discard(id).catch(() => false) : Promise.resolve(false)
    void ask.then((ok) => {
      if (ok) dismiss()
      else banner?.showError(t('warnDownloadDiscardFailed'))
    })
  }

  banner = mount(
    {
      variant: 'download',
      severity: blocked ? 'critical' : 'major',
      headline: blocked
        ? t('warnDownloadBlockedHeadline')
        : t(HEADLINE_KEY[message.headline] ?? 'warnDownloadBlockedHeadline'),
      detail: [
        message.reasons,
        message.shape.map(shapeSentence).join(' '),
        blocked ? t('warnDownloadCancelled') : '',
        message.skipped ? t('warnDownloadSkipped', message.skipped) : '',
      ]
        .filter(Boolean)
        .join(' '),
      sourceLine: t('warnFoundBy', t('warnDownloadSource')),
      // Not "Discard the file": the browser already did, and offering an action
      // nobody can take is worse than offering none.
      primaryLabel: blocked ? t('warnDownloadShowRecord') : t('bannerActionDownload'),
    },
    {
      onPrimary: blocked ? deps.openJournal : discard,
      onRetry: deps.openJournal,
      onDispute: dismiss,
      onDismiss: dismiss,
    },
  )

  return banner
}
