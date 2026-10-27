import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import ts from 'typescript'
import { afterAll, describe, expect, it } from 'vitest'

import { EXIT } from './scan.js'
import { filesUnder } from '../../../tools/tree.mjs'

/**
 * `index.ts` started directly, the way a person tries a package before reading
 * its `bin`: `node src/index.ts`, or `node dist/index.js` after `tsc -b`.
 *
 * Spawned, never imported: importing this module from a test would start the
 * command inside the test runner, which is the point of the module.
 *
 * B-161 round 2: the built `index.js` exited 1 without scanning, because its
 * static imports reach the TypeScript sources of the workspace packages and
 * plain node cannot link them. A direct start now goes through the same
 * launcher as `okolos-mail`: the node check, the resolve hook, exit 2 with an
 * `okolos-mail:` line on any failure.
 */
const root = process.cwd()
const app = path.join(root, 'apps/mail-cli')
const src = path.join(app, 'src')

const messages = JSON.parse(
  readFileSync(path.join(root, 'apps/extension/_locales/ru/messages.json'), 'utf8'),
) as Record<string, { message: string }>
const word = (key: string): string => messages[key]?.message ?? `[${key}]`

const scratch = mkdtempSync(path.join(os.tmpdir(), 'okolos-mail-index-'))
const clean = path.join(scratch, 'clean.eml')
writeFileSync(clean, ['From: a@b.test', 'Subject: s', '', 'body', ''].join('\r\n'))
const empty = path.join(scratch, 'empty.eml')
writeFileSync(empty, '')

/**
 * What `tsc -b` puts in `dist/`, made here without touching `dist/`: every
 * source module transpiled into a directory beside `src/`, so relative imports
 * resolve exactly as they do from `dist/`.
 */
const built = mkdtempSync(path.join(app, '.direct-start-'))
for (const file of filesUnder(src, '.ts')) {
  if (file.endsWith('.test.ts')) continue
  const output = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, verbatimModuleSyntax: true },
  }).outputText
  writeFileSync(path.join(built, path.basename(file).replace(/\.ts$/, '.js')), output)
}

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
  rmSync(built, { recursive: true, force: true })
})

function start(entry: string, args: readonly string[]) {
  const out = spawnSync(process.execPath, [entry, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, OKOLOS_LOCALE: 'ru' },
  })
  return { code: out.status, stdout: out.stdout, stderr: out.stderr }
}

const count = (text: string, needle: string): number => text.split(needle).length - 1

describe('index started directly', () => {
  it('from the sources, scans once and exits with the verdict', () => {
    const out = start(path.join(src, 'index.ts'), ['scan', clean])
    expect(out.stderr).toBe('')
    expect(count(out.stdout, word('mailVerdictNone'))).toBe(1)
    expect(out.code).toBe(EXIT.nothingFound)
  })

  it('from a build, scans once and exits with the verdict', () => {
    const out = start(path.join(built, 'index.js'), ['scan', clean])
    expect(out.stderr).toBe('')
    expect(count(out.stdout, word('mailVerdictNone'))).toBe(1)
    expect(out.code).toBe(EXIT.nothingFound)
  })

  it('from a build, refuses an empty message with 2', () => {
    const out = start(path.join(built, 'index.js'), ['scan', empty])
    expect(out.stdout).toContain(word('mailParseEmpty'))
    expect(out.code).toBe(EXIT.unreadable)
  })

  /**
   * The old failure, held shut by construction: B-161 compared `argv[1]` with
   * the module's own path, and every spelling that comparison missed (Windows
   * separators, `\\?\` long paths, 8.3 short names, a link) ran nothing and
   * exited 0. Nothing in the command decides by `argv[1]` any more; the
   * launcher always runs it, and a direct start always does too.
   */
  it('decides nothing by argv[1]', () => {
    const files = [...filesUnder(src, '.ts'), ...filesUnder(src, '.mjs'), ...filesUnder(path.join(app, 'bin'), '.mjs')]
      .filter((file) => !file.endsWith('.test.ts'))
    expect(files.length).toBeGreaterThanOrEqual(5)
    // Code, not prose: the comments that tell this story name argv[1] too.
    const code = (file: string): string =>
      readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    const readers = files.filter((file) => /argv\s*\[\s*1\s*\]/.test(code(file)))
    expect(readers.map((file) => path.relative(root, file))).toEqual([])
  })
})
