import { toSnapshotFinding } from '@okolos/contracts'
import type { SnapshotVerdict, Verdict } from '@okolos/contracts'

import type { Snapshot } from './snapshot.js'

/**
 * What the probe (`apps/extension/src/agent-probe.ts`) reports about one page,
 * reduced to the parts the verdict reads.
 */
export interface SnapshotProbe {
  readonly verdicts: readonly Verdict[]
  /** True when the collector hit its budget: the cut list may be incomplete. */
  readonly truncated: boolean
  /** Elements the probe meant to cut that it could not find again. */
  readonly unresolved: number
}

/** The answer when the cleaner could not finish: a refusal, with no text and no level. */
export interface CleaningIncomplete {
  readonly refused: 'cleaning_incomplete'
}

/**
 * The verdict sent with every page of a snapshot (spec §3, review R1).
 *
 * There is no "partly clean". A probe that stopped at its budget, or lost an
 * element it meant to cut, may have missed exactly the text that matters, and a
 * `clean` built on that would read as a pass the scan never earned. So either the
 * cleaning is complete and the agent gets a level, or it is not and the agent
 * gets a refusal and nothing else. A count of unresolved elements that is not a
 * plain zero (`NaN`, a negative, a fraction) is treated as incomplete too: the
 * only number that proves nothing was lost is 0.
 *
 * The snapshot is read too, and is required: a snapshot whose cleaner stopped at
 * its budget (`incomplete`) is refused the same way, and a call without one is
 * refused rather than trusted (certification round 1, seam).
 *
 * Each finding is built by `toSnapshotFinding` alone, so the snippet, the
 * locator and the free-form detail of a verdict never leave the daemon.
 */
export function snapshotVerdict(probe: SnapshotProbe, snapshot: Pick<Snapshot, 'incomplete'>): SnapshotVerdict | CleaningIncomplete {
  if (probe.truncated !== false || probe.unresolved !== 0) return { refused: 'cleaning_incomplete' }
  if ((snapshot as Partial<Snapshot> | undefined)?.incomplete !== false) return { refused: 'cleaning_incomplete' }
  const findings = probe.verdicts.map(toSnapshotFinding)
  return { level: findings.length === 0 ? 'clean' : 'finding', findings }
}
