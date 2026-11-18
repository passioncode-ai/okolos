import { request } from 'node:http'

/** What the CLI needs of an answer from the door. */
export interface LoopbackAnswer {
  readonly status: number
  readonly text: string
}

export type LoopbackPost = (url: string, body: string, headers?: Readonly<Record<string, string>>) => Promise<LoopbackAnswer>

/**
 * A POST to Okolos Agent's door, and to nothing else.
 *
 * The CLI is not a network client: it talks to the daemon on this machine's loopback, the way a
 * local MCP client does. So it does not take `fetch` (network I/O belongs to `packages/net`,
 * REQ-08); it takes `node:http`, and refuses any host but 127.0.0.1 and localhost before a byte
 * leaves, so a mistyped or planted `--door` can never send a key elsewhere.
 */
export const loopbackPost: LoopbackPost = (url, body, headers = {}) => {
  const target = new URL(url)
  if (target.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(target.hostname)) {
    // i18n-exempt: a programming or configuration error naming the address, for whoever wired the CLI
    return Promise.reject(new Error(`okolos-agent talks only to its own door on loopback, not to ${target.host}`))
  }
  return new Promise((resolve, reject) => {
    const req = request(
      target,
      { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers } },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }))
        res.on('error', reject)
      },
    )
    req.on('error', reject)
    req.end(body)
  })
}
