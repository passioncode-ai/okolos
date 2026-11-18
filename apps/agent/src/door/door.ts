import type { IncomingMessage, ServerResponse } from 'node:http'

import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node'
import { McpServer } from '@modelcontextprotocol/server'
import { canonicalVerb, type AnyBridgeVerb, type BridgeError } from '@okolos/contracts'
import * as z from 'zod'

import { answerAfterRecord, journalTime, type Journal, type JournalEntry, type RejectionCode } from '../journal/journal.js'
import { PairingStoreError, type AgentRecord, type Pairing } from '../pairing/pairing.js'
import type { Route } from '../service/http.js'

/**
 * The door of Okolos Agent: the one way a paired agent reaches the browser (N-008, REQ-57).
 *
 * Three routes on the service's loopback port. `POST /pair` asks the person for access under a
 * name and answers a code to read out; `POST /pair/claim` collects the key once the person has
 * confirmed; `POST /mcp` is the MCP door itself, Streamable HTTP, for a request carrying a key.
 *
 * **Two tools, `search` and `execute`** (operator, 2026-11-18: «у MCP только два входа, поиск и
 * экзекьюция»). `search` answers the operations the door runs, each with its purpose, input
 * schema, gate and an example; `execute` runs one by name. An operation's name is a verb of the
 * bridge contract in its canonical spelling (`session.open`, `snapshot`), so the journal stores
 * exactly what the agent asked for. `search` reads only this list, reaches no page and carries
 * nothing of one, so like `tools/list` it is not journaled; every `execute` is, before its answer.
 *
 * **No browser is a client.** The service shell already refuses a foreign Host. The door refuses
 * more: any `Origin` header and the Fetch Metadata headers only a browser sends (`BROWSER_ONLY`), on
 * all three routes, because in Б1 no browser is meant to call the door. A refusal is journaled and
 * answers 403 with a JSON body and no `WWW-Authenticate`, so a client never starts OAuth.
 */

export const DOOR_PATHS = ['/mcp', '/pair', '/pair/claim'] as const

/** Where a request to `/mcp` carries the agent's key. The host token is not a key. */
export const AGENT_KEY_HEADER = 'x-okolos-agent-key'

/** The largest body the door reads; a call of the bridge's verbs is a few hundred bytes. */
export const MAX_BODY_BYTES = 64 * 1024

/** What an operation answers: the contract's result, with what the journal records of it. */
export type OperationOutcome =
  | {
      readonly success: true
      readonly data: unknown
      readonly task?: string
      readonly origin?: string
      readonly verdict?: 'clean' | 'finding'
    }
  | { readonly success: false; readonly error: BridgeError; readonly task?: string; readonly origin?: string }

/** One operation `execute` runs: a verb of the contract, with what `search` says about it. */
export interface Operation {
  readonly verb: AnyBridgeVerb
  /** One sentence for the agent: what the operation does and what it never does. */
  readonly purpose: string
  readonly input: z.ZodType
  /** `agent`: a paired agent may run it. Б1 has no operation gated on the person. */
  readonly gate: 'agent'
  /** A valid input, shown by `search`. */
  readonly example: unknown
  run(input: unknown, call: { readonly agent: AgentRecord }): Promise<OperationOutcome>
}

export interface DoorDeps {
  readonly pairing: Pairing
  readonly journal: Journal
  readonly operations: readonly Operation[]
  readonly version: string
  readonly now?: () => number
}

/** The operations `search` answers for `query`: every one when the query is empty, else those it names. */
export function searchOperations(operations: readonly Operation[], query: string | undefined) {
  const words = (query ?? '').toLowerCase().split(/\s+/).filter(Boolean)
  return operations
    .filter((op) => words.every((word) => `${op.verb} ${op.purpose}`.toLowerCase().includes(word)))
    .map((op) => ({
      operation: op.verb,
      purpose: op.purpose,
      gate: op.gate,
      inputSchema: z.toJSONSchema(op.input),
      example: op.example,
    }))
}

