/**
 * `okolos-agent doctor`: what keeps Okolos Agent from working, with the path and the
 * reason (N-016, REQ-63). The page sends the person here from `pairingStoreError`,
 * `pairingStoreUnwritable`, `journalError`, `journalUnreadable`, `journalExportFailed`
 * and `agentRevokeFailed`; each of those promises a path and a reason, and this is where
 * they are said.
 *
 * It only looks. It opens no second Journal on the folder (a running daemon holds it,
 * N-006 r7 seam #6) and never writes into the access list: write access is read from the
 * file's and the folder's permissions.
 */
import { accessSync, constants, existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

import type { Resolver } from '@okolos/i18n'

import { pairingStoreFile } from './pairing/pairing.js'
import type { ServiceDirs } from './service/dirs.js'
import { findChrome } from './window/chrome.js'

export type DoctorCheck = 'chrome' | 'pairing' | 'journal'
export type DoctorReason = 'missing' | 'no_read' | 'no_write' | 'unparsable'

export interface DoctorProblem {
  readonly check: DoctorCheck
  readonly reason: DoctorReason
  readonly path?: string
}

export interface DoctorProbe {
  readonly chrome: () => string | null
  readonly can: (file: string, mode: number) => boolean
}

export const systemDoctorProbe: DoctorProbe = {
  chrome: () => findChrome(),
  can: (file, mode) => {
    try {
      accessSync(file, mode)
      return true
    } catch {
      return false
    }
  },
}

/**
 * Read and write access to `file` if it exists, else write access to its folder. Answers
 * whether `file` exists and can be read, so the caller may look inside it.
 */
function access(probe: DoctorProbe, check: DoctorCheck, file: string, problems: DoctorProblem[]): boolean {
  if (!existsSync(file)) {
    const folder = path.dirname(file)
    if (existsSync(folder) && !probe.can(folder, constants.W_OK)) problems.push({ check, reason: 'no_write', path: folder })
    return false
  }
  if (!probe.can(file, constants.R_OK)) {
    problems.push({ check, reason: 'no_read', path: file })
    return false
  }
  if (!probe.can(file, constants.W_OK)) problems.push({ check, reason: 'no_write', path: file })
  return true
}

export function diagnose(dirs: ServiceDirs, probe: DoctorProbe = systemDoctorProbe): DoctorProblem[] {
  const problems: DoctorProblem[] = []
  if (probe.chrome() === null) problems.push({ check: 'chrome', reason: 'missing' })

  const store = pairingStoreFile(dirs)
  if (access(probe, 'pairing', store, problems)) {
    try {
      JSON.parse(readFileSync(store, 'utf8'))
    } catch {
      problems.push({ check: 'pairing', reason: 'unparsable', path: store })
    }
  }

  const journal = path.join(dirs.data, 'journal')
  if (access(probe, 'journal', journal, problems)) {
    // The newest day's file, read as the export would read it.
    const days = readdirSync(journal).filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).sort()
    const last = days.at(-1)
    if (last !== undefined) access(probe, 'journal', path.join(journal, last), problems)
  }
  return problems
}

/** The problems in the person's words, one per line; one line saying all is well when there is none. */
export function doctorText(problems: readonly DoctorProblem[], say: Resolver): string[] {
  if (problems.length === 0) return [say('doctorOk')]
  const what: Record<DoctorCheck, string> = { chrome: '', pairing: say('doctorWhatPairing'), journal: say('doctorWhatJournal') }
  const why: Record<DoctorReason, string> = {
    missing: '',
    no_read: say('doctorWhyNoRead'),
    no_write: say('doctorWhyNoWrite'),
    unparsable: say('doctorWhyUnparsable'),
  }
  return problems.map((p) => (p.check === 'chrome' ? say('doctorChromeMissing') : say('doctorProblem', [what[p.check], p.path ?? '', why[p.reason]])))
}
