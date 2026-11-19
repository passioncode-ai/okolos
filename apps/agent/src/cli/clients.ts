import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import type { ServiceDirs } from '../service/dirs.js'

/**
 * Where a paired client keeps its key: `<data>/clients/<sha256(name) hex>.key`, 0600 in a 0700
 * folder (spec F6, refined R6). The name is hashed so any name the door accepts is a safe file
 * name, and two names never share a file.
 */
export function clientKeyFile(dirs: ServiceDirs, name: string): string {
  return path.join(dirs.data, 'clients', `${createHash('sha256').update(name, 'utf8').digest('hex')}.key`)
}

/** Writes the key atomically: a reader never sees half a key, and nobody else can read it. */
export function saveKey(file: string, key: string): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, `${key}\n`, { mode: 0o600 })
  chmodSync(temp, 0o600)
  renameSync(temp, file)
}

/** The key saved for a client, or null when it was never paired on this account. */
export function readKey(file: string): string | null {
  if (!existsSync(file)) return null
  const key = readFileSync(file, 'utf8').trim()
  return key === '' ? null : key
}
