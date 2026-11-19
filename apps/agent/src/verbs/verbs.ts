/**
 * The verbs of Okolos Bridge Б1 as operations of the door (K3, N-011, REQ-55).
 *
 * Every page text an agent gets is built from the lines of a cleaned snapshot
 * (`cleanSnapshot`): `snapshot` pages them, `read` and `get text` join their
 * names, `get title` is the page's root line, `waitFor {text}` looks in them.
 * Nothing is read from the page any other way. A URL is answered without its
 * fragment. A page whose main document came from this device or the local
 * network is refused (`origin_not_in_task`, journalled as `local_answer`), and
 * one whose address Chrome did not report is refused as `cleaning_incomplete`.
 *
 * The strings here are read by the agent over MCP, not by a person; each is
 * marked so for the i18n sweep.
 */
import { randomBytes } from 'node:crypto'

import { CdpError, type CdpTransport } from '@okolos/cdp-pipe'
import {
  BRIDGE_VERBS,
  OKOLOS_READ_LIMIT,
  isLocalAddress,
  originOf,
  refuse,
  type AnyBridgeVerb,
  type BridgeError,
  type BridgeResult,
  type BridgeVerb,
  type CensusEntry,
  type SnapshotVerdict,
} from '@okolos/contracts'
import { clampMaxBytes, paginate, withoutFragment, type Snapshot, type SnapshotLine } from '@okolos/core-snapshot'
import * as z from 'zod'

import type { Operation, OperationOutcome } from '../door/door.js'
import type { ExtensionLink } from '../extension/link.js'
import { checkLanded, type Task, type Tasks } from '../tasks/tasks.js'
import type { AgentWindows } from '../window/window.js'
import { cleanSnapshot } from './page.js'

/** How long a navigation may take before `open` answers `internal`. */
export const NAVIGATION_TIMEOUT_MS = 30_000
/** The longest `waitFor` waits, whatever it is asked; and how often it looks. */
export const WAIT_MAX_MS = 30_000
export const WAIT_POLL_MS = 500
/** The longest address a verb takes. */
export const MAX_URL_CHARS = 2048

export interface VerbsDeps {
  readonly tasks: Tasks
  readonly windows: AgentWindows
  /** The probe's script (`buildAgentProbe`, or the file the release ships). */
  readonly probeSource: string
  readonly census: () => Promise<CensusEntry[]>
  /** The link to the Okolos extension (B-218); without it `okolos.ping` answers not connected. */
  readonly extension?: Pick<ExtensionLink, 'ask'>
  readonly now?: () => number
  /**
   * Only tests set it: the fixtures are served from 127.0.0.1. `main.ts` never passes it,
   * and a test reads main.ts for that (plan N-011, test 8).
   */
  readonly allowLoopbackForTests?: boolean
}

/** What the daemon keeps per task besides the task itself. */
interface TaskPage {
  readonly key: Uint8Array
  /** The main document's remote address, from `Network.responseReceived`; `''` until one came. */
  remoteIp: string
  mainFrameId: string
  /** The latest snapshot, which `snapshot {cursor}` pages and `open {ref}` resolves in. */
  last: { readonly snapshot: Snapshot; readonly verdict: SnapshotVerdict; readonly title: string } | undefined
}

const sessionId = z.string().min(1).max(64)
const ref = z.string().min(1).max(64)
const maxBytes = z.number().optional()

const scopeSchema = z.object({
  goal: z.string(),
  origins: z.object({ read: z.array(z.string()), write: z.array(z.string()) }),
  verbs: z.array(z.enum(BRIDGE_VERBS)),
  ttlSeconds: z.number(),
  stepBudget: z.number(),
  profile: z.enum(['agent', 'disposable']),
})

type Refused = { readonly success: false; readonly error: BridgeError; readonly journalCode?: 'local_answer' }

/** The journal's origin field, left out when the URL has none. */
function at(origin: string | null): { origin?: string } {
  return origin === null ? {} : { origin }
}

function fail(error: BridgeError, task?: Task, origin?: string): OperationOutcome {
  return { success: false, error, ...(task === undefined ? {} : { task: task.id }), ...(origin === undefined ? {} : { origin }) }
}

