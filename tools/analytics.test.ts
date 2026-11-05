import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { CATALOGUE } from '../apps/extension/src/background/usage/catalogue.js'

/**
 * `docs/analytics.md` and the code's catalogue say the same thing (B-198), and every place the
 * table names as a sender really sends that event. A table is the history a person reads; an
 * event the table does not name, or a value it does not list, would be one nobody reviewed.
 */
const root = path.resolve(import.meta.dirname, '..')
const doc = readFileSync(path.join(root, 'docs/analytics.md'), 'utf8')

const rows = doc
  .split('\n')
  .filter((line) => /^\| `[a-z_]+` \|/.test(line))
  .map((line) => line.split('|').map((cell) => cell.trim()))

describe('the event catalogue, for people and for the code', () => {
  it('names the same events', () => {
    expect(rows.map((cells) => cells[1]?.replaceAll('`', '')).sort()).toEqual(Object.keys(CATALOGUE).sort())
  })

  it('lists every value of every prop, and no other', () => {
    for (const cells of rows) {
      const name = cells[1]?.replaceAll('`', '') as keyof typeof CATALOGUE
      const listed = [...(cells[3] ?? '').matchAll(/`([a-z0-9_-]+)`/g)].map((m) => m[1])
      const expected = Object.entries(CATALOGUE[name]).flatMap(([key, values]) => [key, ...(values as readonly string[])])
      expect(listed.sort(), name).toEqual([...expected].sort())
    }
  })

  it('points each active event at a line that sends it', () => {
    for (const cells of rows) {
      const name = cells[1]?.replaceAll('`', '') ?? ''
      if (cells[2] !== 'active') continue
      const sites = [...(cells[4] ?? '').matchAll(/`([^`]+\.ts):(\d+)`/g)]
      expect(sites.length, `${name} names no site`).toBeGreaterThan(0)
      for (const [, file, line] of sites) {
        const source = readFileSync(path.join(root, file as string), 'utf8').split('\n')
        const around = source.slice(Number(line) - 3, Number(line) + 1).join('\n')
        expect(around, `${file}:${line} does not send ${name}`).toMatch(new RegExp(`'${name}'|check: '`))
      }
    }
  })
})

/**
 * The App-Key lives in the vault (`passioncode-platform/prod/APTABASE_APP_KEY_OKOLOS`) and in the
 * store archive `pnpm package` makes with it, nowhere else. A key of the Aptabase shape is
 * `A-SH-` and ten digits; the tests' all-zero one is the only kind allowed in the tree.
 */
describe('the App-Key', () => {
  const real = /A-SH-(?!0{10})\d{10}/i

  it('is in no tracked file', () => {
    const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean)
    const hits = tracked.filter((file) => {
      try {
        return real.test(readFileSync(path.join(root, file), 'utf8'))
      } catch {
        return false
      }
    })
    expect(hits).toEqual([])
  })

  it('is in no build but the store archive: dist/<target> and the e2e builds carry none', () => {
    const dist = path.join(root, 'apps/extension/dist')
    const builds = existsSync(dist) ? readdirSync(dist).filter((name) => name !== 'release') : []
    const hits: string[] = []
    for (const build of builds) {
      const dir = path.join(dist, build)
      for (const file of readdirSync(dir).filter((name) => name.endsWith('.js'))) {
        if (/A-SH-\d{10}/i.test(readFileSync(path.join(dir, file), 'utf8'))) hits.push(`${build}/${file}`)
      }
    }
    expect(hits).toEqual([])
  })
})
