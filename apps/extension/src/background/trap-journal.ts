import type { OkolosDatabase } from '@okolos/storage'

/**
 * The "What changed" row a page trap warning writes.
 *
 * Out of the background entry so a test can reach it: the entry registers listeners on
 * import and cannot be loaded on its own.
 */

/** What each page trap is recorded as. `generic` covers one we cannot name. */
const TRAP_KEY: Record<string, string> = {
  clickfix: 'logTrapClickfix',
  techsupport: 'logTrapTechsupport',
  'outside-link': 'logTrapOutsideLink',
  generic: 'logTrapGeneric',
}

export interface TrapJournalDeps {
  readonly db: OkolosDatabase
  now(): string
}

/**
 * Rows written by this worker, so two in one millisecond get two ids.
 *
 * The id was `trap:<kind>:<ISO millisecond>` in a store keyed by id: two links a script
 * clicked in one loop wrote the same id and the second row replaced the first (round 2
 * of the B-165 certification). The counter separates rows inside one worker; the random
 * part separates a worker that restarted within the same millisecond, where the counter
 * starts again at zero.
 */
let written = 0

function suffix(): string {
  written += 1
  const random = globalThis.crypto?.randomUUID?.().slice(0, 8) ?? Math.random().toString(36).slice(2, 10)
  return `${written.toString(36)}-${random}`
}

export async function recordTrap(
  deps: TrapJournalDeps,
  payload: { kind: string; signals: string },
): Promise<void> {
  const now = deps.now()
  await deps.db.put('journal', {
    id: `trap:${payload.kind}:${now}:${suffix()}`,
    createdAt: now,
    kind: 'verdict',
    // A table, not a ternary: `tools/locales.test.ts` finds the keys a build asks for by
    // reading `*_KEY` tables, and nothing looser.
    detail: { explainKey: TRAP_KEY[payload.kind] ?? 'logTrapGeneric', signals: payload.signals },
  })
}
