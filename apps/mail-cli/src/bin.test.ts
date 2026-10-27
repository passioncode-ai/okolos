import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { afterAll, describe, expect, it } from 'vitest'

import { EXIT } from './scan.js'

/**
 * The command as a person runs it: `node` on the file `package.json` names as
 * `bin`, a real message on disk, and the words and the exit status it ends with.
 *
 * B-161 is why this spawns rather than calling `main`. Every unit test was
 * green while the command, on Windows, ran nothing and exited 0: the defect was
 * in the lines that decide whether to call `main`, which no unit test reaches.
 */
const root = process.cwd()
const app = path.join(root, 'apps/mail-cli')
const manifest = JSON.parse(readFileSync(path.join(app, 'package.json'), 'utf8')) as {
  bin: Record<string, string>
}
const bin = path.join(app, manifest.bin['okolos-mail'] ?? '')

const messages = JSON.parse(
  readFileSync(path.join(root, 'apps/extension/_locales/ru/messages.json'), 'utf8'),
) as Record<string, { message: string }>
const word = (key: string): string => messages[key]?.message ?? `[${key}]`

const dir = mkdtempSync(path.join(os.tmpdir(), 'okolos-mail-bin-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const clean = path.join(dir, 'clean.eml')
writeFileSync(clean, ['From: a@b.test', 'Subject: s', '', 'body', ''].join('\r\n'))
const empty = path.join(dir, 'empty.eml')
writeFileSync(empty, '')

function okolosMail(
  args: readonly string[],
  options: { readonly entry?: string; readonly cwd?: string; readonly before?: readonly string[] } = {},
) {
  const out = spawnSync(process.execPath, [...(options.before ?? []), options.entry ?? bin, ...args], {
    cwd: options.cwd ?? root,
    encoding: 'utf8',
    env: { ...process.env, OKOLOS_LOCALE: 'ru' },
  })
  return { code: out.status, stdout: out.stdout, stderr: out.stderr }
}

const count = (text: string, needle: string): number => text.split(needle).length - 1

describe('okolos-mail, started the way a person starts it', () => {
  it('is declared as a file that exists', () => {
    expect(manifest.bin['okolos-mail']).toBeDefined()
    expect(readFileSync(bin, 'utf8')).toMatch(/^#!\/usr\/bin\/env node\n/)
  })

  it('prints its verdict once for a readable message and exits 0', () => {
    const out = okolosMail(['scan', clean])
    expect(out.stderr).not.toMatch(/Error/)
    expect(count(out.stdout, word('mailVerdictNone'))).toBe(1)
    expect(out.code).toBe(EXIT.nothingFound)
  })

  it('refuses an empty message with 2, never the 0 of a clean one', () => {
    const out = okolosMail(['scan', empty])
    expect(out.stdout).toContain(word('mailParseEmpty'))
    expect(out.stdout).not.toContain(word('mailVerdictNone'))
    expect(out.code).toBe(EXIT.unreadable)
  })

  it('refuses a file it cannot read with 2', () => {
    const out = okolosMail(['scan', path.join(dir, 'absent.eml')])
    expect(out.stdout).toContain(word('mailParseUnreadableFile'))
    expect(out.code).toBe(EXIT.unreadable)
  })

  it('prints its usage and exits 2 when asked for nothing it knows', () => {
    const out = okolosMail([])
    expect(out.stdout).toContain(word('mailUsage'))
    expect(out.code).toBe(EXIT.unreadable)
  })

  it('runs when started through a relative path', () => {
    const out = okolosMail(['scan', clean], { entry: path.relative(app, bin), cwd: app })
    expect(count(out.stdout, word('mailVerdictNone'))).toBe(1)
    expect(out.code).toBe(EXIT.nothingFound)
  })

  /**
   * npm and pnpm install a command on POSIX as a link with another name, so
   * `argv[1]` names neither the file nor its extension. The command must not
   * care: the old check would have run nothing here too. Windows gets a `.cmd`
   * shim instead of a link and creating one needs privileges, so this case is
   * POSIX; the Windows argv shape is `entry.test.ts`.
   */
  it.skipIf(process.platform === 'win32')('runs when started through a link with another name', () => {
    const link = path.join(dir, 'okolos-mail')
    symlinkSync(bin, link)
    const out = okolosMail(['scan', clean], { entry: link })
    expect(count(out.stdout, word('mailVerdictNone'))).toBe(1)
    expect(out.code).toBe(EXIT.nothingFound)
  })

  /**
   * The guarantee B-161 lacked: whatever goes wrong before a verdict, the
   * process does not end with the 0 that means "nothing found". The plant
   * replaces `index.ts` with a module that throws as it loads, which is the
   * earliest point the command's own code can fail.
   */
  it('exits 2, not 0, when the command fails before it can scan', () => {
    const plant = path.join(dir, 'plant.mjs')
    writeFileSync(
      plant,
      [
        "import { registerHooks } from 'node:module'",
        'registerHooks({',
        '  load(url, context, next) {',
        "    if (url.endsWith('/apps/mail-cli/src/index.ts')) {",
        "      return { format: 'module', source: 'throw new Error(\"planted\")', shortCircuit: true }",
        '    }',
        '    return next(url, context)',
        '  },',
        '})',
        '',
      ].join('\n'),
    )
    const out = okolosMail(['scan', clean], { before: ['--import', pathToFileURL(plant).href] })
    expect(out.stderr).toContain('planted')
    expect(out.stdout).not.toContain(word('mailVerdictNone'))
    expect(out.code).toBe(EXIT.unreadable)
  })

  /**
   * `index.ts` still runs when it is itself the file node was started with, as
   * a built or bundled copy would be. The resolve hook is the one `bin.ts`
   * installs, written out here because the test cannot import `bin.ts` without
   * running it.
   */
  it('runs main exactly once when index.ts is started directly', () => {
    const hook = path.join(dir, 'resolve-ts.mjs')
    writeFileSync(
      hook,
      [
        "import { registerHooks } from 'node:module'",
        'registerHooks({',
        '  resolve(specifier, context, next) {',
        '    try {',
        '      return next(specifier, context)',
        '    } catch (error) {',
        "      if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.endsWith('.ts')) {",
        "        return next(`${specifier.slice(0, -3)}.ts`, context)",
        '      }',
        '      throw error',
        '    }',
        '  },',
        '})',
        '',
      ].join('\n'),
    )
    const out = okolosMail(['scan', clean], {
      entry: path.join(app, 'src/index.ts'),
      before: ['--import', pathToFileURL(hook).href],
    })
    expect(count(out.stdout, word('mailVerdictNone'))).toBe(1)
    expect(out.code).toBe(EXIT.nothingFound)
  })
})