/**
 * The Fetch Metadata headers only a browser sends. Not `Sec-Fetch-Mode`: Node's own `fetch`
 * (undici) sends `sec-fetch-mode: cors` and nothing else of the family (measured on Node 26.10,
 * 2026-11-19), so refusing it would refuse the stdio shim and every Node MCP client. A browser
 * calling 127.0.0.1, a potentially trustworthy origin, sends `Sec-Fetch-Site` and `Sec-Fetch-Dest`
 * with it, and those are what give it away.
 */
const BROWSER_ONLY = ['sec-fetch-site', 'sec-fetch-dest', 'sec-fetch-user'] as const

/** Why a request is a browser's: the header that gave it away, or null. */
function browserSign(req: IncomingMessage): Extract<RejectionCode, 'bad_origin' | 'cross_site'> | null {
  if (req.headers.origin !== undefined) return 'bad_origin'
  if (BROWSER_ONLY.some((name) => req.headers[name] !== undefined)) return 'cross_site'
  return null
}

function send(res: ServerResponse, status: number, body: unknown): true {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
  return true
}

async function readBody(req: IncomingMessage): Promise<string | null> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) return null
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function parse(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch {
    return { ok: false }
  }
}

/** The journal's view of the agent behind a call. */
function caller(agent: AgentRecord): { agent: string; agentId: string; pairedAt: string } {
  return { agent: agent.name, agentId: agent.agentId, pairedAt: journalTime(agent.pairedAt) }
}

