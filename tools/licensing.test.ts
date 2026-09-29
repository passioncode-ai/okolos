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

describe('licence', () => {
  it('ships the AGPL text, not just the name', () => {
    expect(existsSync(path.join(root, 'LICENSE'))).toBe(true)
    expect(read('LICENSE')).toContain('GNU AFFERO GENERAL PUBLIC LICENSE')
  })

  it('declares the same licence in the manifest of the workspace', () => {
    const pkg = JSON.parse(read('package.json')) as { license: string }
    expect(pkg.license).toBe('AGPL-3.0-only')
  })

  it('covers the worker too — a hosted fork must publish its source', () => {
    expect(read('README.md')).toMatch(/AGPL-3\.0[\s\S]{0,200}Worker/i)
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
    'AGPL-3.0-only',
    'AGPL-3.0-or-later',
    'GPL-3.0-only',
    'GPL-3.0-or-later',
    'LGPL-3.0-only',
    'LGPL-3.0-or-later',
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

  it('every shipped dependency carries a licence compatible with AGPL-3.0', () => {
    for (const { name, from } of shipped()) {
      const manifest = createRequire(import.meta.url).resolve(`${name}/package.json`, {
        paths: [path.dirname(path.join(root, from))],
      })
      const { license } = JSON.parse(readFileSync(manifest, 'utf8')) as { license?: string }
      expect(license, `${name} (from ${from}) declares no licence at all`).toBeTruthy()
      expect(
        COMPATIBLE.has(license as string),
        `${name} (from ${from}) is ${license}, which is not on the AGPL-compatible list`,
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
    expect(text).toMatch(/AGPL-3\.0/)
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

/**
 * ADR-0014 — the engine is permissive, the product is copyleft.
 *
 * `packages/contracts` and every `packages/core-*` are Apache-2.0 so they can be
 * embedded where AGPL cannot go: a mail client's Worker, someone else's agent.
 * Everything else stays AGPL-3.0-only. The split is only real while the engine
 * never reaches into the product — one import of `@okolos/ui` from a core
 * package and the "Apache" label on it becomes a lie nobody would notice.
 */
const ENGINE_LICENCE: Record<string, string> = { 'core-lookalike': 'Apache-2.0 AND MPL-2.0' }
const packages = directoriesIn(path.join(root, 'packages'))
const engine = packages.filter((name) => name === 'contracts' || name.startsWith('core-'))
const product = packages.filter((name) => !engine.includes(name))
const licenceOf = (dir: string): string =>
  (JSON.parse(read(`${dir}/package.json`)) as { license: string }).license

/** Every `@okolos/<name>` and every relative specifier a source file imports. */
export function importsOf(source: string): string[] {
  const found: string[] = []
  const pattern = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g
  for (const match of source.matchAll(pattern)) found.push(match[1] as string)
  return found
}

/** Why an engine file's import is refused, or null when it is allowed. */
export function refusal(file: string, specifier: string, packageDir: string): string | null {
  const scoped = /^@okolos\/([a-z0-9-]+)/.exec(specifier)
  if (scoped) {
    const target = scoped[1] as string
    return engine.includes(target) ? null : `imports @okolos/${target}, which is AGPL`
  }
  if (specifier.startsWith('.')) {
    const resolved = path.resolve(path.dirname(file), specifier)
    // The corpora are Apache-2.0 too: the engine's tests measure against them.
    if (resolved.startsWith(path.join(root, 'corpora') + path.sep)) return null
    return resolved.startsWith(packageDir + path.sep) ? null : `reaches outside its package: ${specifier}`
  }
  return null
}

describe('the licence map (ADR-0014)', () => {
  it('finds an engine and a product, or the map proves nothing', () => {
    expect(engine).toContain('core-injection')
    expect(engine).toContain('contracts')
    expect(product).toContain('ui')
  })

  it('declares Apache-2.0 on every engine package, with its text and its NOTICE', () => {
    for (const name of engine) {
      const dir = `packages/${name}`
      expect(licenceOf(dir), `${dir}/package.json`).toBe(ENGINE_LICENCE[name] ?? 'Apache-2.0')
      expect(read(`${dir}/LICENSE`), `${dir}/LICENSE`).toContain('Apache License')
      expect(read(`${dir}/LICENSE`), `${dir}/LICENSE`).toContain('Version 2.0, January 2004')
      expect(read(`${dir}/NOTICE`), `${dir}/NOTICE`).toContain('Copyright 2026 Siarhei Sheleh')
    }
  })

  it('names the MPL file that keeps its own licence inside the engine', () => {
    expect(existsSync(path.join(root, 'packages/core-lookalike/src/suffixes.json'))).toBe(true)
    expect(read('packages/core-lookalike/NOTICE')).toMatch(/suffixes\.json[\s\S]*MPL-2\.0/)
  })

  it('keeps every product package and every app on AGPL-3.0-only', () => {
    for (const name of product) expect(licenceOf(`packages/${name}`), name).toBe('AGPL-3.0-only')
    for (const name of directoriesIn(path.join(root, 'apps'))) {
      expect(licenceOf(`apps/${name}`), `apps/${name}`).toBe('AGPL-3.0-only')
    }
  })

  it('lets an engine package depend only on the engine', () => {
    for (const name of engine) {
      const manifest = JSON.parse(read(`packages/${name}/package.json`)) as {
        dependencies?: Record<string, string>
        peerDependencies?: Record<string, string>
      }
      const outside = Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies })
        .filter((dep) => dep.startsWith('@okolos/'))
        .filter((dep) => !engine.includes(dep.slice('@okolos/'.length)))
      expect(outside, `${name} depends on the product`).toEqual([])
    }
  })

  it('refuses a planted import, so the sweep below can fail', () => {
    const dir = path.join(root, 'packages/core-injection')
    const file = path.join(dir, 'src/planted.ts')
    expect(importsOf(`import { x } from '@okolos/ui'\nconst y = await import("./z")`)).toEqual([
      '@okolos/ui',
      './z',
    ])
    expect(refusal(file, '@okolos/ui', dir)).toMatch(/AGPL/)
    expect(refusal(file, '../../ui/src/index', dir)).toMatch(/outside/)
    expect(refusal(file, '@okolos/contracts', dir)).toBeNull()
    expect(refusal(file, './signals', dir)).toBeNull()
    expect(refusal(file, '../../../corpora/injections/positives.json', dir)).toBeNull()
  })

  it('imports nothing from the product in any engine source file', () => {
    let read_ = 0
    for (const name of engine) {
      const dir = path.join(root, 'packages', name)
      for (const file of filesUnder(dir, '.ts')) {
        read_ += 1
        for (const specifier of importsOf(readFileSync(file, 'utf8'))) {
          const why = refusal(file, specifier, dir)
          expect(why, `${path.relative(root, file)} ${why}`).toBeNull()
        }
      }
    }
    expect(read_, 'no engine source was read').toBeGreaterThan(20)
  })

  it('puts the corpora under the engine licence, and publishes the map', () => {
    expect(read('corpora/LICENSE')).toContain('Apache License')
    const map = read('LICENSING.md')
    expect(map).toContain('docs/adr/0014-the-engine-is-permissive-the-product-is-copyleft.md')
    expect(existsSync(path.join(root, 'docs/adr/0014-the-engine-is-permissive-the-product-is-copyleft.md'))).toBe(true)
    expect(existsSync(path.join(root, 'CLA.md'))).toBe(true)
  })
})
