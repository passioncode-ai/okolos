/**
 * Who Okolos Agent is on this machine, and where it keeps its things (fabric-service/0.1).
 *
 * The id names the data folder and is stable forever; the port is a machine-wide claim. Data and
 * config live outside the code, in the person's Library, so a reinstall or a deleted checkout
 * keeps them. Every path is derived from a home the caller may pass, so tests run in a temporary
 * folder and never touch the real one.
 */
import os from 'node:os'
import path from 'node:path'

export const SERVICE_ID = 'okolos-agent'
export const INSTANCE = 'default'
export const PORT = 47871

export interface ServiceDirs {
  /** Data and config: the lock, the host token, sessions, events. */
  readonly data: string
  /** The rotating structured log. */
  readonly logs: string
  /** What can be rebuilt, deletable any time. */
  readonly cache: string
}

/** The service's folders under `home` (macOS layout). Names them only; creates nothing. */
export function serviceDirs(home: string = os.homedir()): ServiceDirs {
  return {
    data: path.join(home, 'Library', 'Application Support', SERVICE_ID),
    logs: path.join(home, 'Library', 'Logs', SERVICE_ID),
    cache: path.join(home, 'Library', 'Caches', SERVICE_ID),
  }
}
