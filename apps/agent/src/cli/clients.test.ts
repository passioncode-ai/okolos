import { mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { readKey, saveKey } from './clients.js'

describe('the key file', () => {
  it('is replaced whole, never left half written', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'okolos-key-'))
    const file = path.join(root, 'clients', 'x.key')
    saveKey(file, 'first')
    saveKey(file, 'second')
    expect(readKey(file)).toBe('second')
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })
})
