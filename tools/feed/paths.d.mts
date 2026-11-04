/** Types for `paths.mjs` (see `bounded.d.mts` for why these are hand-written). */

export interface FeedPaths {
  readonly state: string
  readonly feed: string
  readonly status: string
  readonly lock: string
  readonly logs: string
  readonly log: string
  readonly launchdLog: string
  readonly agentCheckout: string
  /** Where the installer copies the bootstrap launchd starts; outside the checkout (B-159). */
  readonly agentBin: string
  readonly bootstrap: string
}

export function feedPaths(env?: Record<string, string | undefined>, home?: string): FeedPaths
