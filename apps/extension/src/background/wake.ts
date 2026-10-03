import { dueAgain } from '@okolos/storage'

/**
 * What a service-worker wake-up is allowed to cost (LC-08: idle means idle).
 *
 * An MV3 worker wakes for every page that messages it, so whatever sits at the top
 * of `background/index.ts` runs hundreds of times a day. Periodic work therefore
 * goes through `runIfDue` — a timestamp in storage, which does not care how often
 * the worker restarts — and the blocking rules are repaired through `ensureRules`
 * only at the moments they can be wrong, never rebuilt on a plain wake.
 * `wake.test.ts` counts a day of wake-ups against that budget on a fake clock.
 */

/** The background's alarms. Created only when missing (the adapter asks first). */
export const WAKE_ALARMS = [
  { name: 'okolos:feeds', periodInMinutes: 60 * 6 },
  { name: 'okolos:retention', periodInMinutes: 60 * 24 },
  { name: 'okolos:inventory', periodInMinutes: 60 * 24 },
] as const

/** Where a due-check keeps its last attempt. The background backs it with the `settings` store. */
export interface DueStore {
  get(key: string): Promise<string | null>
  put(key: string, iso: string): Promise<void>
}

/** An in-memory store, for tests and for a database that could not be opened. */
export function memoryDueStore(): DueStore {
  const values = new Map<string, string>()
  return {
    get: async (key) => values.get(key) ?? null,
    put: async (key, iso) => {
      values.set(key, iso)
    },
  }
}

/**
 * Runs `work` when `intervalMs` has passed since its last attempt, and says whether it ran.
 *
 * The attempt is recorded **before** the work: a job that throws would otherwise
 * leave no mark and run again on the next wake-up — the flood, but only when
 * something is already wrong. The work's own failure is caught and reported here so
 * one broken job cannot stop the others a wake-up starts.
 */
export async function runIfDue(
  store: DueStore,
  key: string,
  intervalMs: number,
  nowMs: number,
  work: () => Promise<void>,
): Promise<boolean> {
  if (!dueAgain(await store.get(key), nowMs, intervalMs)) return false
  await store.put(key, new Date(nowMs).toISOString())
  try {
    await work()
  } catch (cause) {
    console.warn(`okolos: ${key} failed; it is owed again after its interval`, cause)
  }
  return true
}

/**
 * Rebuilds the blocking rules only when the installed count differs from what the
 * stored feed would install.
 *
 * Called on browser start and on install/update — the moments the browser could
 * have lost or kept stale rules. Every change the extension itself makes (a feed
 * accepted, a site trusted or revoked) rebuilds through `refreshBlockRules`
 * directly, so a plain wake-up has nothing to repair. `expected` answers `null`
 * without a stored feed, which is also when the rebuild itself does nothing.
 */
export async function ensureRules(deps: {
  installed: () => Promise<number>
  expected: () => Promise<number | null>
  rebuild: () => Promise<unknown>
}): Promise<'kept' | 'rebuilt'> {
  const expected = await deps.expected()
  if (expected === null) return 'kept'
  if ((await deps.installed()) === expected) return 'kept'
  await deps.rebuild()
  return 'rebuilt'
}
