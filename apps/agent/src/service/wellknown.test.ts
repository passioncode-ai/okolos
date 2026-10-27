import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { buildIdentity, wellKnown } from './wellknown.js'

const temps: string[] = []
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('which build is answering', () => {
  it('names the git commit of the code it runs from', () => {
    const build = buildIdentity()
    expect(build.commit).toMatch(/^[0-9a-f]{40}$/)
  })

  it('names a digest of its code when the code is not a git checkout (a release folder)', () => {
    const release = mkdtempSync(path.join(os.tmpdir(), 'okolos-agent-release-'))
    temps.push(release)
    writeFileSync(path.join(release, 'http.js'), 'one')
    const first = buildIdentity(release)
    expect(first.commit).toBeUndefined()
    expect(first.digest).toMatch(/^sha256:[0-9a-f]{64}$/)

    writeFileSync(path.join(release, 'http.js'), 'two')
    expect(buildIdentity(release).digest).not.toBe(first.digest)
  })
})

describe('the well-known document', () => {
  const doc = wellKnown({
    build: { commit: 'a'.repeat(40) },
    startedAt: '2026-10-27T05:00:00Z',
    pid: 4242,
    status: 'ready',
    degraded: [],
  })

  it('says who it is: okolos-agent.default, its build, its process', () => {
    expect(doc.protocol).toBe('fabric-service/0.1')
    expect(doc.service.id).toBe('okolos-agent')
    expect(doc.service.instance).toBe('default')
    expect(doc.service.name).toBe('Okolos Agent')
    expect(doc.service.version).toBe('0.0.0')
    expect(doc.service.build.commit).toBe('a'.repeat(40))
    expect(doc.process).toEqual({ pid: 4242, startedAt: '2026-10-27T05:00:00Z' })
  })

  it('always carries degraded, and ready with a degraded source is degraded', () => {
    expect(doc.degraded).toEqual([])
    expect(doc.status).toBe('ready')
    const hurt = wellKnown({
      build: { commit: 'a'.repeat(40) },
      startedAt: '2026-10-27T05:00:00Z',
      pid: 1,
      status: 'ready',
      degraded: [{ source: 'browser', reason: 'Chrome is not installed.' }],
    })
    expect(hurt.status).toBe('degraded')
  })

  it('declares events, the dashboard behind a login, and an MCP door with its own keys', () => {
    expect(doc.surfaces.events).toEqual({ path: '/fabric/v1/events' })
    expect(doc.surfaces.dashboard).toEqual({ path: '/dashboard', login: true })
    expect(doc.surfaces.mcp).toEqual({ path: '/mcp', transport: 'streamable-http', auth: 'own' })
  })
})
