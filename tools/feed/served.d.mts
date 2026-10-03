/** Types for `served.mjs` (see `bounded.d.mts` for why these are hand-written). */

export const DEFAULT_WORKER: string
export const SERVED_TIMEOUT_MS: number

export type Served =
  | { readonly state: 'absent' }
  | {
      readonly state: 'served'
      readonly version: number
      readonly updatedAt: string | null
      readonly count: number
      readonly text: string
    }

export function readServed(options?: {
  base?: string
  name?: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
  now?: () => number
}): Promise<Served>

export function nextVersion(options: { served: number | null; local?: readonly number[] }): number
export function refuseBackwards(version: number, served: number | null | undefined): string | null
