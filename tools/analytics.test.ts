import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { CATALOGUE } from '../apps/extension/src/background/usage/catalogue.js'
import { directoriesIn, filesIn } from './tree.mjs'

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

/**
 * The policy carries the same list (round 13, product tier): the served `/privacy` page drops links
 * to `.md` files, so a list that lived only in `docs/analytics.md` was one a reader of the policy
 * could not reach.
 */
const policy = readFileSync(path.join(root, 'docs/privacy.md'), 'utf8')
const policyRows = policy
  .split('\n')
  .filter((line) => /^\| `[a-z_]+` \|/.test(line))
  .map((line) => line.split('|').map((cell) => cell.trim()))

const valuesOf = (cell: string | undefined): string[] => [...(cell ?? '').matchAll(/`([a-z0-9_-]+)`/g)].map((m) => m[1] as string)
const expectedOf = (name: keyof typeof CATALOGUE): string[] =>
  Object.entries(CATALOGUE[name]).flatMap(([key, values]) => [key, ...(values as readonly string[])])

describe('the privacy policy lists the events itself', () => {
  it('names the same events', () => {
    expect(policyRows.map((cells) => cells[1]?.replaceAll('`', '')).sort()).toEqual(Object.keys(CATALOGUE).sort())
  })

  it('names the constant labels every event carries (round 16, product tier)', () => {
    const sink = readFileSync(path.join(root, 'apps/extension/src/background/usage/sink.ts'), 'utf8')
    const labels = [
      /const SDK_VERSION = '([^']+)'/.exec(sink)?.[1],
      /platform: '([^']+)'/.exec(sink)?.[1],
    ]
    for (const label of labels) {
      expect(label, 'sink.ts no longer names the label this test reads').toBeTruthy()
      for (const [file, text] of [['docs/privacy.md', policy], ['docs/brand/facts.md', readFileSync(path.join(root, 'docs/brand/facts.md'), 'utf8')]] as const) {
        expect(text, `${file} does not name ${label}`).toContain(`\`${label}\``)
      }
    }
  })

  it('lists every value of every prop, and no other', () => {
    for (const cells of policyRows) {
      const name = cells[1]?.replaceAll('`', '') as keyof typeof CATALOGUE
      expect(valuesOf(cells[3]).sort(), name).toEqual(expectedOf(name).sort())
    }
  })
})

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
        // The event's own name, not any `check: '` nearby: a row pointing at another event's line
        // must fail (B-215).
        expect(around, `${file}:${line} does not send ${name}`).toMatch(new RegExp(`'${name}'`))
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
    const builds = existsSync(dist) ? directoriesIn(dist).filter((name) => name !== 'release') : []
    const hits: string[] = []
    for (const build of builds) {
      const dir = path.join(dist, build)
      for (const file of filesIn(dir, '.js')) {
        if (/A-SH-\d{10}/i.test(readFileSync(path.join(dir, file), 'utf8'))) hits.push(`${build}/${file}`)
      }
    }
    expect(hits).toEqual([])
  })

  it('leaves no keyed build behind it: `pnpm package` rebuilds dist/<target> without the key, and any other way out removes them', () => {
    // A store build in dist/chrome would send production events from an unpacked load, and
    // `pnpm test` would go red here after every release until someone rebuilt (round 1, R3).
    const source = readFileSync(path.join(root, 'tools/package.mjs'), 'utf8')
    const tail = source.slice(source.indexOf('pruneReleases(out)'))
    const rebuild = tail.match(/delete process\.env\.APTABASE_APP_KEY_OKOLOS[\s\S]*?delete process\.env\.OKOLOS_USAGE_ENV[\s\S]*?runToCompletion\('pnpm', \['build'\]/)
    expect(rebuild, 'a keyless rebuild after the last archive').not.toBeNull()
    const die = source.slice(source.indexOf('function die('), source.indexOf('process.exit(1)'))
    expect(die).toContain('keyedBuilds.drop()')
    // Armed before the first keyed build is spawned, and disarmed only after the keyless one.
    const firstBuild = source.indexOf("runToCompletion('pnpm', ['build']")
    expect(source.lastIndexOf('keyedBuilds.arm()', firstBuild), 'armed before the first build').toBeGreaterThan(-1)
    expect(tail.indexOf('keyedBuilds.disarm()')).toBeGreaterThan(tail.indexOf("runToCompletion('pnpm', ['build']"))
    // Every other way out is the guard's own: tools/keyed-builds.test.ts.
  })
})

/**
 * This repository is public, and the operator's personal deployments are not (round 14, seam
 * tier): the other Aptabase instance, its repository and the agent that answered for it are named
 * by role in tracked files, never by name. The names are built from parts so this file is not one.
 */
describe('private deployments', () => {
  it('are named in no tracked file', () => {
    const names = [['sshlg', 'analytics'].join('-'), ['sshlg', 'growth'].join('-'), ['analytics', 'sshlg', 'me'].join('.')]
    const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean)
    const hits = tracked.filter((file) => {
      const full = path.join(root, file)
      // A tracked path that is not a regular file (a submodule, a link to a directory) is skipped,
      // not read: reading it would throw instead of reporting (B-215).
      if (!existsSync(full) || !statSync(full).isFile() || /\.(png|jpe?g|webp|ico|zip|woff2?)$/.test(file)) return false
      const text = readFileSync(full, 'utf8')
      return names.some((name) => text.includes(name))
    })
    expect(hits).toEqual([])
  })
})
