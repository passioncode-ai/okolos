import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * One temporary folder for the whole run, removed when the run ends (B-179).
 *
 * Tests make folders with `mkdtempSync(os.tmpdir())` and most never remove them: on 2026-11-17 the
 * machine's temporary folder held 1510 `okolos-*` folders, thirty more after every run, on a disk
 * that had run out of space twice that day. Fixing each test misses the next one written, so the
 * run points `os.tmpdir()` at a folder of its own (TMPDIR on macOS and Linux, TEMP and TMP on
 * Windows) and removes it at the end. The workers start after this and inherit the environment.
 */
export default function setup(): () => void {
  const base = mkdtempSync(path.join(os.tmpdir(), 'okolos-vitest-'))
  const previous = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP }
  process.env.TMPDIR = base
  process.env.TEMP = base
  process.env.TMP = base
  return () => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    rmSync(base, { recursive: true, force: true })
  }
}
