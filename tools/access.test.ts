/**
 * The access tool's rules, exercised without a network.
 *
 * A check that can only be run online is a check nobody runs, so the parsing,
 * the normalisation and the verdict logic are separated from the probes and
 * tested here. The probes themselves are proved by running the tool — and one
 * of them was wrong on its first run, which is why the verdict rules below
 * distinguish "broken" from "unverified" at all.
 */

import { spawnSync } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  ACCESSES,
  compiledPublicKey,
  feedKeyMatches,
  modesApply,
  normaliseValue,
  parseEnv,
  permissionProblem,
  verdictOf,
} from './access.mjs'

describe('reading a secrets file', () => {
  it('never sources it, so a stray command in it cannot run', () => {
    const parsed = parseEnv("export A=1\nrm -rf /\nB='two'\nC=\"three\"\n# D=4")
    expect(parsed).toEqual({ A: '1', B: 'two', C: 'three' })
  })

  it('strips the quoting a person pastes', () => {
    // A quoted account id reached Cloudflare as `'43da…'` once, and the API
    // answered "Could not route" — present, and wrong.
    expect(parseEnv("X='abc'").X).toBe('abc')
    expect(parseEnv('X="abc"').X).toBe('abc')
  })

  it('reads a file saved with Windows line endings the same way', () => {
    // Notepad writes CRLF; a `\r` kept on a value is a credential present and wrong (B-162).
    const parsed = parseEnv("export A=1\r\nB='two'\r\nC=\"three\"\r\nD=four\r\n")
    expect(parsed).toEqual({ A: '1', B: 'two', C: 'three', D: 'four' })
  })
})

describe('normalising a pasted value', () => {
  it('accepts the value on its own', () => {
    expect(normaliseValue('  cfat_secret  \n')).toBe('cfat_secret')
  })

  it('accepts what people actually paste', () => {
    for (const pasted of [
      'export CLOUDFLARE_API_TOKEN=cfat_secret',
      'CLOUDFLARE_API_TOKEN=cfat_secret',
      '"cfat_secret"',
      "'cfat_secret'\n",
    ]) {
      expect(normaliseValue(pasted), pasted).toBe('cfat_secret')
    }
  })

  it('does not mistake a value containing = for an assignment', () => {
    expect(normaliseValue('AAAA/BBB+ccc=')).toBe('AAAA/BBB+ccc=')
  })
})

describe('the verdict', () => {
  it('separates missing from broken, because they are different jobs', () => {
    expect(verdictOf({ present: false, required: true }).state).toBe('missing')
    expect(verdictOf({ present: true, required: true, probe: { ok: false, why: 'x' } }).state).toBe(
      'broken',
    )
  })

  it('says unverified rather than ok when nothing was probed', () => {
    /**
     * The distinction earned its keep on the first run: a working token was
     * reported BAD because the probe called an endpoint that does not answer
     * for account-scoped tokens. "Present but unprobed" must never read as
     * "fine", and a failed probe must never read as "missing" — one sends you
     * to fix a credential, the other to create one.
     */
    expect(verdictOf({ present: true, required: true, probe: null }).state).toBe('unverified')
    expect(verdictOf({ present: true, required: true }).state).toBe('unverified')
  })

  it('carries the probe’s own words rather than a summary of them', () => {
    expect(verdictOf({ present: true, required: true, probe: { ok: true, why: 'database "okolos"' } }).why).toBe(
      'database "okolos"',
    )
  })
})

describe('the feed signing key', () => {
  const pem = (): string =>
    generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()

  it('is checked against the public half the extension compiles in', () => {
    // Not "is it a key" — a valid key for the wrong pair signs feeds that every
    // install rejects, and nothing says so until production.
    const anchor = compiledPublicKey()
    expect(anchor, 'the extension names no public key').not.toBeNull()
    expect(feedKeyMatches(pem(), anchor).ok).toBe(false)
  })

  it('refuses what is not a key at all, by name', () => {
    expect(feedKeyMatches('not a key', 'AAAA').why).toMatch(/not a usable private key/)
  })

  it('says so when there is nothing to compare against', () => {
    expect(feedKeyMatches(pem(), null).why).toMatch(/names no public key/)
  })
})

describe('the list of accesses', () => {
  it('names, for each, what reads it and what it unblocks', () => {
    // An access nobody reads is a slot for a secret with no consumer — the
    // shape this repository gates one layer down as a destination with no
    // reader. Every entry must point at real code.
    expect(ACCESSES.length).toBeGreaterThan(3)
    for (const access of ACCESSES) {
      expect(access.readBy, `${access.name} says nothing about what reads it`).not.toBe('')
      expect(access.unblocks, `${access.name} says nothing about what it unblocks`).not.toBe('')
    }
  })

  it('keeps every secret outside the repository', () => {
    const root = process.cwd()
    for (const access of ACCESSES) {
      expect(access.file.startsWith(root), `${access.name} would be stored inside the repo`).toBe(
        false,
      )
    }
  })
})

describe('the mode of a secrets file', () => {
  /** A secrets file anyone may read. */
  const loose = () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'okolos-access-')), 'cloudflare.env')
    writeFileSync(file, 'X=1\n', { mode: 0o644 })
    return file
  }

  // Windows has no POSIX mode bits, so a 0644 file cannot be made there to be found;
  // this is the macOS and Linux promise, and it is skipped on win32 (B-163).
  it.skipIf(process.platform === 'win32')('is BAD when others can read it, on macOS and Linux', () => {
    expect(permissionProblem(loose(), 'darwin')).toMatch(/readable by others/)
  })

  it('is not checked on Windows, rather than reported BAD for a mode that does not exist there', () => {
    expect(modesApply('win32')).toBe(false)
    expect(modesApply('linux')).toBe(true)
    expect(permissionProblem(loose(), 'win32')).toBeNull()
  })
})

describe('running it as a command', () => {
  it('answers on its command line, so the run guard matches however the path is spelled', () => {
    // The guard compared import.meta.url with `file://` + argv[1], which never holds on
    // Windows (`C:\…`), so the tool ran nothing there. An unknown command is answered
    // offline, which is all this needs.
    const run = spawnSync(process.execPath, [path.join(import.meta.dirname, 'access.mjs'), 'no-such-command'], {
      encoding: 'utf8',
    })
    expect(run.status).toBe(1)
    expect(run.stderr).toContain('unknown command')
  })
})
