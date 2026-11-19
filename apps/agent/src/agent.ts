/**
 * Okolos Agent assembled (K3, N-011): the service shell, the door, access, the
 * agents' journal, tasks, the agents' window and the verbs.
 *
 * Everything with state is built in the shell's `setup`, after the lock: a second
 * copy on the same home leaves with 75 before it opens the journal, the access
 * list or Chrome (plan N-011, test 21).
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { fromCatalogue, type Catalogue } from '@okolos/i18n'

import { JournalError, journalTime, Journal, RETENTION_DAYS_JOURNAL } from './journal/journal.js'
import { agentEvents } from './agent-events.js'
import { dashboard } from './dashboard/page.js'
import { DOOR_PATHS, door } from './door/door.js'
import { ExtensionLink, extensionStoreFile } from './extension/link.js'
import { extensionOrigin, extensionRoute } from './extension/route.js'
import { readCensus } from './hygiene/census.js'
import { Pairing, PairingStoreError, pairingStoreFile } from './pairing/pairing.js'
import { serviceDirs, type ServiceDirs } from './service/dirs.js'
import { defaultLocalesDir } from './service/messages.js'
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
  /** The page's folder; apps/agent/static unless a release names its own. */
  readonly staticDir?: string
  /** The page's time zone; the system's when left out (tests pin it). */
  readonly timeZone?: string
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
  const events = agentEvents(locale, options.localesDir, options.timeZone)
  let journal: Journal | undefined
  let pairing: Pairing | undefined
  let windows: AgentWindows | undefined
  let verbs: Verbs | undefined
  const tasks = new Tasks()
  const timers: NodeJS.Timeout[] = []
  let journalFailure: string | null = null
  let journalFailingSince: number | null = null
  const writeGaps: { from: number; to: number }[] = []
  let pairingFailure: string | null = null
  const catalogueFile = path.join(options.localesDir ?? defaultLocalesDir(), locale, 'messages.json')
  const say = fromCatalogue(JSON.parse(readFileSync(catalogueFile, 'utf8')) as Catalogue)

  const service = await startService({
    port: options.port,
    dirs,
    version: options.version,
    buildRoot: options.buildRoot,
    locale,
    ...(options.localesDir === undefined ? {} : { localesDir: options.localesDir }),
    ...(options.exit === undefined ? {} : { exit: options.exit }),
    handleSignals: false,
    // The paired Okolos extension reaches its own route; every other browser is still refused (B-218).
    originAllowed: extensionOrigin,
    onRefused: async (_req, url, reason) => {
      // Only the door's own routes go into the agents' journal; Fabric's polls do not (test 25).
      if (journal === undefined || url === null || !(DOOR_PATHS as readonly string[]).includes(url.pathname)) return
      await journal.record({ at: journalTime(now()), outcome: 'rejected', code: reason })
    },
    setup: async (ctx) => {
      const openedJournal = Journal.open(path.join(dirs.data, 'journal'), { retentionDays: RETENTION_DAYS_JOURNAL })
      // The page names the last failed write (SCR-24 error, journalError) until a write succeeds again.
      const record = openedJournal.record.bind(openedJournal)
      openedJournal.record = async (entry) => {
        try {
          await record(entry)
          if (journalFailingSince !== null) writeGaps.push({ from: journalFailingSince, to: now() })
          journalFailure = null
          journalFailingSince = null
        } catch (error) {
          journalFailure = error instanceof JournalError ? error.code : 'other'
          journalFailingSince ??= now()
          throw error
        }
      }
      journal = openedJournal
      const opened = Pairing.open(pairingStoreFile(dirs), {
        onNotice: (notice) => {
          const event = events.notice(notice)
          ctx.events.append(event.kind, event.level, event.text)
          if (notice.kind === 'revoked') void verbs?.closeWindows(tasks.closeAllOf(notice.agentId))
        },
        onNoticeError: (error) => ctx.log.write('warn', 'pairing_notice_failed', { error: error instanceof Error ? error.name : 'unknown' }),
      })
      pairing = opened
      // The page's store-unwritable state: the last write of the access list failed (a claim, a revoke).
      for (const method of ['claim', 'revoke'] as const) {
        const original = opened[method].bind(opened) as (...args: unknown[]) => unknown
        ;(opened as unknown as Record<string, (...args: unknown[]) => unknown>)[method] = (...args: unknown[]) => {
          try {
            const result = original(...args)
            pairingFailure = null
            return result
          } catch (error) {
            if (error instanceof PairingStoreError) pairingFailure = error.reason
            throw error
          }
        }
      }
      const profileDir = path.join(dirs.data, 'profiles', 'agent')
      windows = new AgentWindows({
        binary: options.chromeBinary === undefined ? (findChrome() ?? '') : (options.chromeBinary ?? ''),
        profileDir,
        ...(options.extraChromeArgs === undefined ? {} : { extraArgs: options.extraChromeArgs }),
        onCloseIncomplete: (pid) => ctx.events.append('window_close_incomplete', 'warning', events.windowCloseIncomplete(pid)),
      })
      const link = new ExtensionLink({ file: extensionStoreFile(dirs), now })
      verbs = createVerbs({
        tasks,
        windows,
        extension: link,
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
          openedJournal.sweep(now())
          ctx.events.trim(now())
        }, DAY_MS),
      )
      for (const timer of timers) timer.unref()
      return [
        door({ pairing: opened, journal: openedJournal, operations: verbs, version: options.version, now }),
        extensionRoute({
          link,
          // i18n-exempt: a line of the service log, read by a developer
          refused: (route, reason) => ctx.log.write('warn', 'extension route refused', { path: route, reason }),
        }),
        dashboard({
          pairing: opened,
          tasks,
          journal: openedJournal,
          say,
          locale,
          now,
          onRevoke: (agent) => opsVerbs.closeWindows(tasks.closeAllOf(agent.agentId)),
          journalWriteFailure: () => journalFailure,
          writeGaps: () => writeGaps,
          pairingWriteFailure: () => pairingFailure,
          ...(options.staticDir === undefined ? {} : { staticDir: options.staticDir }),
          ...(options.timeZone === undefined ? {} : { timeZone: options.timeZone }),
        }),
      ]
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
