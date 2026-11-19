/**
 * How imports resolve in this repository, in one place.
 *
 * Two gates need to walk the same graph and must agree about what "reachable"
 * means: `reachable.test.ts` asks whether anything ships a file at all, and
 * `entry-resolver.test.ts` asks which entry points reach a localised surface.
 * Two copies of a resolver drift, and the drift is invisible — the second copy
 * simply stops following an import shape the first one learned about, and its
 * gate goes quiet without ever failing.
 *
 * The entry list is deliberately derived from `tools/build.mjs`, the HTML pages
 * that build loads, and `wrangler.toml`. An entry nobody ships is not an entry;
 * otherwise the easiest way to defeat a reachability gate is to declare the
 * orphan an entry point.
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { directoriesIn } from './tree.mjs'

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const app = path.join(root, 'apps/extension')

const buildScript = () => readFileSync(path.join(root, 'tools/build.mjs'), 'utf8')

/**
 * Resolve one specifier. Two forms matter: workspace packages
 * (`@okolos/x`, and subpaths like `@okolos/ui/words`) and relative paths written with
 * the `.js` extension TypeScript's NodeNext resolution requires, which name a `.ts`
 * file on disk.
 *
 * The workspace form reads the package's own `exports` map rather than assuming
 * `src/index.ts`. It assumed it until 2026-08-20, so `@okolos/ui/words` — a second
 * entry point added so the worker could take a lookup table without the whole UI graph —
 * resolved to nothing: the module it named was reported unreachable, and everything that
 * module imports fell out of the graph with it.
 *
 * A workspace specifier that resolves to nothing throws rather than returning `null`.
 * `null` is for an npm dependency, which is genuinely outside this graph; a broken
 * `@okolos/…` is a mistake in this repository, and the silent version of it cost an hour.
 *
 * @param {string} spec
 * @param {string} from
 * @returns {string | null}
 */
export function resolve(spec, from) {
  if (spec.startsWith('@okolos/')) {
    const [pkg, ...rest] = spec.slice('@okolos/'.length).split('/')
    const dir = path.join(root, 'packages', String(pkg))
    const manifest = path.join(dir, 'package.json')
    if (!existsSync(manifest)) return null
    const subpath = rest.length === 0 ? '.' : `./${rest.join('/')}`
    const map = JSON.parse(readFileSync(manifest, 'utf8')).exports ?? { '.': './src/index.ts' }
    const target = typeof map[subpath] === 'string' ? map[subpath] : null
    if (target === null) {
      throw new Error(
        `${path.relative(root, from)} imports "${spec}", which packages/${String(pkg)}/package.json does not export`,
      )
    }
    const file = path.join(dir, target)
    if (!existsSync(file)) {
      throw new Error(`"${spec}" points at ${path.relative(root, file)}, which does not exist`)
    }
    return file
  }
  if (!spec.startsWith('.')) return null // npm or platform dependency

  const raw = path.resolve(path.dirname(from), spec)
  const base = raw.endsWith('.js') ? raw.slice(0, -3) : raw
  for (const candidate of [`${base}.ts`, `${base}.tsx`, raw, path.join(base, 'index.ts')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  return null
}

/**
 * Every specifier a file imports — static and dynamic, values and types.
 *
 * @param {string} file
 * @returns {string[]}
 */
export function specifiers(file) {
  const src = readFileSync(file, 'utf8')
  const out = []
  for (const [, s] of src.matchAll(/from\s*['"]([^'"]+)['"]/g)) if (s !== undefined) out.push(s)
  for (const [, s] of src.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) if (s !== undefined) out.push(s)
  for (const [, s] of src.matchAll(/(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g)) if (s !== undefined) out.push(s)
  return out
}

/**
 * Every file reachable from these entries, the entries included.
 *
 * @param {readonly string[]} entries
 * @returns {Set<string>}
 */
export function reachableFrom(entries) {
  const seen = new Set()
  const stack = [...entries]
  while (stack.length > 0) {
    const file = stack.pop()
    if (file === undefined || seen.has(file) || !existsSync(file)) continue
    seen.add(file)
    for (const spec of specifiers(file)) {
      const target = resolve(spec, file)
      if (target !== null && !seen.has(target)) stack.push(target)
    }
  }
  return seen
}

/** Rollup inputs named in build.mjs — `path.join(app, 'src/…/index.ts')`. */
export function tsEntriesFromBuild() {
  return [...buildScript().matchAll(/path\.join\(app,\s*'([^']+\.ts)'\)/g)].map((m) =>
    path.join(app, m[1] ?? ''),
  )
}

/** HTML pages named in build.mjs, and the module each one loads. */
export function pageEntriesFromBuild() {
  const out = []
  for (const [, p] of buildScript().matchAll(/path\.join\(app,\s*'([^']+\.html)'\)/g)) {
    const html = path.join(app, p ?? '')
    if (!existsSync(html)) continue
    const markup = readFileSync(html, 'utf8')
    for (const [, src] of markup.matchAll(/<script[^>]*\bsrc=["']([^"']+)["']/g)) {
      if (src === undefined) continue
      const resolved = resolve(src.startsWith('.') ? src : `./${src.replace(/^\//, '')}`, html)
      if (resolved) out.push(resolved)
    }
  }
  return out
}

/** The worker entry, as wrangler will load it. */
export function workerEntryFromWrangler() {
  const toml = readFileSync(path.join(root, 'apps/proxy/wrangler.toml'), 'utf8')
  const main = /^\s*main\s*=\s*"([^"]+)"/m.exec(toml)
  return main?.[1] !== undefined ? [path.join(root, 'apps/proxy', main[1])] : []
}

/**
 * Commands an app declares as `bin`, as the package manager will install them.
 *
 * Derived from what actually ships rather than listed by hand, for the same
 * reason the other three are: a hardcoded entry list is a second copy of the
 * build, and the copy is the one that goes stale. Added with `apps/mail-cli`
 * on 2026-09-11 — until then every file of a command-line app read as
 * unreachable, which is true of the build and false of the product.
 */
export function binEntriesFromPackages() {
  const out = []
  for (const dir of directoriesIn(path.join(root, 'apps'))) {
    const manifest = path.join(root, 'apps', dir, 'package.json')
    if (!existsSync(manifest)) continue
    const bin = JSON.parse(readFileSync(manifest, 'utf8')).bin
    for (const target of Object.values(bin ?? {})) {
      const file = path.join(root, 'apps', dir, target)
      if (existsSync(file)) out.push(file)
    }
  }
  return out
}

/**
 * The entries Okolos Agent's build bundles (`tools/build-agent.mjs`: the daemon;
 * `tools/build-agent-probe.mjs`: the probe it evaluates in the agent's page), named
 * there as `path.join(root, 'apps/….ts')`, read the same way as build.mjs.
 */
export function agentEntriesFromBuild() {
  const out = []
  for (const script of ['build-agent.mjs', 'build-agent-probe.mjs']) {
    const file = path.join(root, 'tools', script)
    if (!existsSync(file)) continue
    for (const [, entry] of readFileSync(file, 'utf8').matchAll(/path\.join\(root,\s*'(apps\/[^']+\.ts)'\)/g)) {
      out.push(path.join(root, entry ?? ''))
    }
  }
  return out
}

/** Every entry point the build actually ships. */
export function entryPoints() {
  return [
    ...tsEntriesFromBuild(),
    ...agentEntriesFromBuild(),
    ...pageEntriesFromBuild(),
    ...workerEntryFromWrangler(),
    ...binEntriesFromPackages(),
  ]
}
