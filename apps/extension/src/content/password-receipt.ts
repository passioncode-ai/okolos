import type { BannerHandle, BannerHandlers, BannerProps } from '@okolos/ui'

/**
 * The leak panel and the receipt that says it was drawn.
 *
 * The background holds a compromised-password verdict until a surface says it showed
 * it, because the navigation a submission causes takes the asking document with it
 * (B-82). **When** the receipt is sent is the whole design: after the panel has stood
 * for `dwellMs`, at once when a person presses one of its controls, and never from a
 * document that is going away (`pagehide`).
 *
 * **And only for a panel that was drawn.** The receipt used to be armed before the claim
 * and sent whatever the slot answered. With a link warning holding the panel at
 * critical, the leak became an "also here" line, the background dropped its held copy
 * as delivered, and the line went with the link warning (seam reading, round 2 of the
 * B-165 certification). A refused claim now sends nothing, so the held copy waits for
 * the next surface that can draw it.
 */

export interface ReceiptDeps {
  /** The slot's `mountFor('password', …)`: null when another warning holds the panel. */
  mount(props: BannerProps, handlers: BannerHandlers): BannerHandle | null
  /** Tells the background the verdict was shown. */
  send(): void
  readonly dwellMs: number
  /** Registers what to do when the document is going away. */
  onPageHide(stop: () => void): void
}

export function claimWithReceipt(
  deps: ReceiptDeps,
  props: BannerProps,
  handlers: BannerHandlers,
): BannerHandle | null {
  let sent = false
  let dwell: ReturnType<typeof setTimeout> | null = null
  const receipt = () => {
    if (sent) return
    sent = true
    deps.send()
  }
  /** A person pressed a control: they have read it, which is what the receipt is about. */
  const read = () => {
    if (dwell !== null) clearTimeout(dwell)
    receipt()
  }

  const handle = deps.mount(props, {
    onPrimary: () => {
      read()
      handlers.onPrimary()
    },
    onRetry: handlers.onRetry,
    onDispute: () => {
      read()
      handlers.onDispute()
    },
    onDismiss: () => {
      read()
      handlers.onDismiss()
    },
  })
  if (handle === null) return null

  dwell = setTimeout(receipt, deps.dwellMs)
  deps.onPageHide(() => {
    if (dwell !== null) clearTimeout(dwell)
  })
  return handle
}
