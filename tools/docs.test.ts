import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { directoriesIn, filesIn, filesUnder } from './tree.mjs'
import { SCREENS } from './wireframes.mjs'
// A relative path, not the package name: `tools/` is not a workspace member, so
// vitest cannot resolve `@okolos/net` from here. The file is what matters anyway.
import { DESTINATIONS } from '../packages/net/src/destinations.js'

/**
 * The navigation layer, held to the same standard as the code.
 *
 * `docs/README.md` is the first file anyone opens, and it had been describing a
 * project at pipeline stage 2 with "the skeleton in progress" long after the
 * skeleton was thirty-seven requirements and three applications. Nothing broke;
 * it simply misled every reader at the moment they most needed orientation.
 *
 * Only falsifiable claims are asserted here. "Phase" is a judgement and stays a
 * judgement; a package that exists and is not on the map is a fact.
 */

const root = process.cwd()
const readme = readFileSync(path.join(root, 'docs/README.md'), 'utf8')
const brief = readFileSync(
  path.join(root, 'docs/superpowers/briefs/2026-08-04-okolos-p0-p5.md'),
  'utf8',
)

/**
 * The shipped Russian catalogue — the words a user actually reads, because
 * `default_locale` is `ru`. A screen record quotes what is on the screen, so
 * this is what its quoted labels are compared against.
 */
const CATALOGUE = JSON.parse(
  readFileSync(path.join(root, 'apps/extension/_locales/ru/messages.json'), 'utf8'),
) as Record<string, { message: string }>

/** The purposes the audited network path accepts, from the contract that defines them. */
const PURPOSES: string[] = (() => {
  const contract = readFileSync(path.join(root, 'packages/contracts/src/rpc.ts'), 'utf8')
  const block = /export type Purpose =([\s\S]*?)\n\n/.exec(contract)?.[1] ?? ''
  return [...block.matchAll(/'([a-z-]+)'/g)].map((m) => m[1] as string)
})()

const members = (dir: string): string[] => directoriesIn(path.join(root, dir))

describe('the map covers the territory', () => {
  it('names every package', () => {
    for (const name of members('packages')) {
      expect(readme, `packages/${name} is not on the map`).toContain(`\`${name}\``)
    }
  })

  it('names every application', () => {
    for (const name of members('apps')) {
      expect(readme, `apps/${name} is not on the map`).toContain(`\`apps/${name}\``)
    }
  })

  it('counts them correctly, in the form Russian puts the number in', () => {
    // «21 пакетов» is not Russian: the noun follows the number (1 пакет, 2 пакета,
    // 5 пакетов, 21 пакет). A gate that demanded one fixed form made the map
    // ungrammatical the day the count stopped ending in 0 or 5–9.
    expect(readme).toContain(`${members('packages').length} ${russianPlural(members('packages').length, ['пакет', 'пакета', 'пакетов'])}`)
    expect(readme).toContain(`${members('apps').length} ${russianPlural(members('apps').length, ['приложение', 'приложения', 'приложений'])}`)
  })

  it('declines the noun the way Russian does', () => {
    const forms: [string, string, string] = ['пакет', 'пакета', 'пакетов']
    expect([1, 2, 5, 11, 12, 21, 22, 25, 111].map((n) => russianPlural(n, forms))).toEqual([
      'пакет', 'пакета', 'пакетов', 'пакетов', 'пакетов', 'пакет', 'пакета', 'пакетов', 'пакетов',
    ])
  })
})

describe('the numbers agree with the ledger they summarise', () => {
  it('states the requirement total the brief actually has', () => {
    const total = [...brief.matchAll(/^\| REQ-\d+ \|/gm)].length
    expect(readme).toContain(`Требования | ${total}:`)
  })

  it('states how many are partial, counted rather than remembered', () => {
    const partial = [...brief.matchAll(/^\| REQ-\d+ \|.*PARTIAL/gm)].length
    expect(readme).toContain(`${partial} PARTIAL`)
  })
})

describe('the module map names modules that exist', () => {
  const map = readFileSync(path.join(root, 'docs/superpowers/module-map.md'), 'utf8')

  it('has no ghost packages', () => {
    // It named `core-url`, `core-page` and `playbooks` for a week. A plan that
    // survives into a map becomes a map of a product nobody built.
    const packages = new Set(members('packages'))
    for (const name of new Set([...map.matchAll(/`(core-[a-z-]+)`/g)].map((m) => m[1] as string))) {
      expect(packages.has(name), `module-map names ${name}, which is not a package`).toBe(true)
    }
  })

  it('has no ghost UI surfaces', () => {
    const surfaces = new Set(members('packages/ui/src'))
    for (const name of new Set([...map.matchAll(/`ui\/([a-z-]+)`/g)].map((m) => m[1] as string))) {
      expect(surfaces.has(name), `module-map names ui/${name}, which is not a surface`).toBe(true)
    }
  })
})

