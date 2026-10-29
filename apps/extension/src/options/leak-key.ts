import type { OkolosDatabase } from '@okolos/storage'

/**
 * The person's Have I Been Pwned key, as the settings screen writes it (B-125).
 *
 * The background read this setting for months and nothing wrote it, so the source it
 * unlocks was "not checked" for every user. It is written here, by the page the person
 * types it into, straight into the local store: it never crosses a runtime message, and
 * the background reads it only when a check is pressed.
 *
 * Declared in `WITHHELD_SETTINGS` (`packages/storage/src/schema.ts`), so the export puts a
 * marker where it would be; `tools/secrets.test.ts` finds this constant and checks that.
 */
export const HIBP_KEY_SETTING = 'hibp:apiKey'

/** Whether a key is saved. Deliberately not the key: no caller needs it back. */
export async function hasLeakKey(db: OkolosDatabase): Promise<boolean> {
  const value = (await db.get('settings', HIBP_KEY_SETTING))?.value
  return typeof value === 'string' && value !== ''
}

/** Saves the key, replacing any saved before. The caller has trimmed and checked it. */
export async function saveLeakKey(db: OkolosDatabase, key: string): Promise<void> {
  await db.put('settings', { key: HIBP_KEY_SETTING, value: key })
}

export async function removeLeakKey(db: OkolosDatabase): Promise<void> {
  await db.delete('settings', HIBP_KEY_SETTING)
}
