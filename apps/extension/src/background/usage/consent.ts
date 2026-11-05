/**
 * Whether usage and error data may be sent, by the browser's rules (B-199).
 *
 * The operator's decision is "on by default, off in settings". Chrome and Edge leave that to
 * the product, so collection starts on with the first-run notice. Firefox does not: since
 * 2025-11-03 a new extension declares `data_collection_permissions`, `technicalAndInteraction`
 * can only be optional, and the person turns it on or off in Firefox's own install prompt
 * (extensionworkshop.com, «Firefox built-in data consent»). There the browser's grant is the
 * consent, and the switch asks the browser. A Firefox without the built-in consent (129 to 139:
 * no `data_collection` key in `permissions.getAll()`) gets nothing sent at all, which is the
 * platform's second option and keeps the 129 floor.
 */

export type Browser = 'chrome' | 'firefox'
export type ConsentState = 'on' | 'off' | 'unsupported'

const DATA = { data_collection: ['technicalAndInteraction'] }

export interface ConsentApi {
  getAll?: () => Promise<{ data_collection?: string[] } & Record<string, unknown>>
  request?: (permissions: typeof DATA) => Promise<boolean>
  remove?: (permissions: typeof DATA) => Promise<boolean>
}

/** What the browser allows now, before the person's own switch is read. */
export async function browserConsent(browser: Browser, api: ConsentApi): Promise<ConsentState> {
  if (browser === 'chrome') return 'on'
  const granted = await firefoxGranted(api)
  if (granted === null) return 'unsupported'
  return granted ? 'on' : 'off'
}

/**
 * The settings switch. In Firefox it must run inside the click handler: `permissions.request`
 * refuses outside a user gesture, and a refusal reads as off, never as on.
 */
export async function switchConsent(browser: Browser, api: ConsentApi, on: boolean): Promise<ConsentState> {
  if (browser === 'chrome') return on ? 'on' : 'off'
  if (on) {
    // First, before any await: the click's moment ends at the first one, and Firefox refuses a
    // request made after it. A Firefox with no built-in consent refuses it too, and getAll then
    // says which of the two it was.
    const asked = (api.request?.(DATA) ?? Promise.resolve(false)).catch(() => false)
    const granted = await asked
    if ((await firefoxGranted(api)) === null) return 'unsupported'
    return granted ? 'on' : 'off'
  }
  if ((await firefoxGranted(api)) === null) return 'unsupported'
  await (api.remove?.(DATA) ?? Promise.resolve(false)).catch(() => false)
  return 'off'
}

/** `null` when this Firefox has no built-in data consent. */
async function firefoxGranted(api: ConsentApi): Promise<boolean | null> {
  if (!api.getAll) return null
  const all = await api.getAll().catch(() => null)
  if (all === null || !Array.isArray(all.data_collection)) return null
  return all.data_collection.includes('technicalAndInteraction')
}
