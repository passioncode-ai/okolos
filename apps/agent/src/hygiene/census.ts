/**
 * The process census (K5, REQ-62): which automation browsers and drivers run on
 * this machine, whose they are, and which must not be touched.
 *
 * It only reads. Ending a process is Б3; this answers what an agent may ask
 * before it starts its own work: is a debugging port open, and by whom.
 *
 * The full command line never leaves this module (review F11): it can carry a
 * token (`--token=…`), a profile path naming a person, a URL. An entry keeps the
 * executable's path, the pid, the owner, the age, the reason and the names of
 * the automation flags the classifier read, never their values.
 *
 * `reason` is a code an agent reads, not a sentence: `agents-browser` (the
 * agents' own Chrome), `os-service` (a launchd job), `live-session` (an
 * automation process whose parent runs), `persons-browser` (a browser started
 * without automation flags), `orphan` (an automation process whose parent is
 * gone; reported, never ended here).
 */
import { execFile } from 'node:child_process'
import path from 'node:path'

import type { CensusEntry } from '@okolos/contracts'

/** Executables the census looks at: browsers, headless shells and their drivers. */
const WATCHED = /(?:^|\/)(?:Google Chrome(?: for Testing| Canary| Beta| Dev)?|Chromium|chrome|chromium(?:-browser)?|chrome-headless-shell|headless_shell|msedge|Microsoft Edge|firefox|Firefox|chromedriver|geckodriver|msedgedriver|safaridriver)$/

/** Flags that mark a browser as driven; only their names are reported. */
const AUTOMATION_FLAGS = [
  '--remote-debugging-port',
  '--remote-debugging-pipe',
  '--remote-debugging-address',
  '--enable-automation',
  '--headless',
  '--marionette',
  '--remote-allow-origins',
  '--test-type',
] as const

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

interface Row {
  readonly pid: number
  readonly ppid: number
  readonly startedAt: number
  /** The executable's path, as `ps` reads it from the process, not from its arguments. */
  readonly executable: string
}

/**
 * One line of `ps -axo pid=,ppid=,lstart=,comm=`: the start is five words
 * (`Thu Nov 19 01:07:56 2026`), and the executable is the rest of the line, so
 * a path with spaces (`Google Chrome.app`) needs no guessing.
 */
function parsePs(ps: string): Row[] {
  const rows: Row[] = []
  for (const line of ps.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})\s+(.*)$/.exec(line)
    if (match === null) continue
    const [, pid, ppid, month, day, h, m, s, year, executable] = match
    const monthIndex = MONTHS.indexOf(month ?? '')
    if (monthIndex === -1 || executable === undefined) continue
    const startedAt = new Date(Number(year), monthIndex, Number(day), Number(h), Number(m), Number(s)).getTime()
    rows.push({ pid: Number(pid), ppid: Number(ppid), startedAt, executable: executable.trim() })
  }
  return rows
}

/** `launchctl list`: `PID\tStatus\tLabel`, a dash for a job not running. */
function parseLaunchctl(launchctl: string): Map<number, string> {
  const jobs = new Map<number, string>()
  for (const line of launchctl.split('\n')) {
    const [pid, , label] = line.split('\t')
    if (pid === undefined || label === undefined || !/^\d+$/.test(pid)) continue
    jobs.set(Number(pid), label.trim())
  }
  return jobs
}

/** `ps -axo pid=,command=`: the full command line, read here and never returned. */
function parseCommands(text: string): Map<number, string> {
  const commands = new Map<number, string>()
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line)
    if (match?.[1] !== undefined && match[2] !== undefined) commands.set(Number(match[1]), match[2])
  }
  return commands
}

function flagsOf(command: string): string[] {
  const words = command.split(/\s+/)
  return AUTOMATION_FLAGS.filter((flag) => words.some((word) => word === flag || word.startsWith(`${flag}=`)))
}

export interface CensusOptions {
  /** The daemon's own pid, never reported. */
  readonly selfPid: number
  /** The agents' Chrome profile: a browser on it is the daemon's own. */
  readonly agentProfileDir: string
  readonly now: number
}

/** What the census reads: two `ps` readings and `launchctl list`. */
export interface CensusInput {
  /** `ps -axo pid=,ppid=,lstart=,comm=` */
  readonly ps: string
  /** `ps -axo pid=,command=` */
  readonly commands: string
  /** `launchctl list`; empty where there is none. */
  readonly launchctl: string
}

/** The census from the text of `ps` and `launchctl list`. */
export function census(input: CensusInput, options: CensusOptions): CensusEntry[] {
  const rows = parsePs(input.ps)
  const commands = parseCommands(input.commands)
  const byPid = new Map(rows.map((row) => [row.pid, row]))
  const jobs = parseLaunchctl(input.launchctl)
  const entries: CensusEntry[] = []
  for (const row of rows) {
    if (row.pid === options.selfPid) continue
    const executable = row.executable
    const command = commands.get(row.pid) ?? executable
    // Helpers (renderers, GPU, crashpad) belong to their browser, which is listed.
    if (!WATCHED.test(executable) || /\s--type=/.test(command)) continue
    const flags = flagsOf(command)
    const parent = byPid.get(row.ppid)
    const base = {
      pid: row.pid,
      ppid: row.ppid,
      executable,
      ageSeconds: Math.max(0, Math.floor((options.now - row.startedAt) / 1000)),
      flags,
    }
    const job = jobs.get(row.pid) ?? (parent === undefined ? undefined : jobs.get(parent.pid))
    if (command.includes(`--user-data-dir=${options.agentProfileDir}`)) {
      entries.push({ ...base, owner: 'okolos-agent', keep: true, reason: 'agents-browser' })
    } else if (job !== undefined && (row.ppid === 1 || jobs.has(row.pid))) {
      entries.push({ ...base, owner: job, keep: true, reason: 'os-service' })
    } else if (flags.length === 0) {
      entries.push({ ...base, owner: null, keep: true, reason: 'persons-browser' })
    } else if (parent !== undefined && row.ppid !== 1) {
      const owner = job ?? path.basename(parent.executable)
      entries.push({ ...base, owner, keep: true, reason: 'live-session' })
    } else {
      entries.push({ ...base, owner: null, keep: false, reason: 'orphan' })
    }
  }
  return entries
}

/** How long `ps` and `launchctl` get before the census gives up. */
export const CENSUS_TIMEOUT_MS = 5000

function run(file: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: CENSUS_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' }, (error, stdout) => {
      if (error !== null) reject(error)
      else resolve(stdout)
    })
  })
}

/** Reads `ps` and `launchctl list` and takes the census; launchctl is optional (Linux has none). */
export async function readCensus(options: Omit<CensusOptions, 'now'>, now: () => number = Date.now): Promise<CensusEntry[]> {
  const ps = await run('ps', ['-axo', 'pid=,ppid=,lstart=,comm='])
  const commands = await run('ps', ['-axo', 'pid=,command='])
  const launchctl = await run('launchctl', ['list']).catch(() => '')
  return census({ ps, commands, launchctl }, { ...options, now: now() })
}
