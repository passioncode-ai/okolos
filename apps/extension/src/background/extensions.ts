import { changeExplain } from '@okolos/ui/words'
import { diffInventory, type ExtensionSnapshot, type InventoryChange } from '@okolos/core-extensions'
import type { OkolosDatabase } from '@okolos/storage'

/**
 * Keeping track of what the other extensions are allowed to do.
 *
 * **Reading never writes. Only a decision writes.** That sentence is the whole
 * design and it replaces a single function that did both, which broke three ways
 * at once (measured 2026-08-20).
 *
 * The old `reviewInventory` compared, then recorded the new state as the
 * baseline, and it was called from three places: the daily alarm, the extensions
 * screen, and the area counter on the overview. The counter and the screen run
 * off the same handler, so **the first of them consumed the difference** — the
 * counter said "3 changes" and the screen, opened half a second later, said
 * nothing had changed. It also journalled on every screen open, so one permission
 * change became as many journal rows as the user had visits.
 *
 * A change is now an unacknowledged fact, exactly like a finding: it keeps being
 * reported until the user accepts it, and accepting is the one operation that
 * moves the baseline. Which also fixes what "Trust" did, or rather did not: it
 * wrote an `exceptions` row with `scope: 'extension'` that **nothing in the
 * repository ever read**, so the change came back on the next screen open and the
 * button was decoration.
 */

export interface InventoryDeps {
  readonly db: OkolosDatabase
  list(): Promise<readonly ExtensionSnapshot[]>
  now(): string
  /** This extension's own id, so it does not report on itself. */
  readonly selfId: string
}

/** What the snapshot store says this extension looked like last time. */
function restore(row: {
  extensionId: string
  version: string
  permissions: readonly string[]
  publisher?: string
  name?: string
  hostPermissions?: readonly string[]
  enabled?: boolean
}): ExtensionSnapshot {
  return {
    id: row.extensionId,
    // The id was used as the name until 2026-08-20, so a removal was reported as
    // "jhkfbmnopqrs is no longer installed" — about a thing the user chose by name.
    name: row.name ?? row.extensionId,
    version: row.version,
    permissions: [...row.permissions],
    // `undefined` becomes `null`: not recorded, and not comparable.
    hostPermissions: row.hostPermissions === undefined ? null : [...row.hostPermissions],
    publisher: row.publisher ?? null,
    enabled: row.enabled ?? true,
  }
}

function stored(entry: ExtensionSnapshot, takenAt: string) {
  return {
    extensionId: entry.id,
    takenAt,
    name: entry.name,
    version: entry.version,
    permissions: [...entry.permissions],
    hostPermissions: [...(entry.hostPermissions ?? [])],
    enabled: entry.enabled,
    ...(entry.publisher ? { publisher: entry.publisher } : {}),
  }
}

/**
 * Compares, and writes nothing — except the very first baseline.
 *
 * Recording a baseline where there was none consumes no difference, because
 * there was nothing to compare against; without it a fresh install would wait
 * for the daily alarm before it had anything to say.
 */
export async function compareInventory(deps: InventoryDeps): Promise<InventoryChange[]> {
  const current = (await deps.list()).filter((entry) => entry.id !== deps.selfId)
  const rows = await deps.db.getAll('snapshots')

  if (rows.length === 0) {
    const at = deps.now()
    /**
     * One transaction for the whole baseline, so nobody reads half of it.
     *
     * On a fresh profile the worker's start-up review and the extensions screen can both
     * arrive here. Written one row at a time, the baseline was visible half done, and a
     * reader in between diffed the full list against it and reported every extension not
     * yet stored as installed: a change on a profile nothing had changed (B-168). A
     * transaction is all or nothing to every other reader, and two first comparisons that
     * both found the store empty write the same rows.
     */
    const tx = deps.db.transaction('snapshots', 'readwrite')
    await Promise.all([...current.map((entry) => tx.store.put(stored(entry, at))), tx.done])
    // Reporting every installed extension as "newly installed" would bury the
    // one that matters under the twenty that do not.
    return []
  }

  return diffInventory(rows.map(restore), current)
}

/**
 * Accepting a change: the stored state becomes the current one, for this
 * extension only.
 *
 * Put for an extension that is still here, delete for one that is gone — the
 * removal of a snapshot row is what makes "no longer installed" stop being
 * reported, and it was never done anywhere, so a removal was reported forever.
 * Both cases are the same sentence: make the record agree with the world.
 */
export async function acceptInventoryChange(deps: InventoryDeps, id: string): Promise<void> {
  const current = (await deps.list()).find((entry) => entry.id === id)
  if (current) await deps.db.put('snapshots', stored(current, deps.now()))
  else await deps.db.delete('snapshots', id)
}

/**
 * Writes each change to the journal once, however often it is seen.
 *
 * The id used to carry the timestamp, so the daily alarm wrote a new row for the
 * same unaccepted change every day, and the screen wrote one per visit. One row
 * per extension and kind, and its detail is refreshed only when it actually
 * changed — otherwise `createdAt` would creep forward and the entry would claim
 * the change had just happened.
 */
export async function journalChanges(
  deps: InventoryDeps,
  changes: readonly InventoryChange[],
): Promise<void> {
  for (const change of changes) {
    const id = `extension:${change.id}:${change.kind}`
    const existing = await deps.db.get('journal', id)
    const explained = changeExplain(change)
    /**
     * Compared on the values, not on the sentence they make.
     *
     * The row used to hold a finished sentence and this compared that — so once the
     * words became the reader's (B-75), a browser switched to another language would
     * have rewritten every unaccepted row and pushed `createdAt` to today, making each
     * old change claim it had just happened. What changed is the key and its arguments.
     */
    if (
      existing &&
      existing.detail?.explainKey === explained.explainKey &&
      String(existing.detail?.explainArgs) === String(explained.explainArgs)
    ) {
      continue
    }
    await deps.db.put('journal', {
      id,
      createdAt: deps.now(),
      kind: 'verdict',
      detail: { ...explained, kind: change.kind, severity: change.severity },
    })
  }
}
