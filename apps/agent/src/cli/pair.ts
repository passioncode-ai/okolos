import type { ServiceDirs } from '../service/dirs.js'
import { clientKeyFile, saveKey } from './clients.js'
import { loopbackPost, type LoopbackPost } from './loopback.js'
import type { CliMessages } from './messages.js'

/** How often the CLI asks whether the person has confirmed; the request lives five minutes. */
export const CLAIM_POLL_MS = 2_000

export interface PairOptions {
  readonly name: string
  /** The door's origin, `http://127.0.0.1:47871`. */
  readonly base: string
  readonly dirs: ServiceDirs
  readonly say: CliMessages
  readonly print: (line: string) => void
  readonly post?: LoopbackPost
  readonly sleep?: (ms: number) => Promise<void>
}

/** The door's JSON answer, or an empty object for a body that is not JSON. */
function parsed(text: string): Record<string, unknown> {
  try {
    const value = JSON.parse(text) as unknown
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/**
 * `okolos-agent pair --name <name>`: asks the person for access, prints the code to compare with
 * the page, waits for the confirm and keeps the key (spec F6). Exit 0 with the key saved, 1 on
 * any refusal, which is printed by its code: declined, expired, a name the door does not take.
 */
export async function pair(options: PairOptions): Promise<number> {
  const post = options.post ?? loopbackPost
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const asked = await post(`${options.base}/pair`, JSON.stringify({ name: options.name }))
  const answer = parsed(asked.text) as { requestId?: string; code?: string; error?: string }
  if (asked.status !== 200 || typeof answer.requestId !== 'string' || typeof answer.code !== 'string') {
    options.print(options.say.refused(answer.error ?? String(asked.status)))
    return 1
  }
  options.print(options.say.code(options.name, answer.code))
  options.print(options.say.waiting())
  for (;;) {
    const claimed = await post(`${options.base}/pair/claim`, JSON.stringify({ requestId: answer.requestId }))
    const body = parsed(claimed.text) as { key?: string; pending?: boolean; error?: string }
    if (claimed.status === 200 && typeof body.key === 'string') {
      const file = clientKeyFile(options.dirs, options.name)
      saveKey(file, body.key)
      options.print(options.say.saved(file))
      return 0
    }
    if (claimed.status !== 202) {
      options.print(options.say.refused(body.error ?? String(claimed.status)))
      return 1
    }
    await sleep(CLAIM_POLL_MS)
  }
}
