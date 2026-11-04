import { createPlatform, toSafeUrl, withDeadline } from './adapter.js'
import type { Platform, WebExtensionApi } from './types.js'

export { createPlatform, toSafeUrl, withDeadline }
export type {
  Alarms,
  Blocking,
  CreatedDownload,
  DataConsent,
  Downloads,
  Extensions,
  KeyValueStore,
  Platform,
  RpcHandler,
  RpcSender,
  Runtime,
  Tabs,
  WebExtensionApi,
} from './types.js'

declare const chrome: WebExtensionApi | undefined
declare const browser: WebExtensionApi | undefined

/**
 * Firefox exposes `browser` with promises; Chrome exposes `chrome`, which has
 * returned promises for MV3 APIs since Chrome 88. Detecting by global rather
 * than by user-agent keeps this honest when a fork ships either one.
 *
 * Firefox is told by `runtime.getBrowserInfo`, which only Firefox has, and not by `browser`
 * being there: recent Chromium offers a `browser` object too, and Chrome read as Firefox
 * (found 2026-11-04 in e2e, when the usage consent became the first thing to depend on the
 * kind: Chrome was then read as a Firefox with no built-in data consent).
 */
export function detectPlatform(): Platform {
  if (typeof browser !== 'undefined' && browser?.runtime && typeof (browser.runtime as { getBrowserInfo?: unknown }).getBrowserInfo === 'function') {
    return createPlatform('firefox', browser)
  }
  if (typeof chrome !== 'undefined' && chrome?.runtime) {
    return createPlatform('chrome', chrome)
  }
  if (typeof browser !== 'undefined' && browser?.runtime) {
    return createPlatform('chrome', browser)
  }
  throw new Error('No WebExtension API found: this build must run inside an extension context')
}