describe('the coverage matrix claims only what shipped', () => {
  const matrix = readFileSync(path.join(root, 'docs/coverage-matrix.md'), 'utf8')
  const brief = readFileSync(
    path.join(root, 'docs/superpowers/briefs/2026-08-04-okolos-p0-p5.md'),
    'utf8',
  )

  it('backs every tick with a requirement the ledger calls done', () => {
    // A promise sheet written before implementation is a fine thing to have,
    // and a dangerous thing to leave unmarked: a reader takes every row as a
    // capability. The tick is the difference, so the tick has to be earned.
    for (const [, row, claim] of matrix.matchAll(
      /^\| ([0-9]+\.[0-9]+) \|.*\*\*✓\*\* ([^|]+)\|$/gm,
    )) {
      for (const [, req] of (claim as string).matchAll(/REQ-(\d+)/g)) {
        const line = new RegExp(`^\\| REQ-${req} \\|.*$`, 'm').exec(brief)?.[0] ?? ''
        expect(line, `row ${row} cites REQ-${req}`).toMatch(/DONE|PARTIAL/)
      }
    }
  })

  it('cites only specs that exist', () => {
    for (const [, row, claim] of matrix.matchAll(
      /^\| ([0-9]+\.[0-9]+) \|.*\*\*✓\*\* ([^|]+)\|$/gm,
    )) {
      for (const [, spec] of (claim as string).matchAll(/(e2e\/[a-z0-9-]+)/g)) {
        expect(
          existsSync(path.join(root, `${spec}.spec.ts`)),
          `row ${row} cites ${spec}.spec.ts, which is not there`,
        ).toBe(true)
      }
    }
  })

  it('says outright that an unmarked row is not a capability', () => {
    expect(matrix).toMatch(/строка без отметки — намерение/i)
  })

  it('backs every tick with code, not only with a requirement', () => {
    /**
     * The hole this closes. A tick used to be earned by citing a REQ the ledger calls
     * DONE — and a REQ can cover several rows, so row 2.2 ("block by hash") carried a
     * tick on REQ-19 while **nothing in the tree computed a hash**: no MalwareBazaar,
     * no VirusTotal, no `crypto.subtle.digest` over the bytes, and the production path
     * hard-coded `hash: { ran: false }`. The verdict was honest; the matrix was not,
     * and a reader takes a ticked row as a capability (B-57).
     *
     * So a tick has to name a path, and the path has to be there. Seven of the
     * twenty-one ticked rows named none when this was written.
     */
    const ticked = [...matrix.matchAll(/^\| ([0-9]+\.[0-9]+) \|.*\*\*✓\*\* ([^|]+)\|$/gm)]
    expect(ticked.length, 'no ticked rows parsed out of the matrix').toBeGreaterThan(10)

    for (const [, row, claim] of ticked) {
      /**
       * Two citation forms, because the matrix uses both and neither is wrong: a
       * backticked path to the module that performs the check, or a bare `e2e/scn-007`
       * naming the scenario that exercises it. Demanding one form would have meant
       * rewriting fourteen rows to satisfy a regex rather than to say anything truer.
       */
      const modules = [
        ...(claim as string).matchAll(/`((?:apps|packages|tools|e2e)\/[\w./-]+)`/g),
      ].map((found) => path.join(root, found[1] as string))
      const specs = [...(claim as string).matchAll(/(?<!`)(e2e\/[a-z0-9-]+)(?![\w/-])/g)].map(
        (found) => path.join(root, `${found[1] as string}.spec.ts`),
      )
      const cited = [...modules, ...specs]

      expect(
        cited.length,
        `row ${row} is ticked and names no file — a REQ is not an implementation`,
      ).toBeGreaterThan(0)
      for (const file of cited) {
        expect(
          existsSync(file),
          `row ${row} cites ${path.relative(root, file)}, which is not there`,
        ).toBe(true)
      }
    }
  })
})

describe('a screen record names the controls its renderer draws', () => {
  /**
   * A quoted string in a record's Elements line means "this screen has a
   * control with this label". Anything else — a description, a reference to a
   * control on another screen — goes unquoted, because that is the only rule
   * this check can rely on.
   *
   * Comparison is normalised for case and punctuation, and a renderer label may
   * extend the record's: "Show all" matches "Show all (12 more)". What it will
   * not do is match a different control.
   *
   * Six records and renderers disagreed when this was written. All six were
   * harmless in themselves — "Wipe all data" against a button reading "Delete
   * all data" — and that is the point: they were noise, and the same twelve-line
   * report had been hiding two unwritten buttons and an unreachable module.
   */
  const screens = readFileSync(path.join(root, 'docs/ux/screens.md'), 'utf8')
  // From the generator itself, not a sidecar it writes: a JSON file under
  // graphify-out is absent on a fresh clone and stale everywhere else.
  const sources: Record<string, { source: string }> = SCREENS

  const normalise = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, '')

  it('knows about every screen with a renderer', () => {
    // Sixteen of eighteen. SCR-17 and SCR-18 are pages the worker serves whole
    // — a landing page and a privacy document — so there is no renderer whose
    // controls a record could be checked against, and pretending otherwise
    // would mean inventing an Elements line nothing draws.
    expect(Object.keys(sources).length).toBe(16)
  })

  for (const [id, meta] of Object.entries(sources)) {
    it(`${id} draws every control it names`, () => {
      const block = screens.split(`### ${id}:`)[1]?.split('\n### SCR-')[0] ?? ''
      const elements = /- \*\*Elements:\*\*\s*(.+)/.exec(block)?.[1] ?? ''
      expect(elements, `${id} has no Elements line`).not.toBe('')

      // A renderer may compose its copy from a module it imports — the leaks
      // panel takes its group headings from `core-leaks`. Following the
      // workspace imports one level keeps the check honest without pretending
      // every string lives in one file.
      const renderer = readFileSync(path.join(root, meta.source), 'utf8')
      const imported = [...renderer.matchAll(/from '(@okolos\/[a-z-]+)'/g)]
        .map((m) => `packages/${(m[1] as string).replace('@okolos/', '')}/src`)
        .flatMap((dir) => {
          try {
            return filesIn(path.join(root, dir), '.ts')
              .filter((name) => !name.endsWith('.test.ts'))
              .map((name) => readFileSync(path.join(root, dir, name), 'utf8'))
          } catch {
            return []
          }
        })

      // Three kinds of renderer live in this repo now. A DOM renderer names its
      // copy in string literals; a server-rendered screen writes it as markup
      // inside a template literal, where the label is a text node between tags;
      // and a localised renderer names a key, whose words live in the shipped
      // catalogue. Reading only literals would let this gate go quiet exactly
      // as a screen becomes translatable — the moment its labels stop being
      // visible in its own source.
      const resolved = [...renderer.matchAll(/\bt\(\s*'([a-zA-Z0-9_.]+)'/g)]
        .map((m) => CATALOGUE[m[1] as string]?.message)
        .filter((message): message is string => message !== undefined)

      const literals = [renderer, ...imported]
        .flatMap((text) => [
          ...text.matchAll(/'([^'\n]{2,60})'/g),
          ...text.matchAll(/>([^<>{}`\n]{2,60})</g),
        ])
        .map((m) => normalise(m[1] as string))
        .concat(resolved.map(normalise))

      for (const [, label] of elements.matchAll(/"([^"]{2,40})"/g)) {
        const wanted = normalise(label as string)
        expect(
          literals.some((literal) => literal === wanted || literal.startsWith(wanted)),
          `${id} names a control "${label}" that ${meta.source} does not draw`,
        ).toBe(true)
      }
    })
  }
})

describe('every citation names something that exists', () => {
  /**
   * Coverage lines used to cite `file:line`. Twenty-nine of a hundred and seven
   * had rotted — pointing at a blank line, a closing brace, the middle of a
   * comment — because a line number is a coordinate into a moving target and
   * nothing checked them.
   *
   * They cite a symbol now, or the file alone where the whole file is the
   * evidence. A symbol survives the code moving; when it is renamed away, this
   * fails, which is the point.
   */
  const docs = [
    'docs/ux/scenarios.md',
    'docs/ux/screens.md',
    'docs/superpowers/audits/2026-08-05-acceptance.md',
  ]

  const citation = /\b((?:packages|apps|tools|e2e|docs)\/[\w./-]+\.(?:ts|mjs|py|md))(?::([A-Za-z_$][\w$]*))?/g

  /**
   * Only lines that claim evidence. A path can appear in prose for other
   * reasons — the design-system block names a `tokens.ts` it calls "planned",
   * and a plan is allowed to describe a file that does not exist yet.
   */
  const claims = (doc: string): string[] =>
    readFileSync(path.join(root, doc), 'utf8')
      .split('\n')
      .filter((line) => /\*\*Coverage:\*\*|^\| `/.test(line))
      .filter((line) => !/\bplanned\b/.test(line))

  it('finds citations to check', () => {
    // An empty sweep would make every assertion below vacuous.
    const found = docs.flatMap((doc) => claims(doc).flatMap((line) => [...line.matchAll(citation)]))
    expect(found.length).toBeGreaterThan(50)
  })

  for (const doc of docs) {
    it(`${doc} cites only files that exist`, () => {
      for (const line of claims(doc)) {
        for (const [, file] of line.matchAll(citation)) {
          expect(existsSync(path.join(root, file as string)), `${doc} cites ${file}`).toBe(true)
        }
      }
    })

    it(`${doc} cites only symbols its files define`, () => {
      for (const line of claims(doc)) {
        for (const [, file, symbol] of line.matchAll(citation)) {
          if (!symbol) continue
          const source = readFileSync(path.join(root, file as string), 'utf8')
          expect(
            new RegExp(`\\b${symbol}\\b`).test(source),
            `${doc} cites ${file}:${symbol}, which that file does not define`,
          ).toBe(true)
        }
      }
    })

    it(`${doc} has no line-number citations left`, () => {
      // A line number is a coordinate into a moving target; it rots silently.
      const text = readFileSync(path.join(root, doc), 'utf8')
      const numeric = [...text.matchAll(/\b(?:packages|apps|tools|e2e|docs)\/[\w./-]+\.(?:ts|mjs|py|md):(\d+)/g)]
      expect(numeric.map((m) => m[0])).toEqual([])
    })
  }
})

describe('the standing instructions list is complete', () => {
  /**
   * Instructions 7, 8 and 9 were written into retro entries and never added to
   * the list at the top. A reader following the list got six of nine — and the
   * list is what stage 0 of every run reads.
   */
  const retro = readFileSync(path.join(root, 'docs/superpowers/retro.md'), 'utf8')
  const listed = new Set(
    [...retro.matchAll(/^(\d+)\.\s+\*\*/gm)].map((m) => Number(m[1])),
  )
  const referenced = new Set(
    [...retro.matchAll(/[Ss]tanding instruction \(?(\d+)\)?/g)].map((m) => Number(m[1])),
  )

  it('has a list to check', () => {
    expect(listed.size).toBeGreaterThan(5)
  })

  it('lists every instruction an entry refers to', () => {
    for (const n of referenced) {
      expect(listed.has(n), `an entry cites standing instruction ${n}, which the list omits`).toBe(
        true,
      )
    }
  })

  it('is numbered without gaps', () => {
    // A gap means one was deleted and the rest not renumbered, so a citation
    // now points at the wrong rule.
    const sorted = [...listed].sort((a, b) => a - b)
    expect(sorted).toEqual(sorted.map((_, index) => index + 1))
  })
})

describe('documents do not carry counts that are stale by the next commit', () => {
  it('states how to measure the test totals rather than writing them down', () => {
    // docs/README.md said 703 unit and 55 e2e when the suite was at 932 and 63.
    // The structural counts — packages, requirements, scenarios — are gated
    // above and stay; the volatile ones are a command now.
    const readme = readFileSync(path.join(root, 'docs/README.md'), 'utf8')
    expect(readme).not.toMatch(/\d{3,} unit/)
    expect(readme).toContain('pnpm test')
  })
})

describe('the brand pack states facts, and a fact is checkable', () => {
  /**
   * `docs/brand/facts.md` is the source for store copy and interface strings, so
   * a number that goes stale there goes stale on a listing page nobody rereads.
   * Its own closing rule says every number is taken by running a command; this
   * is that command.
   */
  const facts = readFileSync(path.join(root, 'docs/brand/facts.md'), 'utf8')

  it('counts packages and apps as the tree actually has them', () => {
    // `members` and not `readdirSync().length`: the entries of a directory are
    // not its directories, and the difference is a file macOS writes without
    // being asked. A stray `.DS_Store` made this gate read 20 packages and 3
    // apps, so it was red on every machine whose Finder had opened the folder
    // and green on CI, where none had — a verdict about the file manager
    // wearing the authority of a verdict about the tree. `facts.md` documents
    // `ls -d packages/*/ | wc -l`, which counts directories; this now measures
    // the same thing, and the helper is the one lines 62-63 already use for
    // this exact quantity.
    const packages = members('packages').length
    const apps = members('apps').length
    expect(facts).toContain(`| Пакетов | ${packages} |`)
    expect(facts).toContain(`| Приложений | ${apps} |`)
  })

  it('counts e2e spec files rather than remembering them', () => {
    const specs = filesIn(path.join(root, 'e2e'), '.spec.ts').length
    // The number, not the noun after it. Hardcoding `${n} файлов` demanded the
    // genitive plural for every count, so at 22 the gate insisted on "22
    // файлов" — wrong Russian, in the one document whose subject is the
    // product speaking properly. Russian picks файл / файла / файлов by the
    // last digits, and a gate has no business choosing.
    const row = /^\| Спек e2e \| (\d+) фай\S+/m.exec(facts)
    expect(row, 'facts.md has no "Спек e2e" row to check').not.toBeNull()
    expect(Number(row?.[1])).toBe(specs)
  })

  it('leaves the volatile counts to the run that prints them', () => {
    /**
     * Three rows carry a command instead of a number, and this keeps them that
     * way. The unit total went from 1309 to 1577 in eleven days while the
     * document said 1309 — stale, and stale silently, because this gate read
     * six of the table's eleven rows and the six it read were the six that
     * agreed. `docs/README.md` already lives under this rule; the difference
     * was that nobody had extended it to the pack the store copy is written
     * from.
     *
     * Matched per row rather than over the file: a blanket "no numbers in
     * facts.md" would forbid the structural counts this same describe block
     * exists to check.
     */
    const volatile = [
      { label: 'Юнит-тестов', command: 'pnpm test' },
      { label: 'Проверок в Firefox', command: 'pnpm test:e2e:firefox' },
    ]
    for (const { label, command } of volatile) {
      const row = new RegExp(`^\\| ${label} \\|([^|]*)\\|([^|]*)\\|`, 'm').exec(facts)
      expect(row, `facts.md has no "${label}" row`).not.toBeNull()
      expect(row?.[1], `"${label}" states a count; it must name the run instead`).not.toMatch(/\d/)
      expect(row?.[2]).toContain(command)
    }

    // The e2e row is the mixed case and the reason this is not one loop: the
    // file count is structural and gated below, the check count is volatile and
    // moves with every added test. So the row may carry exactly one number.
    const e2e = /^\| Спек e2e \|([^|]*)\|/m.exec(facts)
    expect(e2e?.[1]?.match(/\d+/g) ?? [], 'the e2e row carries more than the file count').toHaveLength(
      1,
    )
  })

  it('counts scenarios and screens as their own documents have them', () => {
    /**
     * Both were understated, not overstated — 26 against 30 and 14 against 18 —
     * which is the direction nobody checks, because a product claiming less than
     * it has reads as modest rather than wrong. Counted from the headings, and
     * the status counted separately: "30, все реализованы" is two claims, and a
     * gate that checks one of them lets the other rot.
     */
    const scenarios = readFileSync(path.join(root, 'docs/ux/scenarios.md'), 'utf8')
    const screens = readFileSync(path.join(root, 'docs/ux/screens.md'), 'utf8')

    const scnTotal = (scenarios.match(/^### SCN-/gm) ?? []).length
    const scnDone = (scenarios.match(/Status:\*\* implemented/g) ?? []).length
    const scrTotal = (screens.match(/^### SCR-/gm) ?? []).length
    const scrDone = (screens.match(/Status:\*\* built/g) ?? []).length

    expect(scnTotal, 'no scenarios found to count').toBeGreaterThan(10)
    expect(scrTotal, 'no screens found to count').toBeGreaterThan(10)

    /**
     * The claim, read rather than assumed.
     *
     * This gate used to require `done === total` outright, because the fact said "all of
     * them". That made the document unable to state anything else: when SCR-10 went to
     * `drifted` on 2026-08-21 — four elements of its own description do not exist — the
     * only way to keep the gate green was to lie about the screen or to leave the fact
     * behind. So both wordings are now checkable, "все" and "построено N", and the
     * numbers are compared either way. A fact that can only say one thing is not being
     * verified; it is being asserted.
     */
    const claim = (label: string, done: number, total: number, all: string, some: string): void => {
      const row = new RegExp(`^\\| ${label} \\| (\\d+), ([^|]+?)\\s*\\|`, 'm').exec(facts)
      expect(row, `facts.md has no countable "${label}" row`).not.toBeNull()
      // The sentence the document ought to carry, computed from the tree — so the
      // comparison is one assertion over a pair rather than a branch with an assertion in
      // each arm, which `tools/test-quality.test.ts` refuses and is right to: a branched
      // assertion is a test that can pass without ever running its check.
      const ought = done === total ? all : `${some} ${done}`
      expect([row?.[1], (row?.[2] ?? '').trim()], `facts.md and the tree disagree about ${label}`).toEqual([
        String(total),
        ought,
      ])
    }
    claim('Сценариев', scnDone, scnTotal, 'все реализованы', 'реализовано')
    claim('Экранов', scrDone, scrTotal, 'все построены', 'построено')
  })

  it('counts requirements, and the one closed by decision, from the brief', () => {
    const brief = readFileSync(
      path.join(root, 'docs/superpowers/briefs/2026-08-04-okolos-p0-p5.md'),
      'utf8',
    )
    const rows = brief.match(/^\| REQ-\d+ \|.*$/gm) ?? []
    const done = rows.filter((row) => row.includes('DONE')).length
    const byDecision = rows.filter((row) => row.includes('ЗАКРЫТО РЕШЕНИЕМ')).length

    expect(rows.length, 'no requirement rows found').toBeGreaterThan(30)
    // Not `done + byDecision === rows.length` as the only check: that holds just
    // as well when a row is silently neither, which is the state this sentence
    // would then be describing wrongly.
    expect(byDecision, 'the sentence names exactly one closed by decision').toBe(1)
    expect(done + byDecision, 'a requirement row is neither DONE nor closed by decision').toBe(
      rows.length,
    )
    expect(facts).toContain(`| Требований закрыто | ${done} из ${rows.length};`)
  })

  it('states the retention the code enforces', () => {
    /**
     * The old version of this check read the journal window out of the schema and
     * required the phrase "дольше 90 дней" in the pack. The phrase was there and
     * the claim behind it was false: three stores were swept out of nine, and
     * `settings` — swept by nothing — had grown a permanent, second-precision list
     * of every host where a password field was focused. A gate can confirm a
     * sentence and still be confirming a lie, when the sentence is about the whole
     * database and the gate reads one constant.
     *
     * So the claim changed shape, and this checks the shape it changed to: every
     * window the code enforces is stated where the user reads it, and the privacy
     * table has a line for each store rather than for the four somebody remembered.
     */
    const schema = readFileSync(path.join(root, 'packages/storage/src/schema.ts'), 'utf8')
    const privacy = readFileSync(path.join(root, 'docs/privacy.md'), 'utf8')

    const windows = [...schema.matchAll(/^\s{2}(?:\/\*\*[\s\S]*?\*\/\s*)?(\w+): (\d+),/gm)].map(
      (m) => Number(m[2]),
    )
    expect(windows.length, 'no retention windows found in the schema').toBeGreaterThan(2)

    // Days, not the constant's name: the pack and the privacy page speak the
    // user's language, and the code's field names are not it.
    for (const days of new Set(windows)) {
      expect(privacy, `no retention line mentions ${days} days`).toMatch(
        new RegExp(`${days}\\s*(дней|дня|день|год)`),
      )
    }

    expect(facts, 'the pack no longer points at where the windows are stated').toContain(
      'docs/privacy.md',
    )
  })

  it('lists every network purpose the audited path can carry, and no others', () => {
    /**
     * Read from the contract, not from a list written here. The first version
     * of this check named the five purposes it expected — and there were six.
     * `password-range`, the one that carries part of a password hash, was
     * absent from the brand pack and invisible to the gate meant to notice.
     * An extraction that names what it looks for cannot see what it was not
     * told about.
     */
    const purposes = PURPOSES
    expect(purposes.length, 'no purposes found — the extraction broke').toBeGreaterThanOrEqual(5)
    for (const purpose of purposes) {
      expect(facts, `purpose ${purpose} is not in the brand pack`).toContain(`\`${purpose}\``)
    }
  })

  it('names the same permissions the manifest requests', () => {
    const manifest = JSON.parse(
      readFileSync(path.join(root, 'apps/extension/manifest.chrome.json'), 'utf8'),
    ) as { permissions: string[] }
    for (const permission of manifest.permissions) {
      expect(facts, `permission ${permission} is not declared in the brand pack`).toContain(
        `\`${permission}\``,
      )
    }
  })
})

describe('the privacy policy describes the code, not an intention', () => {
  /**
   * A policy is the one document a reader has no way to check, so it is the one
   * that must be checked hardest. Chrome Web Store requires it; a person
   * deciding whether to grant access to every site deserves it to be true.
   */
  const policy = readFileSync(path.join(root, 'docs/privacy.md'), 'utf8')

  it('names every purpose the audited path accepts', () => {
    for (const purpose of PURPOSES) {
      expect(policy, `purpose ${purpose} is not in the policy`).toContain(`\`${purpose}\``)
    }
  })

  it('names every host the product is allowed to reach', () => {
    /**
     * From the enforced list, not from a sweep of source literals.
     *
     * This used to scan `https://` literals under `apps/extension/src` and require
     * each to appear in the policy — and there were three ways past it, none
     * exotic: a literal in `packages/` (where the model manager's and the leak
     * lookup's own URLs live), a URL assembled from parts, and anything not
     * spelled `https://`. Now `packages/net/src/destinations.ts` decides at run
     * time who may reach what, so the comparison is between the thing that
     * enforces and the thing that claims.
     */
    const allowed = [...Object.values(DESTINATIONS).flat()]
    expect(allowed.length, 'no destinations found — the import broke').toBeGreaterThan(2)
    for (const host of allowed) {
      expect(policy, `${host} is an allowed destination and absent from the policy`).toContain(host)
    }
  })

  it('finds no reachable host that the enforced list does not know', () => {
    /**
     * The other direction, and now over `packages/` as well — which is where two
     * of the three real hosts were written, in the very directory the old sweep
     * did not read.
     *
     * A literal scan still cannot see a URL built from parts; that case is covered
     * by the run-time check rather than here, and the division is the point. This
     * catches a new endpoint typed into a file; the check in `request` catches one
     * assembled at the moment of sending.
     */
    const hosts = new Set<string>()
    const walk = (dir: string): void => {
      for (const file of filesUnder(dir, '.ts')) {
        if (file.endsWith('.test.ts')) continue
        for (const m of readFileSync(file, 'utf8').matchAll(/https:\/\/([a-z0-9.-]+)/g)) {
          hosts.add(m[1] as string)
        }
      }
    }
    walk(path.join(root, 'apps/extension/src'))
    walk(path.join(root, 'packages'))
    expect(hosts.size, 'no hosts found — the walk broke').toBeGreaterThan(2)

    const allowed = new Set(Object.values(DESTINATIONS).flat())
    const unknown = [...hosts].filter((host) => {
      // Reserved and unreachable by definition, and the documentation's own
      // examples: `.invalid` never resolves, `.test` is what every fixture uses.
      if (host.endsWith('.invalid') || host.endsWith('.test')) return false
      // Addresses that appear as text rather than as destinations: a standard's
      // URL in a docstring, a well-known path a page is sent to.
      if (['www.w3.org', 'developer.mozilla.org', 'github.com', 'tools.ietf.org'].includes(host)) {
        return false
      }
      return !allowed.has(host)
    })
    expect(
      unknown,
      'these appear in the source and are not in the enforced destination list',
    ).toEqual([])
  })

  it('states the retention the schema enforces, for every store that has one', () => {
    const schema = readFileSync(path.join(root, 'packages/storage/src/schema.ts'), 'utf8')
    const block = /RETENTION_DAYS = \{([\s\S]*?)\}/.exec(schema)?.[1] ?? ''
    const days = [...block.matchAll(/(\w+):\s*(\d+)/g)].map((m) => m[2] as string)
    expect(days.length, 'no retention values found — the extraction broke').toBeGreaterThanOrEqual(2)
    for (const value of new Set(days)) {
      expect(policy, `retention of ${value} days is enforced and not stated`).toContain(value)
    }
  })

  it('does not promise anonymity for the check that sends an address whole', () => {
    // A screen in this product once claimed the address was hashed while it was
    // being sent entire. The policy says so plainly, and this keeps it saying so.
    expect(policy).toMatch(/адрес почты отправляется целиком/i)
  })
})

describe('the disclosure policy matches the limits the product records', () => {
  /**
   * A security product's disclosure policy has two ways to fail. It can promise
   * a boundary the code does not hold — which turns a reporter's correct
   * finding into an argument. Or it can declare a limit out of scope that the
   * product never actually recorded, which is how a real defect gets waved off.
   *
   * Both are checked against the scenarios, because that is where the limits
   * are written and where they are kept true.
   */
  const policy = readFileSync(path.join(root, 'SECURITY.md'), 'utf8')
  const scenarios = readFileSync(path.join(root, 'docs/ux/scenarios.md'), 'utf8')

  it('names a private channel and no public one', () => {
    expect(policy).toMatch(/security\/advisories\/new/)
    expect(policy, 'a policy that invites a public issue publishes the defect').toMatch(
      /[Нн]е заводите публичный issue/,
    )
  })

  it('states when a reporter hears back, not when a fix ships', () => {
    // Naming a fix date before the cause is understood is either a lie or a
    // rushed patch. Naming a response time is a promise that can be kept.
    expect(policy).toMatch(/рабочих дн/)
  })

  it('declares out of scope only limits the scenarios actually record', () => {
    // Every "not a vulnerability" must be traceable to a written decision.
    for (const [claim, scenario] of [
      ['fetch', 'SCN-010'],
      ['navigator.webdriver', 'SCN-010'],
      ['два языка', 'SCN-003'],
    ] as const) {
      expect(policy, `${claim} is excluded without citing where it was decided`).toContain(scenario)
    }
    // Inside the scenario's own block rather than within N characters of the
    // words: the limit's text is long, and a distance is a guess about how long
    // it will stay.
    const block = scenarios.split('### SCN-010:')[1]?.split('\n### SCN-')[0] ?? ''
    expect(block, 'SCN-010 is not in the scenarios at all').not.toBe('')
    expect(block, 'SCN-010 no longer records the fetch limit the policy cites').toMatch(/fetch/)
    expect(block, 'SCN-010 no longer records the automation limit').toMatch(/webdriver/i)
  })

  it('points at the privacy policy for what leaves, rather than restating it', () => {
    // Two lists of destinations is two lists that disagree.
    expect(policy).toContain('docs/privacy.md')
  })

  it('promises no bounty it has no money for', () => {
    expect(policy).toMatch(/[Нн]аграды нет/)
  })
})

describe('the changelog says what changed for a person', () => {
  /**
   * A changelog that mirrors the commit log is a second commit log, and the one
   * nobody reads. This one is gated on being about the product: it must not
   * claim a capability the brand pack does not, it must not advertise the stage
   * that was measured and dropped, and — while nothing has shipped — it must say
   * so rather than imply a release.
   */
  const changelog = readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8')

  it('claims exactly the releases the repository has tagged', () => {
    /**
     * Asserted both ways rather than inside a branch: an assertion that only
     * runs when there are no tags stops running the day there are, and the test
     * goes on reporting green. (Caught by tools/test-quality.test.ts, which is
     * the gate for exactly this.)
     */
    const tagged = execFileSync('git', ['tag'], { cwd: root, encoding: 'utf8' }).trim() !== ''
    const claimsVersion = /^## \[?\d+\.\d+\.\d+/m.test(changelog)
    expect(
      claimsVersion,
      tagged
        ? 'the repository has tags and the changelog names no version'
        : 'a version heading claims a release that has not happened',
    ).toBe(tagged)
    expect(changelog.includes('Не выпущено')).toBe(!tagged)
  })

  it('does not advertise the stage that was measured and dropped', () => {
    for (const claim of ['нейросет', 'машинное обучение', 'AI-модель']) {
      expect(changelog.toLowerCase()).not.toContain(claim.toLowerCase())
    }
  })

  it('carries the limits rather than only the features', () => {
    // A list of what a product does, with nothing about what it does not, is
    // marketing wearing a changelog's clothes.
    expect(changelog).toMatch(/[Ии]звестные пределы/)
    expect(changelog).toContain('SECURITY.md')
  })

  it('names the same limits the scenarios record', () => {
    const scenarios = readFileSync(path.join(root, 'docs/ux/scenarios.md'), 'utf8')
    const block = scenarios.split('### SCN-010:')[1]?.split('\n### SCN-')[0] ?? ''
    expect(block, 'SCN-010 is not in the scenarios').not.toBe('')
    // Both must still describe the same boundary; if the scenario stops
    // recording it, this stops being a limit the product can claim to know.
    expect(block).toMatch(/fetch/)
    expect(changelog).toMatch(/fetch/)
  })
})

describe('the version the store will see', () => {
  it('is the manifest one, and both browsers agree on it', () => {
    // The packaging command names the archive from it; two manifests disagreeing
    // would produce two versions of the same release.
    const versions = ['chrome', 'firefox'].map(
      (target) =>
        (
          JSON.parse(
            readFileSync(path.join(root, `apps/extension/manifest.${target}.json`), 'utf8'),
          ) as { version: string }
        ).version,
    )
    expect(new Set(versions).size, `manifests disagree: ${versions.join(' vs ')}`).toBe(1)
    expect(versions[0]).toMatch(/^\d+\.\d+\.\d+$/)
  })
})

describe('the page a stranger reads is prose, not source', () => {
  /**
   * The served privacy policy carried literal `**` for three releases. The
   * generator handled bold correctly and ran line by line, so a phrase opened
   * on one source line and closed on the next matched nothing — and every
   * wrapped line became its own paragraph, which is why the page read as a
   * column of fragments.
   *
   * Neither was visible in the markdown, in the generator, or in the gate that
   * compares the two: all three agreed with each other. It was visible on the
   * deployed page, which is where this is checked from now on.
   */
  const html = readFileSync(path.join(root, 'apps/proxy/src/privacy.generated.ts'), 'utf8')

  it('is generated at all, so an empty file cannot pass as clean markup', () => {
    expect(html.length).toBeGreaterThan(2000)
    expect(html).toContain('<p>')
  })

  it('leaves no Markdown emphasis unrendered', () => {
    expect(html).not.toMatch(/\*\*/)
  })

  it('renders the emphasis rather than dropping it', () => {
    // The mirror of the rule above: stripping every asterisk would satisfy it
    // and lose every emphasis the document places deliberately.
    expect((html.match(/<strong>/g) ?? []).length).toBeGreaterThan(10)
  })

  it('joins wrapped lines, so a paragraph is a paragraph', () => {
    // A source line per paragraph would put the count near the document's line
    // count instead of near its paragraph count.
    const paragraphs = (html.match(/<p>/g) ?? []).length
    const sourceLines = readFileSync(path.join(root, 'docs/privacy.md'), 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '' && !l.startsWith('|') && !l.startsWith('- ') && !l.startsWith('#'))
      .length
    expect(paragraphs).toBeLessThan(sourceLines / 2)
  })
})

/** The form of a Russian noun after a number: one, few, many. */
function russianPlural(n: number, [one, few, many]: [string, string, string]): string {
  const mod100 = n % 100
  if (mod100 >= 11 && mod100 <= 14) return many
  const mod10 = n % 10
  if (mod10 === 1) return one
  if (mod10 >= 2 && mod10 <= 4) return few
  return many
}
