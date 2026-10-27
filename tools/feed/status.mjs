import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/**
 * The feed agent's last-run record (LC-03), written whole at the end of every run.
 *
 * `{ startedAt, at, outcome, stage, exit, reason?, version?, entries?, commit?, runId?,
 * recoveredCheckout?, recovery? }`
 * plus what a host needs without history: `consecutiveFailures` (alert at two) and
 * `lastPublished` (alert when it is older than the feed's freshness budget). Before
 * this, a failure was visible only in `launchctl print … last exit code` (B-133).
 */

export function readStatus(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function writeWhole(file, full) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(full, null, 2)}\n`, { mode: 0o600 })
  renameSync(temporary, file)
  return full
}

/**
 * Marks the record in `file` as run `runId`'s, changing nothing else: the count
 * stays what the writer made it. The bootstrap stamps a record it adopts from a job
 * that writes no run id (one from before B-159), so the plist's launch line, which
 * writes only when no record of its run id exists, does not count the run twice.
 * Returns the stamped record, or null when there is none.
 */
export function stampRunId(file, runId) {
  const record = readStatus(file)
  if (!record) return null
  return writeWhole(file, { ...record, runId })
}

export function writeStatus(file, record) {
  const previous = readStatus(file)
  const failed = record.outcome === 'failed'
  const full = {
    ...record,
    consecutiveFailures: failed ? (previous?.consecutiveFailures ?? 0) + 1 : 0,
    lastPublished:
      record.outcome === 'published'
        ? { version: record.version ?? null, entries: record.entries ?? null, at: record.at }
        : (previous?.lastPublished ?? null),
  }
  return writeWhole(file, full)
}
