import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { FAILED, NODE_RANGE, launch, runsFromSources } from './launch.mjs'
import { EXIT } from './scan.js'

/**
 * The launcher with the node it runs on injected: an old node is tested
 * without installing one. `bin.test.ts` spawns the real command.
 */
/**
 * One range in three places: the root `engines`, which a package manager reads;
 * the runbook, which a person reads; and the refusal, which a person on the
 * wrong node reads. Round 2 of SW-01 found `engines` still at `>=22` while the
 * command needed 22.18.
 */
describe('the node the command needs', () => {
  const root = process.cwd()

  it('is the range the root package.json declares', () => {
    const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
      engines: { node: string }
    }
    expect(manifest.engines.node).toBe(NODE_RANGE)
  })

  it('is the range the development runbook states', () => {
    const runbook = readFileSync(path.join(root, 'docs/runbooks/development.md'), 'utf8')
    const row = runbook.split(/\r?\n/).find((line) => line.startsWith('| Node |'))
    expect(row?.replace(/\\\|/g, '|')).toContain(`\`${NODE_RANGE}\``)
  })

  it('is the range runsFromSources accepts, at each edge', () => {
    expect(NODE_RANGE).toBe('^22.18.0 || >=23.6.0')
    expect(runsFromSources('22.17.99', 'strip')).toBe(false)
    expect(runsFromSources('22.18.0', 'strip')).toBe(true)
    expect(runsFromSources('22.99.0', 'strip')).toBe(true)
    expect(runsFromSources('23.5.99', 'strip')).toBe(false)
    expect(runsFromSources('23.6.0', 'strip')).toBe(true)
    expect(runsFromSources('21.99.0', 'strip')).toBe(false)
  })
})

describe('the failure code', () => {
  it('is the unread code of scan.ts, never 0 or 1', () => {
    expect(FAILED).toBe(EXIT.unreadable)
  })
})

describe('the launcher, with the node it runs on injected', () => {
  const quiet = () => {
    const lines: string[] = []
    return { lines, write: (text: string) => void lines.push(text) }
  }

  it('knows which nodes run the sources', () => {
    for (const node of ['22.18.0', '22.20.1', '23.6.0', '24.0.0', '26.10.0']) {
      expect(runsFromSources(node, 'strip'), node).toBe(true)
    }
    for (const node of ['22.0.0', '22.17.1', '23.0.0', '23.5.0', '20.19.0']) {
      expect(runsFromSources(node, undefined), node).toBe(false)
    }
    expect(runsFromSources('24.0.0', false)).toBe(false)
  })

  it('refuses an old node with 2 and names the node it needs, before loading anything', async () => {
    const out = quiet()
    let loaded = false
    const code = await launch({
      argv: ['scan', 'x'],
      env: {},
      node: '22.17.0',
      typescript: undefined,
      load: async () => {
        loaded = true
        return { run: () => undefined }
      },
      write: out.write,
    })
    expect(code).toBe(EXIT.unreadable)
    expect(loaded).toBe(false)
    expect(out.lines.join('')).toContain(`okolos-mail: Node.js ${NODE_RANGE} is needed`)
    expect(out.lines.join('')).toContain('this is Node.js 22.17.0')
  })

  it('ends with 2 and a line on stderr when loading the command fails', async () => {
    const out = quiet()
    const code = await launch({
      argv: ['scan', 'x'],
      env: {},
      node: '26.10.0',
      typescript: 'strip',
      load: async () => {
        throw new Error('planted')
      },
      write: out.write,
    })
    expect(code).toBe(EXIT.unreadable)
    expect(out.lines[0]).toMatch(/^okolos-mail: the command could not start: planted\n$/)
  })

  it('ends with 2 and an okolos-mail: line when the command throws', async () => {
    const out = quiet()
    const code = await launch({
      argv: ['scan', 'x'],
      env: {},
      node: '26.10.0',
      typescript: 'strip',
      load: async () => ({
        run: () => {
          throw new Error('planted in main')
        },
      }),
      write: out.write,
    })
    expect(code).toBe(EXIT.unreadable)
    expect(out.lines[0]).toMatch(/^okolos-mail: the command failed: planted in main\n$/)
  })

  it('ends with 2 and an okolos-mail: line when the command rejects', async () => {
    const out = quiet()
    const code = await launch({
      argv: ['scan', 'x'],
      env: {},
      node: '26.10.0',
      typescript: 'strip',
      load: async () => ({ run: async () => Promise.reject(new Error('planted later')) }),
      write: out.write,
    })
    expect(code).toBe(EXIT.unreadable)
    expect(out.lines[0]).toMatch(/^okolos-mail: the command failed: planted later\n$/)
  })

  it('hands the arguments to run and leaves the exit code to it', async () => {
    const out = quiet()
    const seen: unknown[] = []
    const code = await launch({
      argv: ['scan', 'x'],
      env: { OKOLOS_LOCALE: 'en' },
      node: '26.10.0',
      typescript: 'strip',
      load: async () => ({ run: (argv, env) => void seen.push(argv, env) }),
      write: out.write,
    })
    expect(code).toBeUndefined()
    expect(seen).toEqual([['scan', 'x'], { OKOLOS_LOCALE: 'en' }])
    expect(out.lines).toEqual([])
  })
})
