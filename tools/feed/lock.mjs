import { randomUUID } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs'
import path from 'node:path'

/**
 * One feed run at a time, shared by every entry point to the work (LC-03).
 *
 * A lock file created with O_EXCL, holding the holder's pid and a token. A holder
 * that died leaves a file whose pid is gone, and the next run takes it over rather
 * than refusing forever. A child of the holder — the job runs ingest and publish as
 * separate processes — passes the holder's token through `OKOLOS_FEED_LOCK` and is
 * let through without taking a lock of its own.
 */

export class LockHeldError extends Error {
  constructor(file, holder) {
    super(
      `another feed run holds ${file} (pid ${holder?.pid ?? 'unknown'}, since ${holder?.at ?? 'unknown'}). ` +
        `It ends on its own within its watchdog; run again after it.`,
    )
    this.name = 'LockHeldError'
    this.holder = holder
  }
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (cause) {
    return cause?.code === 'EPERM'
  }
}

function readHolder(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** Takes the lock at `file`, or throws LockHeldError naming who holds it. */
export function acquireLock(file, { inherited } = {}) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })

  if (inherited) {
    const holder = readHolder(file)
    if (holder?.token === inherited && alive(holder.pid)) {
      return { token: inherited, inherited: true, release() {} }
    }
    if (holder && alive(holder.pid)) throw new LockHeldError(file, holder)
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = randomUUID()
    try {
      const fd = openSync(file, 'wx', 0o600)
      try {
        writeSync(fd, JSON.stringify({ pid: process.pid, token, at: new Date().toISOString() }))
      } finally {
        closeSync(fd)
      }
      return {
        token,
        inherited: false,
        release() {
          // Only our own lock: a run that took over a lock we were presumed dead
          // on owns it now, and removing it would let a third run in beside it.
          if (readHolder(file)?.token === token) rmSync(file, { force: true })
        },
      }
    } catch (cause) {
      if (cause?.code !== 'EEXIST') throw cause
      const holder = readHolder(file)
      if (holder && alive(holder.pid)) throw new LockHeldError(file, holder)
      // Dead holder or unreadable file: stale. Removed once, then retried.
      rmSync(file, { force: true })
    }
  }
  throw new LockHeldError(file, readHolder(file))
}