/** The door's routes, one function the service's route list takes. */
export function door(deps: DoorDeps): Route {
  const now = deps.now ?? Date.now

  const reject = async (res: ServerResponse, status: number, code: RejectionCode, origin?: string | null): Promise<true> => {
    // A rejection the journal could not write is still a rejection: the request gets its 403.
    await deps.journal
      .record({ at: journalTime(now()), outcome: 'rejected', code, ...(origin === undefined ? {} : { origin }) })
      .catch(() => undefined)
    return send(res, status, { error: code })
  }

  const route: Route = async (req, res, ctx) => {
    const path = ctx.url.pathname
    if (!(DOOR_PATHS as readonly string[]).includes(path)) return false

    const sign = browserSign(req)
    if (sign !== null) return reject(res, 403, sign, req.headers.origin ?? null)
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST')
      return send(res, 405, { error: 'method_not_allowed' })
    }
    if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) return reject(res, 415, 'bad_content_type')

    if (path === '/mcp') return mcp(req, res)

    const text = await readBody(req)
    const body = text === null ? null : parse(text)
    if (body === null || !body.ok || typeof body.value !== 'object' || body.value === null) {
      return send(res, 400, { error: 'bad_request' })
    }
    const fields = body.value as Record<string, unknown>
    try {
      if (path === '/pair') {
        const asked = deps.pairing.request(String(fields.name ?? ''), now())
        return 'refused' in asked ? send(res, asked.refused === 'too_many_requests' ? 429 : 400, { error: asked.refused }) : send(res, 200, asked)
      }
      const claimed = deps.pairing.claim(String(fields.requestId ?? ''), now())
      if ('key' in claimed) return send(res, 200, claimed)
      if ('pending' in claimed) return send(res, 202, claimed)
      return send(res, 403, { error: claimed.refused })
    } catch (error) {
      if (error instanceof PairingStoreError) return reject(res, 503, 'store_unreadable')
      throw error
    }
  }

  async function mcp(req: IncomingMessage, res: ServerResponse): Promise<true> {
    const key = req.headers[AGENT_KEY_HEADER]
    let agent: AgentRecord | null
    try {
      agent = typeof key === 'string' && key !== '' ? deps.pairing.verify(key) : null
    } catch (error) {
      if (error instanceof PairingStoreError) return reject(res, 503, 'store_unreadable')
      throw error
    }
    // No key, or one nobody holds: 403 with no WWW-Authenticate, and no pairing request is made.
    if (agent === null) return reject(res, 403, 'not_paired')
    try {
      deps.pairing.touch(agent.agentId, now())
    } catch {
      // The last-call time is bookkeeping; a store that will not take it does not refuse the call.
    }

    const text = await readBody(req)
    const body = text === null ? null : parse(text)
    if (body === null || !body.ok) {
      // A body that does not parse is one `bad_call` entry, and a JSON-RPC parse error.
      const entry: JournalEntry = { at: journalTime(now()), ...caller(agent), outcome: 'refused', verb: 'unknown', code: 'bad_call' }
      await answerAfterRecord(deps.journal, entry, () => undefined)
      return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
    }

    const server = serverFor(agent)
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    await server.connect(transport)
    try {
      await transport.handleRequest(req, res, body.value)
    } finally {
      await server.close().catch(() => undefined)
    }
    return true
  }

  function serverFor(agent: AgentRecord): McpServer {
    const server = new McpServer({ name: 'okolos-agent', version: deps.version })

    server.registerTool(
      'search',
      {
        description:
          'The operations Okolos Agent runs for you, each with its purpose, input schema, gate and an example. ' +
          'Words in `query` narrow the list; an empty query lists them all.',
        inputSchema: z.object({ query: z.string().max(200).optional() }),
      },
      async ({ query }) => ({
        content: [{ type: 'text' as const, text: JSON.stringify(searchOperations(deps.operations, query)) }],
      }),
    )

    server.registerTool(
      'execute',
      {
        description:
          'Runs one operation that `search` returned, by its name, with its arguments. ' +
          'Every call is written to the person\'s journal before you get the answer.',
        inputSchema: z.object({ operation: z.string().max(64), arguments: z.record(z.string(), z.unknown()).optional() }),
      },
      async ({ operation, arguments: args }) => {
        const who = caller(agent)
        const verb = canonicalVerb(operation) ?? deps.operations.find((op) => op.verb === operation)?.verb ?? null
        const op = verb === null ? undefined : deps.operations.find((candidate) => candidate.verb === verb)
        if (verb === null || op === undefined) {
          return answered({ at: journalTime(now()), ...who, outcome: 'refused', verb: 'unknown', code: 'bad_call' }, {
            success: false,
            error: { code: 'bad_call', message: `No operation is named ${JSON.stringify(operation)}; call search for the list.` },
          })
        }
        const input = op.input.safeParse(args ?? {})
        if (!input.success) {
          return answered({ at: journalTime(now()), ...who, outcome: 'refused', verb, code: 'bad_call' }, {
            success: false,
            error: { code: 'bad_call', message: `The arguments do not match ${verb}'s input schema; call search for it.` },
          })
        }
        let outcome: OperationOutcome
        try {
          outcome = await op.run(input.data, { agent })
        } catch {
          outcome = { success: false, error: { code: 'internal', message: 'The operation failed inside Okolos Agent.', retryable: true } as BridgeError }
        }
        const where = { ...(outcome.task === undefined ? {} : { task: outcome.task }), ...(outcome.origin === undefined ? {} : { origin: outcome.origin }) }
        const payload = outcome.success ? { success: true, data: outcome.data } : { success: false, error: outcome.error }
        const bytes = Buffer.byteLength(JSON.stringify(payload))
        const entry: JournalEntry = outcome.success
          ? { at: journalTime(now()), ...who, ...where, outcome: 'answered', verb, bytes, ...(outcome.verdict === undefined ? {} : { verdict: outcome.verdict }) }
          : { at: journalTime(now()), ...who, ...where, outcome: 'refused', verb, code: outcome.error.code, bytes }
        return answered(entry, payload)
      },
    )

    return server
  }

  /** The tool result, sent only after its journal entry is written; a refusal of the journal replaces it. */
  async function answered(entry: JournalEntry, payload: unknown) {
    let refusal: unknown
    await answerAfterRecord(deps.journal, entry, (why) => {
      refusal = why
    })
    const text = JSON.stringify(refusal === undefined ? payload : { success: false, error: refusal })
    return { content: [{ type: 'text' as const, text }], isError: refusal !== undefined || (payload as { success?: boolean }).success === false }
  }

  return Object.assign(route, { paths: DOOR_PATHS })
}
