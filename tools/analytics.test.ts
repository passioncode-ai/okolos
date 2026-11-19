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

  it('points each active event at the function that sends it', () => {
    /**
     * By a function or a top-level handler, not a line number (B-220). Line numbers moved with every
     * edit above them in `index.ts` and went red three times in one day for no change to any event;
     * the place that sends is named instead, and its body must carry the event's own name.
     */
    for (const cells of rows) {
      const name = cells[1]?.replaceAll('`', '') ?? ''
      if (cells[2] !== 'active') continue
      const sites = [...(cells[4] ?? '').matchAll(/`([^`#]+\.ts)#([\w.]+)`/g)]
      expect(sites.length, `${name} names no site`).toBeGreaterThan(0)
      for (const [, file, anchor] of sites) {
        const body = topLevelBody(readFileSync(path.join(root, file as string), 'utf8'), anchor as string)
        expect(body, `${file}#${anchor} is not a top-level function or handler`).not.toBeNull()
        // The event's own name, not any `check: '` nearby: a row pointing at another event's
        // place must fail (B-215).
        expect(body ?? '', `${file}#${anchor} does not send ${name}`).toMatch(new RegExp(`'${name}'`))
      }
    }
  })

  it('reads a top-level body and nothing past it', () => {
    const source = ['function a() {', "  send('x')", '}', '', 'platform.on(() => {', "  send('y')", '})', ''].join('\n')
    expect(topLevelBody(source, 'a')).toContain("'x'")
    expect(topLevelBody(source, 'a')).not.toContain("'y'")
    expect(topLevelBody(source, 'platform.on')).toContain("'y'")
    expect(topLevelBody(source, 'missing')).toBeNull()
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

/**
 * The send limits are stated to people in docs/privacy.md and docs/analytics.md; the numbers are
 * read from the code here, so a constant changed in sink.ts or send.ts fails until both documents
 * say it too (B-215, round 10).
 */
describe('the send limits the documents state', () => {
  const sink = readFileSync(path.join(root, 'apps/extension/src/background/usage/sink.ts'), 'utf8')
  const send = readFileSync(path.join(root, 'apps/extension/src/background/usage/send.ts'), 'utf8')
  const value = (source: string, name: string): number => {
    const found = new RegExp(`const ${name} = ([0-9_ *]+)`).exec(source)?.[1]
    expect(found, `${name} is no longer a plain constant this test can read`).toBeTruthy()
    return (found as string).replaceAll('_', '').split('*').reduce((product, factor) => product * Number(factor.trim()), 1)
  }
  const perFlush = value(sink, 'PER_FLUSH')
  const queueMax = value(sink, 'QUEUE_MAX')
  const maxAge = value(sink, 'MAX_AGE_MS')
  const skew = value(sink, 'FUTURE_SKEW_MS')
  const deadline = value(send, 'SEND_DEADLINE_MS')
  const analyticsDoc = readFileSync(path.join(root, 'docs/analytics.md'), 'utf8')

  it('names the same numbers as the code', () => {
    expect(maxAge, 'the documents say «старше суток»').toBe(24 * 60 * 60 * 1000)
    for (const [file, text] of [['docs/privacy.md', policy], ['docs/analytics.md', analyticsDoc]] as const) {
      expect(text, `${file}: per flush`).toContain(`не больше ${perFlush} за раз`)
      expect(text, `${file}: queue cap`).toContain(`не больше ${queueMax}`)
      expect(text, `${file}: day`).toContain('старше суток')
    }
    expect(analyticsDoc).toContain(`без ответа ${deadline / 1000} секунд`)
    expect(analyticsDoc).toContain(`больше чем на ${skew / 60_000} минут`)
  })

  it('drops an event that would turn a day old during one request, the log opening included (B-214)', () => {
    const start = readFileSync(path.join(root, 'apps/extension/src/background/usage/start.ts'), 'utf8')
    expect(value(sink, 'IN_FLIGHT_MS')).toBeGreaterThanOrEqual(value(start, 'AUDIT_OPEN_MS') + deadline)
  })
})

/**
 * The body of a top-level `function NAME(` / `async function NAME(` or a top-level call such as
 * `platform.downloads.onCreated(`, up to the closing line at column 0; null when there is none.
 */
function topLevelBody(source: string, anchor: string): string | null {
  const lines = source.split('\n')
  const escaped = anchor.replace(/[.]/g, '\\.')
  const start = new RegExp(`^(?:export )?(?:async )?(?:function ${escaped}\\b|${escaped}\\()`)
  const from = lines.findIndex((line) => start.test(line))
  if (from === -1) return null
  const to = lines.findIndex((line, at) => at > from && /^\}/.test(line))
  return lines.slice(from, to === -1 ? undefined : to + 1).join('\n')
}

/**
 * What the service works out itself from each request (country, region, the daily device hash) is
 * stated in the `usage-data` fact; the switch text and the self-audit row name it in both languages,
 * so a person reading the extension learns what the privacy policy says (B-215, round 13).
 */
describe('the usage texts name what the service works out itself', () => {
  const facts = readFileSync(path.join(root, 'docs/brand/facts.md'), 'utf8')
  const row = facts.split('\n').find((line) => line.startsWith('| `usage-data` |')) ?? ''
  const catalogue = (locale: string) =>
    JSON.parse(readFileSync(path.join(root, `apps/extension/_locales/${locale}/messages.json`), 'utf8')) as Record<string, { message: string }>
  const named = {
    ru: [['страну', 'страну'], ['регион', 'регион'], ['суточный хеш', 'суточный хеш устройства']],
    en: [['страну', 'country'], ['регион', 'region'], ['суточный хеш', 'daily device hash']],
  } as const

  it('as long as the fact names it', () => {
    expect(row, 'docs/brand/facts.md has no `usage-data` row').not.toBe('')
    for (const [locale, words] of Object.entries(named)) {
      const messages = catalogue(locale)
      for (const [inFact, inText] of words) {
        if (!row.includes(inFact)) continue
        for (const key of ['usageWhat', 'auditKeptUsageData']) {
          expect(messages[key]?.message, `${locale} ${key} does not name «${inText}»`).toContain(inText)
        }
      }
    }
    expect(row).toContain('суточный хеш')
  })
})
