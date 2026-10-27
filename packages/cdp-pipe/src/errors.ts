/**
 * Why a CDP request failed, as data (REQ-54).
 *
 * A caller maps a failure to its own refusal (the daemon's tab_gone,
 * browser_offline, internal) by `kind`, not by reading the message: the text is
 * for a log and may be reworded, the kind may not.
 *
 *   timeout -> no answer within the request's deadline; the pipe is still usable
 *   cdp     -> the browser answered with an error; `cdpCode` is its code
 *   exited  -> the browser process ended; no answer can come any more
 *   closed  -> the pipe ended or broke, or its owner closed it; no answer can come
 *   launch  -> the browser could not be started (launch() only; method is 'launch')
 */
export type CdpErrorKind = 'timeout' | 'cdp' | 'exited' | 'closed' | 'launch'

export class CdpError extends Error {
  override readonly name = 'CdpError'
  readonly kind: CdpErrorKind
  /** The CDP method of the request that failed; 'launch' for kind launch. */
  readonly method: string
  /** The code of the browser's error answer; set only when kind is cdp. */
  readonly cdpCode?: number

  constructor(kind: CdpErrorKind, method: string, detail: string, cdpCode?: number) {
    super(`${method}: ${detail}`)
    this.kind = kind
    this.method = method
    if (cdpCode !== undefined) this.cdpCode = cdpCode
  }
}
