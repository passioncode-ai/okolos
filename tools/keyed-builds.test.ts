import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

// A URL, not a path: an ES module import of `C:\\...` is a URL with the scheme `c:` on Windows.
const guard = pathToFileURL(path.resolve(import.meta.dirname, 'keyed-builds.mjs')).href
const made: string[] = []

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Runs a script that arms the guard over one fake target build, then ends the way `end` says. */
function run(end: string, { signal }: { signal?: NodeJS.Signals } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'okolos-keyed-'))
  made.push(root)
  const target = path.join(root, 'chrome')
  mkdirSync(target)
  writeFileSync(path.join(target, 'background.js'), 'A-SH-0000000000')
  const script = `
    import { guardKeyedBuilds } from ${JSON.stringify(guard)}
    const keyed = guardKeyedBuilds([${JSON.stringify(target)}], { log: () => {} })
    keyed.arm()
    ${end}
  `
  return new Promise<{ target: string; code: number | null }>((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, target], { stdio: ['ignore', 'pipe', 'ignore'] })
    if (signal) child.stdout.once('data', () => child.kill(signal))
    child.on('exit', (code) => resolve({ target, code }))
  })
}

describe('a keyed store build in dist/', () => {
  it('is removed when the run throws', async () => {
    const { target } = await run(`throw new Error('zip failed')`)
    expect(existsSync(target)).toBe(false)
  })

  it('is removed when the run exits early', async () => {
    const { target } = await run(`process.exit(1)`)
    expect(existsSync(target)).toBe(false)
  })

  // On Windows a SIGTERM from another process ends the child at once, with no handler run; there
  // the guard answers Ctrl-C (SIGINT) and every exit, which the other cases hold.
  it.skipIf(process.platform === 'win32')('is removed when the run is stopped by a signal', async () => {
    const { target, code } = await run(`console.log('ready'); setInterval(() => {}, 1000)`, { signal: 'SIGTERM' })
    expect(existsSync(target)).toBe(false)
    expect(code).toBe(143)
  })

  it.skipIf(process.platform === 'win32')('is removed when the terminal closes (SIGHUP)', async () => {
    const { target, code } = await run(`console.log('ready'); setInterval(() => {}, 1000)`, { signal: 'SIGHUP' })
    expect(existsSync(target)).toBe(false)
    expect(code).toBe(129)
  })

  it.skipIf(process.platform === 'win32')('is removed even when the build still running would write it after the signal', async () => {
    // The parent alone is signalled, as a runner forwarding SIGTERM to its direct child does; the
    // build it started must end first, or it writes the keyed target after the removal.
    // As esbuild does: the directory is made again, then the file written into it.
    const late = `setTimeout(() => { const fs = require('node:fs'); fs.mkdirSync('TARGET', { recursive: true }); fs.writeFileSync('TARGET/background.js', 'A-SH-0000000000') }, 1000)`
    const { target } = await run(
      `
      import { spawn } from 'node:child_process'
      const child = spawn(process.execPath, ['-e', ${JSON.stringify(late)}.replaceAll('TARGET', process.argv[1])], { stdio: 'ignore' })
      keyed.watch(child)
      console.log('ready')
      setInterval(() => {}, 1000)
      `,
      { signal: 'SIGTERM' },
    )
    await new Promise((resolve) => setTimeout(resolve, 1500))
    expect(existsSync(target)).toBe(false)
  })

  it('stays once the keyless rebuild has finished and the guard is disarmed', async () => {
    const { target } = await run(`keyed.disarm()`)
    expect(existsSync(target)).toBe(true)
  })
})
