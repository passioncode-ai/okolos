import { createPlatform, toSafeUrl, withDeadline } from './adapter.js'
import type { Platform, WebExtensionApi } from './types.js'

export { createPlatform, toSafeUrl, withDeadline }
export type {
  Alarms,
  Blocking,
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
 */
export function detectPlatform(): Platform {
  if (typeof browser !== 'undefined' && browser?.runtime) {
    return createPlatform('firefox', browser)
  }
  if (typeof chrome !== 'undefined' && chrome?.runtime) {
    return createPlatform('chrome', chrome)
  }
  throw new Error('No WebExtension API found: this build must run inside an extension context')
}
