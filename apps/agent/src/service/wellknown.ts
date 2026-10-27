/**
 * The well-known document, `GET /.well-known/fabric-service`: who is answering on this port.
 *
 * A host compares `service.id` and `service.instance` with the descriptor, so a stranger on the
 * port is told apart from this service; `build` and `process` say which code is running and since
 * when (a service once ran stale code after an edit and nothing showed it). The document is built
 * from memory on each request, never from a store, so it answers fast even while the service is busy.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  buildWellKnown,
  type DegradedSource,
  type ServiceStatus,
  type WellKnownDocument,
} from '../fabric/fabric-service.mjs'
import { INSTANCE, SERVICE_ID } from './dirs.js'

export const SERVICE_NAME = 'Okolos Agent'

/** The package's own version, read once from apps/agent/package.json. */
const VERSION = (
  JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }
).version

export interface Build {
  readonly commit?: string
  readonly digest?: string
}

const HERE = path.dirname(fileURLToPath(import.meta.url))

/**
 * The commit of the checkout the code runs from; in a release folder, which is no checkout, a
 * SHA-256 over its files (names and bytes), so two different builds never share an identity.
 */
export function buildIdentity(codeDir: string = HERE): Build {
  try {
    const commit = execFileSync('git', ['-C', codeDir, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    }).trim()
    if (/^[0-9a-f]{40}$/.test(commit)) return { commit }
  } catch {
    // Not a checkout, or no git on launchd's bare PATH: fall through to the digest.
  }
  const hash = createHash('sha256')
  const files = (readdirSync(codeDir, { recursive: true, encoding: 'utf8' }) as string[])
    .filter((name) => statSync(path.join(codeDir, name)).isFile())
    .sort()
  for (const name of files) {
    hash.update(`${name}\0`)
    hash.update(readFileSync(path.join(codeDir, name)))
    hash.update('\0')
  }
  return { digest: `sha256:${hash.digest('hex')}` }
}

export function wellKnown(state: {
  build: Build
  startedAt: string
  pid: number
  status: ServiceStatus
  degraded: readonly DegradedSource[]
}): WellKnownDocument {
  return buildWellKnown({
    id: SERVICE_ID,
    instance: INSTANCE,
    name: SERVICE_NAME,
    version: VERSION,
    build: { ...state.build },
    startedAt: state.startedAt,
    pid: state.pid,
    status: state.status,
    degraded: state.degraded,
    surfaces: {
      events: { path: '/fabric/v1/events' },
      dashboard: { path: '/dashboard', login: true },
      // DEC-0024: the host's token is not an MCP credential; paired agents bring their own key.
      mcp: { path: '/mcp', transport: 'streamable-http', auth: 'own' },
    },
  })
}
