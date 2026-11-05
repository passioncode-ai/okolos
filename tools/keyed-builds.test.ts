import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

const guard = path.resolve(import.meta.dirname, 'keyed-builds.mjs')
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
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'ignore'] })
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

  it('is removed when the run is stopped by a signal', async () => {
    const { target, code } = await run(`console.log('ready'); setInterval(() => {}, 1000)`, { signal: 'SIGTERM' })
    expect(existsSync(target)).toBe(false)
    expect(code).toBe(143)
  })

  it('stays once the keyless rebuild has finished and the guard is disarmed', async () => {
    const { target } = await run(`keyed.disarm()`)
    expect(existsSync(target)).toBe(true)
  })
})
