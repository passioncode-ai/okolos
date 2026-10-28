import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { FAILED, launch, runsFromSources } from './launch.mjs'
import { EXIT } from './scan.js'

/**
 * The launcher with the node it runs on injected: an old node is tested
 * without installing one. `bin.test.ts` spawns the real command.
 */
describe('the failure code', () => {
  it('is the unread code of scan.ts, never 0 or 1', () => {
    expect(FAILED).toBe(EXIT.unreadable)
  })
})

describe('the floors and the root engines', () => {
  it('say the same versions, so a node engines allows can run the command', () => {
    const engines = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')).engines.node
    expect(engines).toBe('^22.18.0 || >=23.6.0')
    for (const node of ['22.18.0', '23.6.0', '24.0.0']) expect(runsFromSources(node, 'strip'), node).toBe(true)
    for (const node of ['22.17.9', '23.5.0']) expect(runsFromSources(node, 'strip'), node).toBe(false)
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
    expect(out.lines.join('')).toMatch(/^okolos-mail: .*22\.18.*22\.17\.0/)
  })

  it('names both floors to a node of the 23 line below 23.6, which it also refuses', async () => {
    const out = quiet()
    const code = await launch({
      argv: ['scan', 'x'],
      env: {},
      node: '23.3.0',
      typescript: undefined,
      load: async () => ({ run: () => undefined }),
      write: out.write,
    })
    expect(code).toBe(EXIT.unreadable)
    expect(out.lines.join('')).toMatch(/22\.18.*23\.6.*23\.3\.0/)
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
    expect(out.lines[0]).toMatch(/^okolos-mail: .*planted/)
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
