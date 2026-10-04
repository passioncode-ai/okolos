import { appendFileSync, chmodSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'

/**
 * The feed agent's log: timestamped, size-rotated, owner-only (LC-12).
 *
 * It used to be launchd's `StandardOutPath` in `/tmp` — wiped at every boot, so the
 * weeks of 401s from a revoked token left nothing to read (B-133), mode 644, never
 * rotated, and garbled by spinner carriage returns.
 */

export const LOG_MAX_BYTES = 5 * 1024 * 1024
export const LOG_KEEP = 5

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g

/** One printable line: colour codes dropped, and only what a spinner left last. */
export function cleanLine(text) {
  const withoutAnsi = String(text).replace(ANSI, '')
  const frames = withoutAnsi.split('\r').filter((frame) => frame.trim() !== '')
  return (frames.at(-1) ?? '').trimEnd()
}

function sizeOf(file) {
  try {
    return statSync(file).size
  } catch {
    return 0
  }
}

/** feed.log → feed.log.1 → … → feed.log.(keep-1); the oldest falls off. */
function rotate(file, keep) {
  rmSync(`${file}.${keep - 1}`, { force: true })
  for (let index = keep - 2; index >= 1; index -= 1) {
    if (existsSync(`${file}.${index}`)) renameSync(`${file}.${index}`, `${file}.${index + 1}`)
  }
  if (existsSync(file)) {
    if (keep > 1) renameSync(file, `${file}.1`)
    else rmSync(file, { force: true })
  }
  for (let index = 1; index < keep; index += 1) {
    if (existsSync(`${file}.${index}`)) chmodSync(`${file}.${index}`, 0o600)
  }
}

/**
 * Opens `file` for appending. Rotates first when it is already past the cap, and
 * again whenever a write would take it past.
 */
export function openLog(file, { maxBytes = LOG_MAX_BYTES, keep = LOG_KEEP, now = Date.now } = {}) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  if (sizeOf(file) >= maxBytes) rotate(file, keep)
  return {
    file,
    write(text) {
      const line = `${new Date(now()).toISOString()} ${cleanLine(text)}\n`
      if (sizeOf(file) > 0 && sizeOf(file) + Buffer.byteLength(line) > maxBytes) rotate(file, keep)
      appendFileSync(file, line, { mode: 0o600 })
      // appendFileSync applies the mode only when it creates the file; a file left
      // by an older version at 644 is brought to 600 here.
      chmodSync(file, 0o600)
    },
  }
}

/** Brings any file to the cap without opening it for writing — for launchd's own stream. */
export function capFile(file, { maxBytes = LOG_MAX_BYTES, keep = LOG_KEEP } = {}) {
  if (sizeOf(file) >= maxBytes) rotate(file, keep)
}
