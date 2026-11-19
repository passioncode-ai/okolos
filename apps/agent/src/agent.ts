/**
 * Okolos Agent assembled (K3, N-011): the service shell, the door, access, the
 * agents' journal, tasks, the agents' window and the verbs.
 *
 * Everything with state is built in the shell's `setup`, after the lock: a second
 * copy on the same home leaves with 75 before it opens the journal, the access
 * list or Chrome (plan N-011, test 21).
 */
import path from 'node:path'

import { journalTime, Journal, RETENTION_DAYS_JOURNAL } from './journal/journal.js'
import { agentEvents } from './agent-events.js'
import { DOOR_PATHS, door } from './door/door.js'
import { readCensus } from './hygiene/census.js'
import { Pairing, pairingStoreFile } from './pairing/pairing.js'
import { serviceDirs, type ServiceDirs } from './service/dirs.js'
import { startService, type Locale, type RunningService } from './service/http.js'
import { Tasks } from './tasks/tasks.js'
import { createVerbs, type Verbs } from './verbs/verbs.js'
import { findChrome } from './window/chrome.js'
import { AgentWindows } from './window/window.js'

/** How often expired access requests and tasks are looked for (plan N-011, tests 32 and 33). */
export const MINUTE_MS = 60_000
/** How often the journal and the events feed are trimmed (tests 20, audit #30). */
export const DAY_MS = 24 * 60 * 60_000

export interface AgentOptions {
  readonly port: number
  readonly version: string
  readonly buildRoot: string
  /** The probe's script: the file the release ships beside the daemon. */
  readonly probeSource: string
  readonly home?: string
  readonly dirs?: ServiceDirs
  readonly locale?: Locale
  readonly localesDir?: string
  /** Chrome stable's executable; `findChrome()` when left out. */
  readonly chromeBinary?: string | null
  readonly extraChromeArgs?: readonly string[]
  /** Only tests pass it; main.ts never does. */
  readonly allowLoopbackForTests?: boolean
  readonly now?: () => number
  readonly exit?: (code: number) => void
}

export interface Agent {
  readonly service: RunningService
  readonly tasks: Tasks
  readonly windows: AgentWindows
  /** Stops the service, ends the agents' Chrome and writes the access list's last calls. */
  close(): Promise<void>
}

export async function createAgent(options: AgentOptions): Promise<Agent> {
  const now = options.now ?? Date.now
  const dirs = options.dirs ?? serviceDirs(options.home)
  const locale = options.locale ?? 'ru'
  const say = agentEvents(locale, options.localesDir)
  let journal: Journal | undefined
  let pairing: Pairing | undefined
  let windows: AgentWindows | undefined
  let verbs: Verbs | undefined
  const tasks = new Tasks()
  const timers: NodeJS.Timeout[] = []

  const service = await startService({
    port: options.port,
    dirs,
    version: options.version,
    buildRoot: options.buildRoot,
    locale,
    ...(options.localesDir === undefined ? {} : { localesDir: options.localesDir }),
    ...(options.exit === undefined ? {} : { exit: options.exit }),
    handleSignals: false,
    onRefused: async (_req, url, reason) => {
      // Only the door's own routes go into the agents' journal; Fabric's polls do not (test 25).
      if (journal === undefined || url === null || !(DOOR_PATHS as readonly string[]).includes(url.pathname)) return
      await journal.record({ at: journalTime(now()), outcome: 'rejected', code: reason })
    },
    setup: async (ctx) => {
      journal = Journal.open(path.join(dirs.data, 'journal'), { retentionDays: RETENTION_DAYS_JOURNAL })
      const opened = Pairing.open(pairingStoreFile(dirs), {
        onNotice: (notice) => {
          const event = say.notice(notice)
          ctx.events.append(event.kind, event.level, event.text)
          if (notice.kind === 'revoked') void verbs?.closeWindows(tasks.closeAllOf(notice.agentId))
        },
        onNoticeError: (error) => ctx.log.write('warn', 'pairing_notice_failed', { error: error instanceof Error ? error.name : 'unknown' }),
      })
      pairing = opened
      const profileDir = path.join(dirs.data, 'profiles', 'agent')
      windows = new AgentWindows({
        binary: options.chromeBinary === undefined ? (findChrome() ?? '') : (options.chromeBinary ?? ''),
        profileDir,
        ...(options.extraChromeArgs === undefined ? {} : { extraArgs: options.extraChromeArgs }),
        onCloseIncomplete: (pid) => ctx.events.append('window_close_incomplete', 'warning', say.windowCloseIncomplete(pid)),
      })
      verbs = createVerbs({
        tasks,
        windows,
        probeSource: options.probeSource,
        census: () => readCensus({ selfPid: process.pid, agentProfileDir: profileDir }),
        now,
        ...(options.allowLoopbackForTests === true ? { allowLoopbackForTests: true } : {}),
      })
      const opsVerbs = verbs
      timers.push(
        setInterval(() => {
          opened.list(now())
          void opsVerbs.closeWindows(tasks.sweep(now()))
        }, MINUTE_MS),
        setInterval(() => {
          journal?.sweep(now())
          ctx.events.trim(now())
        }, DAY_MS),
      )
      for (const timer of timers) timer.unref()
      return [door({ pairing: opened, journal, operations: verbs, version: options.version, now })]
    },
  })

  if (windows === undefined) {
    // i18n-exempt: a programming error inside the daemon, read in its log by a developer
    throw new Error('createAgent: the service started without running its setup')
  }
  const agentWindows = windows
  let closing: Promise<void> | undefined
  return {
    service,
    tasks,
    windows: agentWindows,
    close: () => {
      closing ??= (async () => {
        for (const timer of timers) clearInterval(timer)
        await service.close()
        await agentWindows.shutdown()
        try {
          pairing?.flush()
        } catch {
          // The access list could not be written; the last calls of this run are lost, nothing else.
        }
      })()
      return closing
    },
  }
}
