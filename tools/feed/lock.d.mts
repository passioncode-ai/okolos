/** Types for `lock.mjs` (see `bounded.d.mts` for why these are hand-written). */

export interface FeedLock {
  readonly token: string
  readonly inherited: boolean
  release(): void
}

export class LockHeldError extends Error {
  readonly holder: { pid?: number; at?: string } | null
}

/** Takes the lock at `file`, or throws LockHeldError naming who holds it. */
export function acquireLock(file: string, options?: { inherited?: string }): FeedLock
