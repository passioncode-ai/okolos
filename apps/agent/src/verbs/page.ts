/**
 * A cleaned snapshot of the page in an agent window (K3, N-011, REQ-55).
 *
 * The order is the guarantee. The page's scripts are paused first, so nothing
 * the page does can move between what the probe judged and what the tree
 * shows. The probe (the extension's own detector, bundled by
 * `tools/build-agent-probe.mjs`) runs in an isolated world the page cannot
 * reach and names the elements to cut; the accessibility tree is read; the
 * snapshot cuts them with everything under them and masks every secret field's
 * value wherever the page repeats it. A page that changed while it was read is
 * read once more, then refused. Scripts run again in `finally`, whatever
 * happened.
 */
import type { CdpTransport } from '@okolos/cdp-pipe'
import type { SnapshotVerdict, Verdict } from '@okolos/contracts'
import {
  buildSnapshot,
  hiddenInputIds,
  secretFieldIds,
  snapshotVerdict,
  type AxNode,
  type CdpDomNode,
  type Snapshot,
} from '@okolos/core-snapshot'

/** The isolated world the probe runs in; the page never sees it. */
export const PROBE_WORLD = 'okolos-agent-probe'

/** Object handles the probe hands across, released after every snapshot. */
const OBJECT_GROUP = 'okolos-agent-snapshot'

/** How many times a page that changed while it was read is read again before the refusal. */
export const SNAPSHOT_RETRIES = 1

export interface CleanSnapshotOptions {
  readonly taskKey: Uint8Array
  /** The probe's script, as `buildAgentProbe` answers it. */
  readonly probeSource: string
  readonly rootRef?: string
  readonly refMap?: ReadonlyMap<string, number>
  readonly now: () => number
}

export type CleanSnapshot =
  | { readonly snapshot: Snapshot; readonly verdict: SnapshotVerdict }
  | { readonly refused: 'cleaning_incomplete' }

interface ProbeCounts {
  readonly verdicts: readonly Verdict[]
  readonly truncated: boolean
  readonly unresolved: number
}

interface RemoteObject {
  readonly objectId?: string
  readonly value?: unknown
}

/**
 * What tells one reading of the page from another: the number of elements and
 * of text characters. Cheap, and a page that swaps a node changes it.
 */
const FINGERPRINT = '(() => { const all = document.getElementsByTagName("*"); return all.length + ":" + (document.documentElement?.textContent?.length ?? 0) })()'

export async function cleanSnapshot(browser: CdpTransport, sessionId: string, options: CleanSnapshotOptions): Promise<CleanSnapshot> {
  await browser.send('Emulation.setScriptExecutionDisabled', { value: true }, sessionId)
  try {
    for (let attempt = 0; attempt <= SNAPSHOT_RETRIES; attempt++) {
      const result = await readOnce(browser, sessionId, options)
      if (result !== 'changed') return result
    }
    return { refused: 'cleaning_incomplete' }
  } finally {
    await browser.send('Runtime.releaseObjectGroup', { objectGroup: OBJECT_GROUP }, sessionId).catch(() => {})
    await browser.send('Emulation.setScriptExecutionDisabled', { value: false }, sessionId)
  }
}

async function readOnce(browser: CdpTransport, sessionId: string, options: CleanSnapshotOptions): Promise<CleanSnapshot | 'changed'> {
  const contextId = await probeWorld(browser, sessionId, options.probeSource)
  const before = await evaluate(browser, sessionId, contextId, FINGERPRINT)
  const probe = await browser.send<{ result: RemoteObject; exceptionDetails?: unknown }>(
    'Runtime.evaluate',
    { expression: `globalThis.__okolosAgentProbe(${JSON.stringify(new Date(options.now()).toISOString())})`, contextId, objectGroup: OBJECT_GROUP },
    sessionId,
  )
  if (probe.exceptionDetails !== undefined || probe.result.objectId === undefined) return { refused: 'cleaning_incomplete' }
  const probeId = probe.result.objectId
  const counts = await callOn<ProbeCounts>(browser, sessionId, probeId, 'function () { return { verdicts: this.verdicts, truncated: this.truncated, unresolved: this.unresolved } }')
  const hidden = await backendIdsOf(browser, sessionId, probeId, 'cut')
  const flagged = await backendIdsOf(browser, sessionId, probeId, 'cutVisible')

  const { root } = await browser.send<{ root: CdpDomNode }>('DOM.getDocument', { depth: -1, pierce: true }, sessionId)
  const secretFields = secretFieldIds([root])
  for (const id of hiddenInputIds([root])) hidden.add(id)
  withDescendants(root, hidden)
  withDescendants(root, flagged)
  const domValues = await valuesOf(browser, sessionId, secretFields)
  const { nodes } = await browser.send<{ nodes: AxNode[] }>('Accessibility.getFullAXTree', {}, sessionId)

  const after = await evaluate(browser, sessionId, contextId, FINGERPRINT)
  if (before !== after) return 'changed'

  const snapshot = buildSnapshot(nodes, {
    hidden,
    flagged,
    secretFields,
    domValues,
    taskKey: options.taskKey,
    ...(options.rootRef === undefined ? {} : { rootRef: options.rootRef }),
    ...(options.refMap === undefined ? {} : { refMap: options.refMap }),
  })
  const verdict = snapshotVerdict(counts, snapshot)
  if ('refused' in verdict) return verdict
  return { snapshot, verdict }
}

