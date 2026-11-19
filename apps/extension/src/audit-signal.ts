/**
 * «A row was written to the outbound log»: the background's word to the open self-audit panel
 * (SCR-10, B-234).
 *
 * The panel read the log once, when it was drawn. A request sent while it was open, the first
 * feed download of a fresh install included, stayed off it until the person reloaded the page:
 * the screen whose subject is what left the device was behind the device. Measured 2026-11-19:
 * `e2e/scn-019.spec.ts` opened the panel before the feed request was written and read «Nothing
 * has been sent» for fifteen seconds with the row already in `outbound_log`.
 *
 * A `BroadcastChannel` of the extension's own origin, so it reaches the extension's pages and
 * never a page on the web (a content script runs in the page's origin). The message carries
 * nothing: the panel reads the log again from the store, which is the record.
 */
export const AUDIT_CHANNEL = 'okolos:outbound'

type Channel = Pick<BroadcastChannel, 'postMessage' | 'close'>

/** Says a row was written. Best-effort: a context without the API has no panel to tell. */
export function signalAuditWritten(open: (name: string) => Channel | undefined = defaultOpen): void {
  const channel = open(AUDIT_CHANNEL)
  if (channel === undefined) return
  try {
    channel.postMessage(null)
  } finally {
    channel.close()
  }
}

/** Calls `onWritten` for every row written while the page is open. */
export function onAuditWritten(
  onWritten: () => void,
  open: (name: string) => Pick<BroadcastChannel, 'addEventListener'> | undefined = defaultOpen,
): void {
  open(AUDIT_CHANNEL)?.addEventListener('message', () => onWritten())
}

function defaultOpen(name: string): BroadcastChannel | undefined {
  return typeof BroadcastChannel === 'function' ? new BroadcastChannel(name) : undefined
}
