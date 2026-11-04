import { spawn, spawnSync } from 'node:child_process'
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
  /**
   * Plain JavaScript, so any node the root `engines` allows can start it and
   * reach its refusal. A `.ts` command on node 22.0 to 22.17 is rejected by node
   * before a line of it runs, with node's own exit 1, which this command uses
   * for "signals found".
   */
  it('is declared as a plain JavaScript file that exists', () => {
    expect(manifest.bin['okolos-mail']).toMatch(/\.mjs$/)
    expect(readFileSync(bin, 'utf8')).toMatch(/^#!\/usr\/bin\/env node\r?\n/)
  })

  /**
   * The nearest a test gets to an old node without installing one: this node
   * with type stripping switched off reads the launcher and cannot read the
   * sources, which is exactly the position of node 22.0 to 22.17.
   */
  it('exits 2 and names what it needs when node cannot strip types', () => {
    const out = okolosMail(['scan', clean], { before: ['--no-experimental-strip-types'] })
    expect(out.stdout).toBe('')
    // This node is new enough, so the line names the switch, not a version;
    // the version line is the injected case below.
    expect(out.stderr).toMatch(/^okolos-mail: .*type stripping switched off/)
    expect(out.code).toBe(EXIT.unreadable)
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
   * POSIX. Windows spellings of the path cannot matter: nothing reads `argv[1]`,
   * which `index.test.ts` holds.
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
   * process does not end with the 0 that means "nothing found", nor node's 1,
   * which means "signals found" here. Each plant replaces one module with one
   * that throws: `index.ts` as it loads, the earliest point the command's own
   * code can fail, and `scan.ts` inside `main`, the latest.
   */
  function plant(module: string, source: string): string[] {
    const file = path.join(dir, `plant-${module.replace(/\W/g, '-')}.mjs`)
    writeFileSync(
      file,
      [
        "import { registerHooks } from 'node:module'",
        'registerHooks({',
        '  load(url, context, next) {',
        `    if (url.endsWith(${JSON.stringify(`/apps/mail-cli/src/${module}`)})) {`,
        `      return { format: 'module', source: ${JSON.stringify(source)}, shortCircuit: true }`,
        '    }',
        '    return next(url, context)',
        '  },',
        '})',
        '',
      ].join('\n'),
    )
    return ['--import', pathToFileURL(file).href]
  }

  it('exits 2 with an okolos-mail: line when the command fails before it can scan', () => {
    const out = okolosMail(['scan', clean], { before: plant('index.ts', 'throw new Error("planted in load")') })
    expect(out.stderr).toMatch(/^okolos-mail: .*planted in load/)
    expect(out.stdout).not.toContain(word('mailVerdictNone'))
    expect(out.code).toBe(EXIT.unreadable)
  })

  it('exits 2 with an okolos-mail: line when main itself throws', () => {
    const out = okolosMail(['scan', clean], {
      before: plant(
        'scan.ts',
        'export const EXIT = { nothingFound: 0, signalsFound: 1, unreadable: 2 }\n' +
          'export function scan() { throw new Error("planted in main") }\n',
      ),
    })
    expect(out.stderr).toMatch(/^okolos-mail: .*planted in main/)
    expect(out.stdout).not.toContain(word('mailVerdictNone'))
    expect(out.code).toBe(EXIT.unreadable)
  })

  /**
   * B-161 round 2: a reader that goes away (`| head -1`, `| grep -q`) closes
   * the pipe, the write fails with EPIPE, and node with no listener for that
   * error exits 1, which here means "signals found", for a message in which
   * nothing was found. The reader leaving does not change the verdict, so the
   * code is the verdict's. A closed stderr must not turn a 2 into a 1 either.
   */
  async function withClosed(
    streams: readonly ('stdout' | 'stderr')[],
    args: readonly string[],
    before: readonly string[] = [],
  ): Promise<{ code: number | null; stderr: string }> {
    const child = spawn(process.execPath, [...before, bin, ...args], {
      cwd: root,
      env: { ...process.env, OKOLOS_LOCALE: 'ru' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    for (const name of streams) child[name].destroy()
    if (!streams.includes('stderr')) child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
    const code = await new Promise<number | null>((resolve) => child.on('close', (status) => resolve(status)))
    return { code, stderr }
  }

  it('ends with the verdict, not 1, when the reader has closed stdout', async () => {
    const out = await withClosed(['stdout'], ['scan', clean])
    expect(out.stderr).toBe('')
    expect(out.code).toBe(EXIT.nothingFound)
  })

  it('ends an unread message with 2 when the reader has closed stdout', async () => {
    const out = await withClosed(['stdout'], ['scan', empty])
    expect(out.stderr).toBe('')
    expect(out.code).toBe(EXIT.unreadable)
  })

  it('ends a failure with 2, not 1, when stderr is closed too', async () => {
    const out = await withClosed(['stdout', 'stderr'], ['scan', clean], plant('scan.ts', 'export const EXIT = {}\nexport function scan() { throw new Error("planted") }\n'))
    expect(out.code).toBe(EXIT.unreadable)
  })
})