/** A CdpError as the contract's refusal (plan N-011, test 23). */
export function cdpRefusal(error: unknown): BridgeError {
  if (error instanceof CdpError) {
    if (error.kind === 'exited' || error.kind === 'closed' || error.kind === 'launch') return refuse('browser_offline', "The agents' Chrome did not answer.").error
    if (error.kind === 'cdp' && /target|session/i.test(error.message)) {
      // i18n-exempt: read by the agent over MCP, not by the person
      return refuse('tab_gone', "The task's window is gone.").error
    }
  }
  // i18n-exempt: read by the agent over MCP, not by the person
  return refuse('internal', 'The operation failed inside Okolos Agent.').error
}

/** The operations, and the hook that closes the windows of tasks closed elsewhere (revoked, expired). */
export type Verbs = Operation[] & { closeWindows(tasks: readonly Task[]): Promise<void> }

export function createVerbs(deps: VerbsDeps): Verbs {
  const now = deps.now ?? Date.now
  const pages = new Map<string, TaskPage>()

  /** The task, its window's session and the browser, or the refusal. */
  async function taskOf(agentId: string, id: string): Promise<BridgeResult<{ task: Task; session: string; browser: CdpTransport; page: TaskPage }>> {
    const got = deps.tasks.get(agentId, id, now())
    if (!got.success) return got
    const task = got.data
    const page = pages.get(task.id)
    const session = task.windowId === undefined ? undefined : deps.windows.sessionOf(task.windowId)
    // i18n-exempt: read by the agent over MCP, not by the person
    if (page === undefined || session === undefined) return refuse('tab_gone', "The task's window is gone.")
    return { success: true, data: { task, session, browser: await deps.windows.transport(), page } }
  }

  /** The URL the window is on, from Chrome's navigation history (the page cannot rewrite it). */
  async function currentUrl(browser: CdpTransport, session: string): Promise<string> {
    const history = await browser.send<{ currentIndex: number; entries: { url: string }[] }>('Page.getNavigationHistory', {}, session)
    return history.entries[history.currentIndex]?.url ?? 'about:blank'
  }

  /** The page may be read: it is still inside the task and its document did not come from this device. */
  async function readable(task: Task, browser: CdpTransport, session: string, page: TaskPage): Promise<Refused | { success: true; url: string }> {
    const url = await currentUrl(browser, session)
    const landed = checkLanded(task, url)
    if (!landed.success) return landed
    // i18n-exempt: read by the agent over MCP, not by the person
    if (page.remoteIp === '') return refuse('cleaning_incomplete', 'Chrome did not report where the page came from; no text was given.')
    if (!deps.allowLoopbackForTests && isLocalAddress(page.remoteIp)) {
      // i18n-exempt: read by the agent over MCP, not by the person
      return { ...refuse('origin_not_in_task', 'The site answered from an address on this device or the local network.'), journalCode: 'local_answer' }
    }
    return { success: true, url }
  }

  async function snapshotOf(browser: CdpTransport, session: string, page: TaskPage, rootRef?: string) {
    const result = await cleanSnapshot(browser, session, {
      taskKey: page.key,
      probeSource: deps.probeSource,
      now,
      ...(rootRef === undefined ? {} : { rootRef }),
      ...(page.last === undefined ? {} : { refMap: page.last.snapshot.refMap }),
    })
    if ('refused' in result) return result
    if (rootRef === undefined) page.last = result
    return result
  }

  /** Runs one verb: the task is found, charged, and the body's CdpError becomes a refusal. */
  function verb<I extends { sessionId: string }>(
    name: BridgeVerb,
    body: (input: I, ctx: { task: Task; session: string; browser: CdpTransport; page: TaskPage }) => Promise<OperationOutcome>,
    target?: (input: I) => string | undefined,
  ) {
    return async (input: I, call: { readonly agent: { readonly agentId: string } }): Promise<OperationOutcome> => {
      const found = await taskOf(call.agent.agentId, input.sessionId)
      if (!found.success) return fail(found.error)
      const { task } = found.data
      if (name !== 'close') {
        const charged = deps.tasks.charge(task, name, now(), target?.(input))
        if (!charged.success) return fail(charged.error, task)
      }
      try {
        return await body(input, found.data)
      } catch (error) {
        return fail(cdpRefusal(error), task)
      }
    }
  }

  const sessionOpen: Operation = {
    verb: 'session.open',
    // i18n-exempt: read by the agent over MCP, not by the person
    purpose: 'Opens a task: its goal, the sites it may read, its verbs, time and steps; answers the sessionId every other verb takes.',
    input: scopeSchema,
    gate: 'agent',
    example: {
      // i18n-exempt: an example input read by the agent over MCP, not by the person
      goal: 'Find the price of the cheapest plan',
      origins: { read: ['https://example.com'], write: [] },
      verbs: ['open', 'snapshot', 'read', 'close'],
      ttlSeconds: 600,
      stepBudget: 40,
      profile: 'disposable',
    },
    run: async (input, call) => {
      const opened = deps.tasks.open(call.agent.agentId, input, now())
      if (!opened.success) return fail(opened.error)
      const task = opened.data
      try {
        const window = await deps.windows.openWindow(task.scope.profile)
        const browser = await deps.windows.transport()
        const page: TaskPage = { key: new Uint8Array(randomBytes(32)), remoteIp: '', mainFrameId: '', last: undefined }
        pages.set(task.id, page)
        deps.tasks.setWindow(task, { windowId: window.targetId, windowOpen: true })
        browser.on<{ type: string; frameId?: string; response: { remoteIPAddress?: string } }>('Network.responseReceived', (params, from) => {
          if (from !== window.cdpSessionId || params.type !== 'Document' || params.frameId !== page.mainFrameId) return
          page.remoteIp = params.response.remoteIPAddress ?? ''
        })
        await browser.send('Network.enable', {}, window.cdpSessionId)
        await browser.send('Page.enable', {}, window.cdpSessionId)
        const { frameTree } = await browser.send<{ frameTree: { frame: { id: string } } }>('Page.getFrameTree', {}, window.cdpSessionId)
        page.mainFrameId = frameTree.frame.id
        return { success: true, data: { sessionId: task.id, windowId: window.targetId }, task: task.id }
      } catch (error) {
        deps.tasks.close(call.agent.agentId, task.id)
        pages.delete(task.id)
        return fail(cdpRefusal(error), task)
      }
    },
  }

  const open: Operation = {
    verb: 'open',
    // i18n-exempt: read by the agent over MCP, not by the person
    purpose: 'Opens an address of the task, or the link a ref of the latest snapshot names, in the task window; answers the address it landed on.',
    input: z.union([z.object({ sessionId, url: z.string().min(1).max(MAX_URL_CHARS) }), z.object({ sessionId, ref })]),
    gate: 'agent',
    example: { sessionId: '<from session.open>', url: 'https://example.com/pricing' },
    run: async (raw, call) => {
      const input = raw as { sessionId: string; url?: string; ref?: string }
      const found = await taskOf(call.agent.agentId, input.sessionId)
      if (!found.success) return fail(found.error)
      const { task, browser, session, page } = found.data
      let url = input.url
      try {
        if (url === undefined) {
          const backendNodeId = input.ref === undefined ? undefined : page.last?.snapshot.refMap.get(input.ref)
          // i18n-exempt: read by the agent over MCP, not by the person
          if (backendNodeId === undefined) return fail(refuse('stale_cursor', 'The ref is not from the latest snapshot; take a new one.').error, task)
          const { object } = await browser.send<{ object: { objectId?: string } }>('DOM.resolveNode', { backendNodeId }, session)
          const href = await browser.send<{ result: { value?: unknown } }>(
            'Runtime.callFunctionOn',
            { objectId: object.objectId, functionDeclaration: 'function () { return typeof this.href === "string" ? this.href : "" }', returnByValue: true },
            session,
          )
          url = typeof href.result.value === 'string' ? href.result.value : ''
          // i18n-exempt: read by the agent over MCP, not by the person
          if (url === '') return fail(refuse('stale_cursor', 'The ref names no link; take a new snapshot.').error, task)
        }
        const charged = deps.tasks.charge(task, 'open', now(), url)
        if (!charged.success) return fail(charged.error, task, originOf(url) ?? undefined)
        page.remoteIp = ''
        page.last = undefined
        const loaded = new Promise<void>((resolve) => {
          const off = browser.on('Page.loadEventFired', (_params, from) => {
            if (from === session) {
              off()
              resolve()
            }
          })
          setTimeout(() => {
            off()
            resolve()
          }, NAVIGATION_TIMEOUT_MS)
        })
        await browser.send('Page.navigate', { url }, session)
        await loaded
        const landed = await currentUrl(browser, session)
        const inside = checkLanded(task, landed)
        if (!inside.success) return fail(inside.error, task, originOf(landed) ?? undefined)
        return { success: true, data: { url: withoutFragment(landed) }, task: task.id, ...at(originOf(landed)) }
      } catch (error) {
        return fail(cdpRefusal(error), task)
      }
    },
  }

  const snapshot: Operation = {
    verb: 'snapshot',
    // i18n-exempt: read by the agent over MCP, not by the person
    purpose: 'The page of the task window as cleaned lines with refs, in pages of at most 32 KB; text hidden from people is never in it, and the verdict says what was cut.',
    input: z.object({ sessionId, ref: ref.optional(), cursor: z.string().max(64).optional(), maxBytes }),
    gate: 'agent',
    example: { sessionId: '<from session.open>' },
    run: verb<{ sessionId: string; ref?: string; cursor?: string; maxBytes?: number }>('snapshot', async (input, { task, browser, session, page }) => {
      const ok = await readable(task, browser, session, page)
      if (!ok.success) return { ...fail(ok.error, task), ...('journalCode' in ok ? { journalCode: ok.journalCode } : {}) }
      const origin = originOf(ok.url) ?? undefined
      let taken: { snapshot: Snapshot; verdict: SnapshotVerdict; title: string }
      if (input.cursor !== undefined) {
        // i18n-exempt: read by the agent over MCP, not by the person
        if (page.last === undefined) return fail(refuse('stale_cursor', 'There is no snapshot to page; take a new one.').error, task, origin)
        taken = page.last
      } else {
        const result = await snapshotOf(browser, session, page, input.ref)
        // i18n-exempt: read by the agent over MCP, not by the person
        if ('refused' in result) return fail(refuse('cleaning_incomplete', 'Cleaning did not finish; no text was given.').error, task, origin)
        taken = result
      }
      const pageOf = paginate(taken.snapshot.lines, { cursor: input.cursor, maxBytes: input.maxBytes, verdict: taken.verdict })
      // i18n-exempt: read by the agent over MCP, not by the person
      if ('refused' in pageOf) return fail(refuse('stale_cursor', 'The cursor is not from the latest snapshot.').error, task, origin)
      return { success: true, data: pageOf, task: task.id, ...(origin === undefined ? {} : { origin }), verdict: taken.verdict.level }
    }),
  }

  /** The text of cleaned lines: their names, one per line, within `maxBytes`. */
  function textOf(lines: readonly SnapshotLine[], limit: number | undefined): string {
    const cap = clampMaxBytes(limit ?? Number.NaN)
    const out: string[] = []
    let bytes = 0
    for (const line of lines) {
      if (line.name === '') continue
      const cost = Buffer.byteLength(line.name) + 1
      if (bytes + cost > cap) break
      out.push(line.name)
      bytes += cost
    }
    return out.join('\n')
  }

  async function cleanedFor(task: Task, browser: CdpTransport, session: string, page: TaskPage, rootRef?: string) {
    const ok = await readable(task, browser, session, page)
    if (!ok.success) return { refused: ok } as const
    const result = await snapshotOf(browser, session, page, rootRef)
    // i18n-exempt: read by the agent over MCP, not by the person
    if ('refused' in result) return { refused: refuse('cleaning_incomplete', 'Cleaning did not finish; no text was given.') } as const
    return { ...result, url: ok.url } as const
  }

  function refusedOutcome(refused: Refused, task: Task): OperationOutcome {
    return { ...fail(refused.error, task), ...(refused.journalCode === undefined ? {} : { journalCode: refused.journalCode }) }
  }

  const read: Operation = {
    verb: 'read',
    // i18n-exempt: read by the agent over MCP, not by the person
    purpose: "The text of the page, or of the part a ref names, from the cleaned snapshot only, inside a boundary with a nonce and the page's origin.",
    input: z.object({ sessionId, ref: ref.optional(), maxBytes }),
    gate: 'agent',
    example: { sessionId: '<from session.open>' },
    run: verb<{ sessionId: string; ref?: string; maxBytes?: number }>('read', async (input, { task, browser, session, page }) => {
      const cleaned = await cleanedFor(task, browser, session, page, input.ref)
      if ('refused' in cleaned) return refusedOutcome(cleaned.refused, task)
      const origin = originOf(cleaned.url) ?? 'null'
      return {
        success: true,
        data: { text: textOf(cleaned.snapshot.lines, input.maxBytes), boundary: { nonce: randomBytes(12).toString('hex'), origin } },
        task: task.id,
        origin,
        verdict: cleaned.verdict.level,
      }
    }),
  }

  const get: Operation = {
    verb: 'get',
    // i18n-exempt: read by the agent over MCP, not by the person
    purpose: "One value of the page: its address without the fragment, its title or text from the cleaned snapshot, or how many cleaned lines a ref's part has.",
    input: z.object({ sessionId, what: z.enum(['url', 'title', 'text', 'count']), ref: ref.optional() }),
    gate: 'agent',
    example: { sessionId: '<from session.open>', what: 'title' },
    run: verb<{ sessionId: string; what: 'url' | 'title' | 'text' | 'count'; ref?: string }>('get', async (input, { task, browser, session, page }) => {
      if (input.what === 'url') {
        const url = await currentUrl(browser, session)
        const landed = checkLanded(task, url)
        if (!landed.success) return fail(landed.error, task)
        return { success: true, data: { what: 'url', value: withoutFragment(url) }, task: task.id, ...at(originOf(url)) }
      }
      const cleaned = await cleanedFor(task, browser, session, page, input.what === 'title' ? undefined : input.ref)
      if ('refused' in cleaned) return refusedOutcome(cleaned.refused, task)
      const lines = cleaned.snapshot.lines
      const data =
        input.what === 'count'
          ? { what: 'count', value: lines.length }
          : input.what === 'title'
            ? { what: 'title', value: cleaned.title }
            : { what: 'text', value: textOf(lines, undefined) }
      return { success: true, data, task: task.id, ...at(originOf(cleaned.url)), verdict: cleaned.verdict.level }
    }),
  }

  const waitFor: Operation = {
    verb: 'waitFor',
    // i18n-exempt: read by the agent over MCP, not by the person
    purpose: `Waits for a time, for text to appear in the cleaned snapshot, or for the window to reach an address; at most ${WAIT_MAX_MS / 1000} s; answers whether it happened.`,
    input: z.union([
      z.object({ sessionId, ms: z.number().int().min(0) }),
      z.object({ sessionId, text: z.string().min(1).max(500) }),
      z.object({ sessionId, url: z.string().min(1).max(MAX_URL_CHARS) }),
    ]),
    gate: 'agent',
    example: { sessionId: '<from session.open>', text: 'Order confirmed' },
    run: verb<{ sessionId: string; ms?: number; text?: string; url?: string }>('waitFor', async (input, { task, browser, session, page }) => {
      if (input.ms !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(input.ms ?? 0, WAIT_MAX_MS)))
        return { success: true, data: { met: true }, task: task.id }
      }
      const deadline = now() + WAIT_MAX_MS
      for (;;) {
        if (input.url !== undefined) {
          const url = withoutFragment(await currentUrl(browser, session))
          if (url === withoutFragment(input.url)) return { success: true, data: { met: true }, task: task.id, ...at(originOf(url)) }
        } else {
          const cleaned = await cleanedFor(task, browser, session, page)
          if ('refused' in cleaned) return refusedOutcome(cleaned.refused, task)
          if (cleaned.snapshot.lines.some((l) => l.name.includes(input.text ?? ''))) {
            return { success: true, data: { met: true }, task: task.id, ...at(originOf(cleaned.url)), verdict: cleaned.verdict.level }
          }
        }
        if (now() >= deadline) return { success: true, data: { met: false }, task: task.id }
        await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_MS))
      }
    }),
  }

  const close: Operation = {
    verb: 'close',
    // i18n-exempt: read by the agent over MCP, not by the person
    purpose: 'Closes the task and its agent window; a disposable profile goes with it.',
    input: z.object({ sessionId }),
    gate: 'agent',
    example: { sessionId: '<from session.open>' },
    run: async (raw, call) => {
      const input = raw as { sessionId: string }
      const closed = deps.tasks.close(call.agent.agentId, input.sessionId)
      if (!closed.success) return fail(closed.error)
      await closeWindowOf(closed.data)
      return { success: true, data: { closed: true }, task: closed.data.id }
    },
  }

  async function closeWindowOf(task: Task): Promise<void> {
    pages.delete(task.id)
    if (task.windowId !== undefined) await deps.windows.closeWindow(task.windowId).catch(() => {})
  }

  const census: Operation = {
    verb: 'hygiene.census',
    // i18n-exempt: read by the agent over MCP, not by the person
    purpose: 'Lists the automation browsers and drivers running on this device, whose they are and which must not be touched; reads no page and ends nothing.',
    input: z.object({}).strict(),
    gate: 'agent',
    example: {},
    run: async () => ({ success: true, data: await deps.census() }),
  }

  const ping: Operation = {
    verb: 'okolos.ping',
    purpose: 'Asks the Okolos extension connected to Okolos Agent whether it answers, with its version; it looks for requests about once a minute, so this waits up to 90 seconds.',
    input: z.object({}).strict(),
    gate: 'agent',
    example: {},
    run: async () =>
      deps.extension === undefined
        ? // i18n-exempt: read by the agent over MCP, not by the person
          refuse('extension_not_connected', 'Okolos is not connected to Okolos Agent.')
        : deps.extension.ask('okolos.ping', {}),
  }

  /**
   * What an agent reads from Okolos (B-218 wave (b), spec 2026-11-19-agent-door-wave-b.md): the
   * extension answers each from what it holds, and never with page content (WB-1). The daemon
   * checks the input here and hands it over as is.
   */
  const list = z.object({ limit: z.number().int().min(1).max(OKOLOS_READ_LIMIT).optional() }).strict()
  const reads: ReadonlyArray<{ verb: AnyBridgeVerb; purpose: string; input: z.ZodType; example: unknown }> = [
    {
      verb: 'okolos.queue',
      // i18n-exempt: read by the agent over MCP, not by the person
      purpose: "Lists Okolos's open findings: category, severity, host and when, never what was found on the page; waits for the extension like okolos.ping.",
      input: list,
      example: { limit: 20 },
    },
    {
      verb: 'okolos.verdict',
      // i18n-exempt: read by the agent over MCP, not by the person
      purpose: "Says what Okolos holds about an http or https address's host: on a block list (which, since when), open findings by category, trusted by the person.",
      input: z.object({ url: z.string().url().max(2048).refine((url) => /^https?:\/\//i.test(url)) }).strict(),
      example: { url: 'https://example.com/login' },
    },
    {
      verb: 'okolos.journal',
      // i18n-exempt: read by the agent over MCP, not by the person
      purpose: "Lists the latest entries of Okolos's journal: kind, outcome, host and when, never the page's text.",
      input: list,
      example: { limit: 20 },
    },
    {
      verb: 'okolos.audit',
      // i18n-exempt: read by the agent over MCP, not by the person
      purpose: 'Lists what left this device through Okolos: when, where, why, the shape of what was sent and the outcome, as the outbound log shows it.',
      input: list,
      example: { limit: 20 },
    },
    {
      verb: 'okolos.extensions',
      // i18n-exempt: read by the agent over MCP, not by the person
      purpose: 'Lists the changes Okolos noticed in the browser extensions: which extension, what changed and when.',
      input: z.object({}).strict(),
      example: {},
    },
  ]
  const readOperations: Operation[] = reads.map(({ verb, purpose, input, example }) => ({
    verb,
    purpose,
    input,
    gate: 'agent',
    example,
    run: async (args: unknown) =>
      deps.extension === undefined
        ? // i18n-exempt: read by the agent over MCP, not by the person
          refuse('extension_not_connected', 'Okolos is not connected to Okolos Agent.')
        : deps.extension.ask(verb, args),
  }))

  const operations = [sessionOpen, open, snapshot, read, get, waitFor, close, census, ping, ...readOperations]
  return Object.assign(operations, {
    /** Closes the windows of tasks closed elsewhere (revoked, expired). */
    closeWindows: async (tasks: readonly Task[]) => {
      for (const task of tasks) await closeWindowOf(task)
    },
  })
}

