import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

import { ACTIONS_EXTENSION_KEY } from '../fabric/fabric-service.mjs'
import { buildIdentity, gitEnv, wellKnown } from './wellknown.js'

/** apps/agent in this checkout. */
const AGENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

const temps: string[] = []
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function temp(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix))
  temps.push(dir)
  return dir
}

describe('which build is answering', () => {
  it('names the git commit when the code runs from this repository’s checkout', () => {
    const build = buildIdentity(AGENT_ROOT)
    expect(build.commit).toMatch(/^[0-9a-f]{40}$/)
    expect(build.digest).toBeUndefined()
  })

  it('names a digest of its code when the code is not a git checkout (a release folder)', () => {
    const release = temp('okolos-agent-release-')
    writeFileSync(path.join(release, 'http.js'), 'one')
    mkdirSync(path.join(release, 'fabric'))
    writeFileSync(path.join(release, 'fabric', 'kit.mjs'), 'kit')
    const first = buildIdentity(release)
    expect(first.commit).toBeUndefined()
    expect(first.digest).toMatch(/^sha256:[0-9a-f]{64}$/)

    // Any file under the root counts, a sub-folder's included.
    writeFileSync(path.join(release, 'fabric', 'kit.mjs'), 'kit, changed')
    expect(buildIdentity(release).digest).not.toBe(first.digest)
  })

  it('names a digest, not the commit, when the code sits in someone else’s git checkout', () => {
    // A release under a home that is itself a repository (dotfiles) must not report that repository's commit.
    const release = dotfilesRelease()
    const build = buildIdentity(release)
    expect(build.commit).toBeUndefined()
    expect(build.digest).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('cannot reach another repository through a GIT_DIR inherited from a git hook', () => {
    // The pre-push hook runs these tests with GIT_DIR naming this repository. A git command that
    // inherits it acts on that repository whatever `-C` says: on 2026-10-27 the dotfiles case
    // above committed its one file into this checkout's branch. A sacrificial repository stands
    // in for this one here, so a regression costs nothing but a red test.
    const victim = temp('okolos-agent-victim-')
    runGit(victim, 'init', '-q')
    writeFileSync(path.join(victim, 'kept'), 'kept')
    runGit(victim, 'add', '-A')
    runGit(victim, 'commit', '-q', '-m', 'the only commit')

    const saved = process.env.GIT_DIR
    process.env.GIT_DIR = path.join(victim, '.git')
    let build
    try {
      build = buildIdentity(dotfilesRelease())
    } finally {
      if (saved === undefined) delete process.env.GIT_DIR
      else process.env.GIT_DIR = saved
    }

    const log = execFileSync('git', ['-C', victim, 'log', '--format=%s'], { encoding: 'utf8', env: gitEnv() }).trim()
    expect(log).toBe('the only commit')
    expect(build.commit).toBeUndefined()
    expect(build.digest).toMatch(/^sha256:[0-9a-f]{64}$/)
  })
})

/** git in `dir`, never in a repository a parent process named through GIT_DIR and friends. */
function runGit(dir: string, ...args: string[]): void {
  execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], {
    stdio: 'ignore',
    env: gitEnv(),
  })
}

/** A release folder inside a home that is itself a git repository with one commit. */
function dotfilesRelease(): string {
  const home = temp('okolos-agent-dotfiles-')
  runGit(home, 'init', '-q')
  // Not under `releases/`, so only the foreign checkout tells it apart.
  const release = path.join(home, '.local', 'share', 'okolos-agent', 'current')
  mkdirSync(release, { recursive: true })
  writeFileSync(path.join(release, 'http.js'), 'one')
  runGit(home, 'add', '-A')
  runGit(home, 'commit', '-q', '-m', 'dotfiles')
  return release
}

describe('the well-known document', () => {
  const base = {
    version: '1.2.3',
    build: { commit: 'a'.repeat(40) },
    startedAt: '2026-10-27T05:00:00Z',
    pid: 4242,
    status: 'ready' as const,
    degraded: [],
    served: [] as string[],
  }

  it('says who it is: okolos-agent.default, the version it was given, its build, its process', () => {
    const doc = wellKnown(base)
    expect(doc.protocol).toBe('fabric-service/0.1')
    expect(doc.service.id).toBe('okolos-agent')
    expect(doc.service.instance).toBe('default')
    expect(doc.service.name).toBe('Okolos Agent')
    expect(doc.service.version).toBe('1.2.3')
    expect(doc.service.build.commit).toBe('a'.repeat(40))
    expect(doc.process).toEqual({ pid: 4242, startedAt: '2026-10-27T05:00:00Z' })
  })

  it('always carries degraded, and ready with a degraded source is degraded', () => {
    const doc = wellKnown(base)
    expect(doc.degraded).toEqual([])
    expect(doc.status).toBe('ready')
    const hurt = wellKnown({ ...base, degraded: [{ source: 'browser', reason: 'Chrome is not installed.' }] })
    expect(hurt.status).toBe('degraded')
    expect(hurt.degraded).toEqual([{ source: 'browser', reason: 'Chrome is not installed.' }])
  })

  it('declares only events while no route serves /mcp or /dashboard', () => {
    const doc = wellKnown(base)
    expect(doc.surfaces).toEqual({ events: { path: '/fabric/v1/events' } })
  })

  it('declares the dashboard behind a login and the MCP door with its own keys once routes serve them', () => {
    const doc = wellKnown({ ...base, served: ['/mcp', '/pair', '/dashboard'] })
    expect(doc.surfaces.dashboard).toEqual({ path: '/dashboard', login: true })
    expect(doc.surfaces.mcp).toEqual({ path: '/mcp', transport: 'streamable-http', auth: 'own' })
    expect(wellKnown({ ...base, served: ['/mcp'] }).surfaces.dashboard).toBeUndefined()
  })

  it('carries the extensions and the action table it is given', () => {
    const doc = wellKnown({
      ...base,
      served: ['/mcp', '/dashboard'],
      extensions: { 'https://example.test/extensions/probe/0.1': { probe: true } },
      actions: [{ id: 'agent.revoke', title: 'Revoke access', tool: 'agent.revoke', gate: 'relayed' }],
    })
    expect(doc.extensions?.['https://example.test/extensions/probe/0.1']).toEqual({ probe: true })
    expect(doc.extensions?.[ACTIONS_EXTENSION_KEY]).toMatchObject({
      actions: [{ id: 'agent.revoke', tool: 'agent.revoke', gate: 'relayed' }],
    })
  })
})
