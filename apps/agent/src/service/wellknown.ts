/**
 * The well-known document, `GET /.well-known/fabric-service`: who is answering on this port.
 *
 * A host compares `service.id` and `service.instance` with the descriptor, so a stranger on the
 * port is told apart from this service; `build` and `process` say which code is running and since
 * when (a service once ran stale code after an edit and nothing showed it). The document is built
 * from memory on each request, never from a store, so it answers fast even while the service is busy.
 *
 * Nothing here reads a file at import: the version and the code's root come from the entry point,
 * so a bundled release cannot fail on a path that only exists in the checkout.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'

import {
  buildWellKnown,
  type DegradedSource,
  type ServiceStatus,
  type WellKnownDocument,
  type WellKnownSurfaces,
} from '../fabric/fabric-service.mjs'
import { INSTANCE, SERVICE_ID } from './dirs.js'

export const SERVICE_NAME = 'Okolos Agent'

export interface Build {
  readonly commit?: string
  readonly digest?: string
}

/** Folders that are not the code: dependencies and git's own. */
const NOT_CODE = new Set(['node_modules', '.git'])

/**
 * The commit, when `root` sits in this repository's checkout; otherwise a SHA-256 over every
 * file under `root` (names and bytes). A release folder is no checkout of ours even when it lies
 * inside some other repository (a home kept in git), and a folder under `releases/` is a release
 * whatever git says, so two different builds never share an identity.
 */
export function buildIdentity(root: string): Build {
  const commit = ourCommit(root)
  if (commit !== null) return { commit }
  const hash = createHash('sha256')
  const files = (readdirSync(root, { recursive: true, encoding: 'utf8' }) as string[])
    .filter((name) => !name.split(path.sep).some((part) => NOT_CODE.has(part)))
    .filter((name) => statSync(path.join(root, name)).isFile())
    .sort()
  for (const name of files) {
    hash.update(`${name}\0`)
    hash.update(readFileSync(path.join(root, name)))
    hash.update('\0')
  }
  return { digest: `sha256:${hash.digest('hex')}` }
}

function ourCommit(root: string): string | null {
  if (path.resolve(root).split(path.sep).includes('releases')) return null
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000 }).trim()
  try {
    const top = git('rev-parse', '--show-toplevel')
    const manifest = path.join(top, 'apps', 'agent', 'package.json')
    if (!existsSync(manifest)) return null
    if ((JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string }).name !== '@okolos/agent') return null
    if (!realpathSync(root).startsWith(realpathSync(top))) return null
    const commit = git('rev-parse', 'HEAD')
    return /^[0-9a-f]{40}$/.test(commit) ? commit : null
  } catch {
    // Not a checkout, or no git on launchd's bare PATH: the digest names the build.
    return null
  }
}

export interface WellKnownState {
  readonly version: string
  readonly build: Build
  readonly startedAt: string
  readonly pid: number
  readonly status: ServiceStatus
  readonly degraded: readonly DegradedSource[]
  /** Paths the service's routes say they serve; `/mcp` and `/dashboard` are declared only when present. */
  readonly served: readonly string[]
  readonly actions?: readonly unknown[]
  readonly extensions?: Readonly<Record<string, unknown>>
}

export function wellKnown(state: WellKnownState): WellKnownDocument {
  const surfaces: WellKnownSurfaces = { events: { path: '/fabric/v1/events' } }
  if (state.served.includes('/dashboard')) surfaces.dashboard = { path: '/dashboard', login: true }
  // DEC-0024: the host's token is not an MCP credential; paired agents bring their own key.
  if (state.served.includes('/mcp')) surfaces.mcp = { path: '/mcp', transport: 'streamable-http', auth: 'own' }
  return buildWellKnown({
    id: SERVICE_ID,
    instance: INSTANCE,
    name: SERVICE_NAME,
    version: state.version,
    build: { ...state.build },
    startedAt: state.startedAt,
    pid: state.pid,
    status: state.status,
    degraded: state.degraded,
    surfaces,
    ...(state.actions === undefined ? {} : { actions: state.actions }),
    ...(state.extensions === undefined ? {} : { extensions: state.extensions }),
  })
}
