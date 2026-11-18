/**
 * The LC-15 cleanup command must leave a tree the gates can rebuild (B-196).
 *
 * AGENTS.md tells an agent that passed the 500 MB cap to run one `rm -rf`
 * line and promises that `pnpm gates` restores what a gate needs. `tsc -b`
 * (in `pnpm typecheck`) decides from each project's `tsconfig.tsbuildinfo`
 * whether it is up to date, not from its output folder. On 2026-11-04 the
 * command removed `packages/*\/dist` and left the build info beside it, so
 * `tsc -b` emitted nothing, `tools/gates/bundle-scan.test.ts` read no core-*
 * bundle and the pre-push hook refused.
 *
 * So: every project `tsc -b` builds (the root `tsconfig.json` references)
 * whose output folder the command removes must lose its build info in the
 * same command.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** tsconfig files carry comments; drop them before JSON.parse. */
function readJsonc(file: string): unknown {
  const text = readFileSync(file, 'utf8')
  return JSON.parse(text.replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_m, str) => str ?? ''))
}

/** The one `rm -rf …` line the "Build retention (LC-15)" paragraph prints. */
function cleanupTargets(): string[] {
  const agents = readFileSync(path.join(root, 'AGENTS.md'), 'utf8')
  const section = agents.slice(agents.indexOf('**Build retention (LC-15).**'))
  const line = section.match(/`rm -rf ([^`]+)`/)?.[1]
  if (!line) throw new Error('AGENTS.md: no `rm -rf` line in the LC-15 paragraph')
  return line.trim().split(/\s+/)
}

/** A shell glob as the command uses it: `*` within one path segment. */
function globToRegExp(glob: string): RegExp {
  const body = glob
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]*')
  return new RegExp(`^${body}$`)
}

function removedBy(targets: string[], relative: string): boolean {
  return targets.some((t) => globToRegExp(t).test(relative))
}

interface Project {
  dir: string
  outDir: string
}

function builtProjects(): Project[] {
  const refs = (readJsonc(path.join(root, 'tsconfig.json')) as { references: { path: string }[] }).references
  return refs.map(({ path: dir }) => {
    const config = readJsonc(path.join(root, dir, 'tsconfig.json')) as {
      compilerOptions?: { outDir?: string }
    }
    const outDir = config.compilerOptions?.outDir
    if (!outDir) throw new Error(`${dir}/tsconfig.json: a referenced project without outDir`)
    return { dir, outDir: path.posix.join(dir, outDir) }
  })
}

describe('the LC-15 cleanup command (AGENTS.md)', () => {
  const targets = cleanupTargets()

  it('removes the build output it names, not the release archives or node_modules', () => {
    expect(removedBy(targets, 'packages/core-injection/dist')).toBe(true)
    expect(removedBy(targets, 'apps/extension/.tsc')).toBe(true)
    expect(removedBy(targets, 'apps/extension/dist/release')).toBe(false)
    expect(targets.some((t) => t === 'node_modules' || t.endsWith('/node_modules'))).toBe(false)
  })

  it.each(builtProjects())('a removed outDir takes its tsconfig.tsbuildinfo with it: $dir', ({ dir, outDir }) => {
    if (!removedBy(targets, outDir)) return
    expect(removedBy(targets, `${dir}/tsconfig.tsbuildinfo`)).toBe(true)
  })
})
