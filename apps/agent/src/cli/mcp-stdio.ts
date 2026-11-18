import { AGENT_KEY_HEADER } from '../door/door.js'
import type { ServiceDirs } from '../service/dirs.js'
import { clientKeyFile, readKey } from './clients.js'
import { loopbackPost, type LoopbackPost } from './loopback.js'
import type { CliMessages } from './messages.js'

export interface RelayOptions {
  readonly name: string
  readonly base: string
  readonly dirs: ServiceDirs
  readonly say: CliMessages
  /** Newline-delimited JSON-RPC messages, as an MCP client writes them to a stdio server. */
  readonly input: AsyncIterable<string>
  /** One JSON-RPC message per line back to the client. */
  readonly output: (line: string) => void
  /** Where a person reads what went wrong; stdout belongs to the protocol. */
  readonly error: (line: string) => void
  readonly post?: LoopbackPost
}

/**
 * `okolos-agent mcp-stdio --as <name>`: the stdio shim (REQ-57). An MCP client that speaks only
 * stdio (Claude Code's `command` servers) starts this; it carries each message to the door with
 * the key `pair` saved under that name, and writes the answer back. A notification has no answer
 * (the door says 202) and writes nothing. Without a key it says how to pair and exits 1.
 */
export async function relay(options: RelayOptions): Promise<number> {
  const key = readKey(clientKeyFile(options.dirs, options.name))
  if (key === null) {
    options.error(options.say.notPaired(options.name))
    return 1
  }
  const post = options.post ?? loopbackPost
  for await (const raw of options.input) {
    const line = raw.trim()
    if (line === '') continue
    const { text } = await post(`${options.base}/mcp`, line, {
      accept: 'application/json, text/event-stream',
      [AGENT_KEY_HEADER]: key,
    })
    if (text.trim() !== '') options.output(text.trim())
  }
  return 0
}
