import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { findPython, noPythonMessage, pythonCandidates, pythonEnv, PYTHON3_CHECK } from './python.mjs'

/**
 * The gates find Python instead of spelling `python3` (B-162).
 *
 * The platform is a parameter, so the Windows order is checked on this machine too:
 * a rule that only runs where it applies is a rule nobody runs before it ships.
 */

const tool = path.resolve(import.meta.dirname, 'python.mjs')

describe('which names are tried', () => {
  it('asks python3 first on macOS and Linux, so the gates keep the interpreter they had', () => {
    expect(pythonCandidates('darwin')).toEqual([['python3'], ['python']])
    expect(pythonCandidates('linux')).toEqual([['python3'], ['python']])
  })

  it('asks the py launcher first on Windows, where python3 is often the Store alias', () => {
    expect(pythonCandidates('win32')).toEqual([['py', '-3'], ['python'], ['python3']])
  })

  it('makes each candidate prove it is Python 3 rather than trusting its name', () => {
    // 3.7 and later: the linters use syntax older 3.x cannot parse (round 8 of the B-162 certification).
    expect(PYTHON3_CHECK).toContain('sys.version_info[:2] >= (3, 7)')
    expect(PYTHON3_CHECK).toContain('sys.version_info[0] == 3')
  })
})

describe('choosing one', () => {
  it('takes the first candidate that answers', () => {
    const asked: string[] = []
    const found = findPython({
      platform: 'win32',
      probe: (command, args) => {
        asked.push([command, ...args].join(' '))
        return command === 'python'
      },
    })
    expect(found).toEqual({ command: 'python', args: [] })
    expect(asked).toEqual(['py -3', 'python'])
  })

  it('keeps the launcher argument when the launcher answers', () => {
    expect(findPython({ platform: 'win32', probe: () => true })).toEqual({ command: 'py', args: ['-3'] })
  })

  it('returns null when nothing answers, and the refusal names what was tried', () => {
    expect(findPython({ platform: 'linux', probe: () => false })).toBeNull()
    expect(noPythonMessage('win32')).toContain('py -3, python, python3')
  })

  it('finds a real Python 3 on this machine, which the runbook requires', () => {
    expect(findPython()).not.toBeNull()
  })
})

describe('the environment a linter gets', () => {
  it('turns on UTF-8 mode on Windows, where a piped stdout is cp1252 and the findings are Russian', () => {
    const env = pythonEnv({ PATH: 'p' }, 'win32')
    expect(env).toEqual({ PATH: 'p', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' })
  })

  it('passes the environment through unchanged on macOS and Linux', () => {
    const given = { PATH: 'p' }
    expect(pythonEnv(given, 'darwin')).toBe(given)
    expect(pythonEnv(given, 'linux')).toBe(given)
  })
})

describe('running a script through it', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'okolos-python-'))

  it("passes the script's output and exit code through", () => {
    const script = path.join(dir, 'exit3.py')
    writeFileSync(script, 'import sys\nprint("from python", sys.argv[1])\nsys.exit(3)\n')
    const run = spawnSync(process.execPath, [tool, script, 'arg'], { encoding: 'utf8' })
    expect(run.stdout.trim()).toBe('from python arg')
    expect(run.status).toBe(3)
  })

  it('exits 0 for a clean script', () => {
    const script = path.join(dir, 'ok.py')
    writeFileSync(script, 'pass\n')
    expect(() => execFileSync(process.execPath, [tool, script])).not.toThrow()
  })

  it('runs the linter when started through a linked directory, not exit 0 without it', () => {
    // The old guard compared import.meta.filename (the real path) with argv[1] (the
    // path as typed): through a symlink or a junction it skipped main and exited 0, a
    // gate passing without running. A junction needs no privilege on Windows; elsewhere
    // the type is ignored and this is a directory symlink.
    const linked = path.join(mkdtempSync(path.join(os.tmpdir(), 'okolos-python-link-')), 'tools')
    symlinkSync(import.meta.dirname, linked, 'junction')
    const script = path.join(dir, 'exit3-linked.py')
    writeFileSync(script, 'import sys\nprint("through the link")\nsys.exit(3)\n')
    const run = spawnSync(process.execPath, [path.join(linked, 'python.mjs'), script], { encoding: 'utf8' })
    expect(run.stdout.trim()).toBe('through the link')
    expect(run.status).toBe(3)
  })

  it('refuses a call that names no script', () => {
    const run = spawnSync(process.execPath, [tool], { encoding: 'utf8' })
    expect(run.status).toBe(2)
    expect(run.stderr).toContain('usage')
  })
})