/**
 * Adds to `ids` every DOM node under one already in it. The tree often has no
 * node for a cut element itself (a plain `span` is folded into its parent), and
 * its text then sits in the tree under the text node's own id, which the probe
 * never named (measured on Chrome 154: `font-size: 0` text reached the agent).
 */
export function withDescendants(root: CdpDomNode, ids: Set<number>): void {
  const stack: { node: CdpDomNode; under: boolean }[] = [{ node: root, under: false }]
  while (stack.length > 0) {
    const item = stack.pop()
    if (item === undefined) break
    const under = item.under || ids.has(item.node.backendNodeId)
    if (under) ids.add(item.node.backendNodeId)
    for (const child of [...(item.node.children ?? []), ...(item.node.shadowRoots ?? [])]) stack.push({ node: child, under })
    if (item.node.contentDocument !== undefined) stack.push({ node: item.node.contentDocument, under })
  }
}

/** A fresh isolated world on the main frame, with the probe loaded in it. */
async function probeWorld(browser: CdpTransport, sessionId: string, probeSource: string): Promise<number> {
  const { frameTree } = await browser.send<{ frameTree: { frame: { id: string } } }>('Page.getFrameTree', {}, sessionId)
  const { executionContextId } = await browser.send<{ executionContextId: number }>(
    'Page.createIsolatedWorld',
    { frameId: frameTree.frame.id, worldName: PROBE_WORLD, grantUniveralAccess: false },
    sessionId,
  )
  const loaded = await browser.send<{ exceptionDetails?: unknown }>('Runtime.evaluate', { expression: probeSource, contextId: executionContextId }, sessionId)
  // i18n-exempt: an internal error the daemon maps to cleaning_incomplete; never shown to a person
  if (loaded.exceptionDetails !== undefined) throw new Error('the agent probe did not load in the page')
  return executionContextId
}

async function evaluate(browser: CdpTransport, sessionId: string, contextId: number, expression: string): Promise<unknown> {
  const answer = await browser.send<{ result: RemoteObject }>('Runtime.evaluate', { expression, contextId, returnByValue: true }, sessionId)
  return answer.result.value
}

async function callOn<T>(browser: CdpTransport, sessionId: string, objectId: string, functionDeclaration: string): Promise<T> {
  const answer = await browser.send<{ result: RemoteObject }>(
    'Runtime.callFunctionOn',
    { objectId, functionDeclaration, returnByValue: true, objectGroup: OBJECT_GROUP },
    sessionId,
  )
  return answer.result.value as T
}

/** The backend node ids of the elements in `probe[field]`. */
async function backendIdsOf(browser: CdpTransport, sessionId: string, probeId: string, field: 'cut' | 'cutVisible'): Promise<Set<number>> {
  const list = await browser.send<{ result: RemoteObject }>(
    'Runtime.callFunctionOn',
    { objectId: probeId, functionDeclaration: `function () { return this.${field} }`, objectGroup: OBJECT_GROUP },
    sessionId,
  )
  const ids = new Set<number>()
  if (list.result.objectId === undefined) return ids
  const { result } = await browser.send<{ result: { name: string; value?: RemoteObject }[] }>(
    'Runtime.getProperties',
    { objectId: list.result.objectId, ownProperties: true },
    sessionId,
  )
  const elements = result.filter((p) => /^\d+$/.test(p.name) && p.value?.objectId !== undefined)
  const described = await Promise.all(
    elements.map((p) => browser.send<{ node: { backendNodeId: number } }>('DOM.describeNode', { objectId: p.value?.objectId }, sessionId)),
  )
  for (const { node } of described) ids.add(node.backendNodeId)
  return ids
}

/** The current value of each secret field, read from the element: the tree shows a password as dots. */
async function valuesOf(browser: CdpTransport, sessionId: string, fields: ReadonlySet<number>): Promise<Map<number, string>> {
  const values = new Map<number, string>()
  for (const backendNodeId of fields) {
    const { object } = await browser.send<{ object: RemoteObject }>('DOM.resolveNode', { backendNodeId, objectGroup: OBJECT_GROUP }, sessionId)
    if (object.objectId === undefined) continue
    const value = await callOn<unknown>(browser, sessionId, object.objectId, 'function () { return typeof this.value === "string" ? this.value : (this.textContent ?? "") }')
    if (typeof value === 'string' && value !== '') values.set(backendNodeId, value)
  }
  return values
}
