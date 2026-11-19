/**
 * Where the agents' Chrome is, and what of it a crashed daemon left behind (K4, REQ-61).
 *
 * The agents' browser is the person's own Chrome stable, started with its own
 * profile. A daemon killed with -9 cannot close its browser; the next one finds
 * that browser by the profile's `SingletonLock` (a symlink Chrome writes as
 * `<host>-<pid>`) and ends its process group before starting a new one, so two
 * browsers never hold one profile and nothing of the old one lingers.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readlinkSync } from 'node:fs'
import path from 'node:path'

/** Chrome stable where the installers put it, macOS first; `null` when none is found. */
export function findChrome(env: NodeJS.ProcessEnv = process.env, exists: (file: string) => boolean = existsSync): string | null {
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    path.join(env.HOME ?? '', 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    path.join(env.PROGRAMFILES ?? 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ]
  return candidates.find((file) => file !== '' && exists(file)) ?? null
}

/** What `sweepOrphans` needs from the system; tests pass their own. */
export interface OrphanProbe {
  /** The target of the profile's SingletonLock, or `null` when there is none. */
  readLock(file: string): string | null
  /** The command line of a process, or `null` when it does not exist. */
  commandOf(pid: number): string | null
  kill(pid: number, signal: NodeJS.Signals | 0): void
  /** Waits; the sweep gives the group this long to leave after each signal. */
  sleep(ms: number): Promise<void>
}

export const systemProbe: OrphanProbe = {
  readLock: (file) => {
    try {
      return readlinkSync(file)
    } catch {
      return null
    }
  },
  commandOf: (pid) => {
    try {
      return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).trim() || null
    } catch {
      return null
    }
  },
  kill: (pid, signal) => process.kill(pid, signal),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}

/** How long the group of an orphan gets to leave after SIGTERM, then after SIGKILL. */
export const ORPHAN_GRACE_MS = 2000

/**
 * Ends the browser a crashed daemon left on `profileDir`, with its whole process
 * group (its helpers and crashpad among them). Only a process whose command line
 * names this very profile is touched: a pid in a stale lock may since belong to
 * anything. Answers the pid it ended, or `null` when there was none.
 */
export async function sweepOrphans(profileDir: string, probe: OrphanProbe = systemProbe): Promise<number | null> {
  const target = probe.readLock(path.join(profileDir, 'SingletonLock'))
  const pid = Number(target?.slice(target.lastIndexOf('-') + 1))
  if (!Number.isSafeInteger(pid) || pid <= 1) return null
  const command = probe.commandOf(pid)
  if (command === null || !command.includes(`--user-data-dir=${profileDir}`)) return null
  const groupAlive = (): boolean => {
    try {
      probe.kill(-pid, 0)
      return true
    } catch {
      return probe.commandOf(pid) !== null
    }
  }
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    try {
      // A detached browser leads its own group: the minus sign reaches every helper.
      probe.kill(-pid, signal)
    } catch {
      try {
        probe.kill(pid, signal)
      } catch {
        // Neither the group nor the leader can be signalled: nothing of it is left to end.
      }
    }
    for (let waited = 0; waited < ORPHAN_GRACE_MS; waited += 100) {
      if (!groupAlive()) return pid
      await probe.sleep(100)
    }
  }
  return pid
}
