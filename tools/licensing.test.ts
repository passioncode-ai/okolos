import { readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { directoriesIn, filesUnder } from './tree.mjs'

/**
 * REQ-30 — the licence and the attributions this project owes.
 *
 * HIBP breach data is CC BY 4.0 and requires visible attribution wherever it
 * appears — which, now that the leak and password features ship, means on the
 * screens that show it and not only in a README. This file asserts both, and
 * the second assertion is the one that would actually be missed: a README line
 * survives every refactor, and a line of UI copy does not.
 */

const root = process.cwd()
const read = (p: string): string => readFileSync(path.join(root, p), 'utf8')

/**
 * ADR-0015 — the organisation's licence, the same as every public PassionCode.ai
 * tool: free for people and for a company's internal use, commercial use by a
 * separate licence. It replaced the AGPL/Apache split of ADR-0014 the same day.
 */
const EXPRESSION = 'PolyForm-Noncommercial-1.0.0 OR LicenseRef-PolyForm-Internal-Use-1.0.0'
/** The one file in the tree that keeps its source's licence (Public Suffix List). */
const MANIFEST_LICENCE: Record<string, string> = {
  'packages/core-lookalike': `(${EXPRESSION}) AND MPL-2.0`,
}

describe('licence', () => {
  it("ships the organisation's licence: both PolyForm texts, the address, the history", () => {
    const text = read('LICENSE')
    expect(text).toContain('# PolyForm Noncommercial License 1.0.0')
    expect(text).toContain('# PolyForm Internal Use License 1.0.0')
    expect(text).toContain('This software is source-available, not open source.')
    expect(text).toContain('contact@passioncode.ai')
    expect(text).toContain('Required Notice: Copyright (c) 2026 Siarhei Sheleh (https://passioncode.ai)')
    // A relicence does not reach back: what was published under AGPL stays AGPL.
    expect(text).toMatch(/up to and including 5a8e490[\s\S]{0,200}AGPL-3\.0-only/)
    expect(text).not.toContain('GNU AFFERO GENERAL PUBLIC LICENSE')
  })

  it('declares the expression in every manifest', () => {
    const manifests = [
      '.',
      ...directoriesIn(path.join(root, 'packages')).map((d) => `packages/${d}`),
      ...directoriesIn(path.join(root, 'apps')).map((d) => `apps/${d}`),
    ]
    expect(manifests.length).toBeGreaterThan(20)
    for (const dir of manifests) {
      const { license } = JSON.parse(read(`${dir}/package.json`)) as { license: string }
      expect(license, `${dir}/package.json`).toBe(MANIFEST_LICENCE[dir] ?? EXPRESSION)
    }
  })

  it('names the MPL file that keeps its own licence', () => {
    expect(existsSync(path.join(root, 'packages/core-lookalike/src/suffixes.json'))).toBe(true)
    expect(read('packages/core-lookalike/NOTICE')).toMatch(/suffixes\.json[\s\S]*MPL-2\.0/)
  })

  it('publishes the map, the CLA and the decision', () => {
    expect(read('LICENSING.md')).toContain(EXPRESSION)
    expect(read('LICENSING.md')).toContain('docs/adr/0015-okolos-takes-the-organisations-licence.md')
    expect(existsSync(path.join(root, 'docs/adr/0015-okolos-takes-the-organisations-licence.md'))).toBe(true)
    expect(read('CLA.md').startsWith('# Contributor License Agreement\n')).toBe(true)
    expect(read('README.md')).toMatch(/PolyForm Noncommercial or Internal Use[\s\S]{0,400}contact@passioncode\.ai/)
  })

  /**
   * The organisation's rule (org-index RULES §9): never call these tools open
   * source. One stale "Source is open under AGPL-3.0" in the store listing is a
   * public claim about terms the product no longer has.
   */
  it('never calls itself open source, AGPL or Apache in what a user or a store reads', () => {
    const surfaces = [
      'README.md',
      'SECURITY.md',
      'AGENTS.md',
      'docs/store/listing.md',
      'docs/brand/facts.md',
      'apps/proxy/src/router.ts',
      ...directoriesIn(path.join(root, 'apps/extension/_locales')).map(
        (l) => `apps/extension/_locales/${l}/messages.json`,
      ),
    ]
    // The history sentence is true and required: it names the old terms of old commits.
    const withoutHistory = (text: string): string =>
      text.replace(/Commits up to and including `?5a8e490[\s\S]*?remain available under those licen[cs]es\./g, '')
    expect(withoutHistory(read('README.md'))).not.toContain('5a8e490')
    // The negation stays allowed; the claim does not.
    expect('This software is source-available, not open source.').not.toMatch(/(?<!(?:not|call it)\s+)\bopen[ -]source\b/i)
    expect('Okolos is open source.').toMatch(/(?<!(?:not|call it)\s+)\bopen[ -]source\b/i)
    for (const file of surfaces) {
      const text = withoutHistory(read(file))
      expect(text, `${file} calls Okolos open source`).not.toMatch(/(?<!(?:not|call it)\s+)\bopen[ -]source\b|опенсорс/i)
      expect(text, `${file} names the AGPL as current terms`).not.toMatch(/(?:under|под) AGPL|AGPL-3\.0-only"/i)
      expect(text, `${file} names Apache as current terms`).not.toMatch(/(?:under|под) Apache/i)
    }
  })
})

describe('attribution owed to data sources', () => {
  it('names Have I Been Pwned and its CC BY 4.0 terms', () => {
    const readme = read('README.md')
    expect(readme).toContain('Have I Been Pwned')
    expect(readme).toContain('CC BY 4.0')
  })

  /**
   * The credit lives in the shipped catalogue now, not in the renderer.
   *
   * That moved it out of reach of a `grep` over the source — and a licence
   * obligation does not depend on which language the reader chose, so this
   * checks **every** locale rather than the default one.
   */
  const catalogues = directoriesIn(path.join(root, 'apps/extension/_locales')).map(
    (locale) =>
      [locale, JSON.parse(read(`apps/extension/_locales/${locale}/messages.json`))] as const,
  ) as ReadonlyArray<readonly [string, Record<string, { message: string }>]>

  /**
   * Per key, not per file.
   *
   * The first version read each catalogue as text and asked whether "CC BY 4.0"
   * appeared anywhere in it. It does — twice, for two different surfaces — so
   * deleting the credit from the leaks panel left the check green. Planting the
   * defect is what showed it; a file-wide `toContain` is a coverage claim that
   * one occurrence can satisfy.
   */
  const message = (
    catalogue: Record<string, { message: string }>,
    key: string,
  ): string => catalogue[key]?.message ?? ''

  it('reads more than one locale, or the sweep proves nothing', () => {
    expect(catalogues.length).toBeGreaterThanOrEqual(2)
  })

  it('puts the credit on the surface that shows the data, not only in the README', () => {
    for (const [locale, catalogue] of catalogues) {
      const credit = message(catalogue, 'leaksAttribution')
      expect(credit, `${locale} does not credit HIBP on the leaks panel`).toContain(
        'Have I Been Pwned',
      )
      expect(credit, `${locale} omits the CC BY 4.0 terms on the leaks panel`).toContain(
        'CC BY 4.0',
      )
    }
  })

  it('credits the range query on the banner it produces', () => {
    for (const [locale, catalogue] of catalogues) {
      expect(
        message(catalogue, 'warnPasswordSourceOnline'),
        `${locale} does not credit the range query`,
      ).toMatch(/Have I Been Pwned \(CC BY 4\.0\)/)
    }
  })

  it('names the URL intelligence feeds it will consume', () => {
    const readme = read('README.md')
    for (const source of ['OpenPhish', 'PhishTank', 'URLhaus', 'Hudson Rock']) {
      expect(readme).toContain(source)
    }
  })
})

describe('the licences of what this project consumes', () => {
  /**
   * The gate above proves this project publishes its own terms. It says
   * nothing about what it links against — and AGPL-3.0 is the licence where
   * that gap matters most: one dependency under an incompatible licence makes
   * the combined work undistributable, and nothing in the build would say so.
   *
   * Scope is what ships. `devDependencies` stay out: they build the extension
   * and never enter it.
   */
  const COMPATIBLE = new Set([
    'MIT',
    'ISC',
    'BSD-2-Clause',
    'BSD-3-Clause',
    'Apache-2.0',
    '0BSD',
    'CC0-1.0',
    'Unlicense',
  ])

  /** Every non-workspace production dependency, with the manifest that asks for it. */
  const shipped = (): Array<{ name: string; from: string }> => {
    const manifests = [
      'package.json',
      // `directoriesIn`, because `readdirSync` returns entries and this gate used each
      // one as a path segment — the class `tree.mjs` exists for (B-26, B-58).
      ...directoriesIn(path.join(root, 'packages')).map((d) => `packages/${d}/package.json`),
      ...directoriesIn(path.join(root, 'apps')).map((d) => `apps/${d}/package.json`),
    ].filter((p) => existsSync(path.join(root, p)))

    return manifests.flatMap((from) => {
      const deps = (JSON.parse(read(from)) as { dependencies?: Record<string, string> })
        .dependencies
      return Object.entries(deps ?? {})
        .filter(([, range]) => !range.startsWith('workspace:'))
        .map(([name]) => ({ name, from }))
    })
  }

  it('reads at least one dependency, so an empty list cannot pass as a clean sweep', () => {
    expect(shipped().length).toBeGreaterThan(0)
  })

  it('every shipped dependency carries a permissive licence', () => {
    for (const { name, from } of shipped()) {
      const manifest = createRequire(import.meta.url).resolve(`${name}/package.json`, {
        paths: [path.dirname(path.join(root, from))],
      })
      const { license } = JSON.parse(readFileSync(manifest, 'utf8')) as { license?: string }
      expect(license, `${name} (from ${from}) declares no licence at all`).toBeTruthy()
      expect(
        COMPATIBLE.has(license as string),
        `${name} (from ${from}) is ${license}: a copyleft dependency would make PolyForm terms undistributable`,
      ).toBe(true)
    }
  })

  it('refuses model weights that ship without a recorded licence', () => {
    // The one licence question this project has left open (ledger #22) is which
    // classifier weights it may carry. Until it is answered the runtime points
    // at a placeholder URL; the moment a real weight file appears in the tree,
    // this turns red unless docs/licences.md records its terms.
    const weights = ['packages', 'apps']
      .flatMap((dir) => walk(path.join(root, dir)))
      .filter((file) => /\.(onnx|bin|safetensors|gguf)$/.test(file))
      .filter((file) => !file.includes('node_modules') && !file.includes('/dist/'))

    for (const file of weights) {
      const rel = path.relative(root, file)
      expect(
        existsSync(path.join(root, 'docs/licences.md')) &&
          read('docs/licences.md').includes(path.basename(file)),
        `${rel} ships without an entry in docs/licences.md naming its terms`,
      ).toBe(true)
    }
  })
})

/**
 * Files under a directory, recursively.
 *
 * `dist` is kept deliberately — this gate reads what ships, and the built output is
 * exactly what ships — so the skip list is narrowed to `node_modules` rather than
 * taken from the default (B-58).
 */
function walk(dir: string): string[] {
  if (!existsSync(dir)) return []
  return filesUnder(dir, '', { skip: ['node_modules'] })
}

describe('the weights policy is written down and still true', () => {
  const doc = path.join(root, 'docs/licences.md')

  it('exists — the gate above points at it', () => {
    // The weights rule fails a build by naming this file. A rule that names a
    // document nobody wrote is a rule that reports a missing document instead
    // of a missing licence.
    expect(existsSync(doc)).toBe(true)
  })

  it('states the rule rather than a preference', () => {
    const text = read('docs/licences.md')
    expect(text).toMatch(/PolyForm/)
    expect(text).toContain('Apache-2.0')
    // The exclusion is the operative half: it is what a future contributor
    // would otherwise re-litigate.
    expect(text).toMatch(/Llama/)
  })

  it('carries the measurement it rests on, not a recollection of it', () => {
    // 738,563,308 bytes and an HTTP 401 are why the decision went this way.
    // Without them the document is an opinion.
    const text = read('docs/licences.md')
    expect(text).toContain('738 563 308')
    expect(text).toMatch(/401/)
  })

  it('agrees with the descriptor the code actually carries', () => {
    // The model descriptor and this document drifting apart is how a project
    // ends up shipping weights its own policy forbids.
    const runtime = read('packages/model/src/runtime.ts')
    expect(runtime).not.toContain('pending-licence-decision')
    expect(runtime).toMatch(/licences\.md/)
  })
})

