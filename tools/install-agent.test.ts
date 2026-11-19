import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { serviceDirs as kitDirs } from '../apps/agent/src/fabric/fabric-service.mjs'
import { serviceDirs, servicePaths } from '../apps/agent/src/service/dirs.js'
import { commandScript, descriptorFor, install, layout, LABEL, plistFor, stableNode, stageRelease, uninstall } from './install-agent.mjs'

const temps: string[] = []
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function temp(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'okolos-install-agent-'))
  temps.push(dir)
  return dir
}

describe('installing Okolos Agent (N-016, REQ-63)', () => {
  it('writes a launchd job through the Fabric kit: kept alive, throttled, standard priority, the supervisor marked, no secret', () => {
    const paths = layout(temp())
    const plist = plistFor(paths, '/opt/homebrew/bin/node')
    for (const part of ['<key>RunAtLoad</key>', '<key>KeepAlive</key>', '<key>ThrottleInterval</key>\n\t<integer>10</integer>', '<string>Standard</string>', '<key>FABRIC_SERVICE_SUPERVISOR</key>\n\t\t<string>launchd</string>']) {
      expect(plist).toContain(part)
    }
    expect(plist).toContain('<string>/opt/homebrew/bin/node</string>')
    expect(plist).toContain(`${paths.current}/dist/bin/okolos-agent.mjs`)
    expect(plist).not.toMatch(/token|secret|key=/i)
  })

  it('starts launchd on Homebrew’s stable node, never a versioned Cellar path', () => {
    expect(stableNode('/opt/homebrew/Cellar/node/26.10.0_2/bin/node', (f) => f === '/opt/homebrew/bin/node')).toBe('/opt/homebrew/bin/node')
    expect(stableNode('/usr/local/bin/node', () => true)).toBe('/usr/local/bin/node')
  })

  it('names the host token where the service shell writes it, and the same folders as the Fabric kit', () => {
    const home = temp()
    const paths = layout(home)
    expect(descriptorFor(paths)).toMatchObject({ auth: { tokenFile: servicePaths(serviceDirs(home)).hostToken }, origin: 'http://127.0.0.1:47871' })
    // --uninstall --purge removes the kit's folders: they must be the daemon's own.
    expect(kitDirs('okolos-agent')).toEqual(serviceDirs(os.homedir()))
    expect(commandScript(paths, '/node')).toBe(`#!/bin/sh\nexec "/node" "${paths.current}/dist/bin/okolos-agent.mjs" "$@"\n`)
  })

  it('stages a release that carries the bundle, the probe, the catalogue and the page, and reads nothing from the checkout', { timeout: 120_000 }, async () => {
    const dir = await stageRelease(path.join(temp(), 'release'))
    for (const file of ['dist/bin/okolos-agent.mjs', 'dist/bin/agent-probe.js', 'dist/package.json', '_locales/ru/messages.json', '_locales/en/messages.json', 'static/index.html', 'static/app.js']) {
      expect(existsSync(path.join(dir, file)), file).toBe(true)
    }
    expect(readFileSync(path.join(dir, 'dist/bin/okolos-agent.mjs'), 'utf8')).not.toContain(path.resolve(import.meta.dirname, '..'))
  })

  it('installs: release, command, descriptor, then bootout and bootstrap; uninstall keeps the data unless purged', { timeout: 120_000 }, async () => {
    const home = temp()
    const paths = layout(home)
    const services = path.join(home, 'services')
    const calls: string[] = []
    const run = (argv: string[]) => {
      calls.push(argv.slice(0, 2).join(' '))
      if (argv[1] === 'print') return { status: calls.filter((c) => c === 'launchctl bootstrap').length > 0 ? 0 : 1 }
      return { status: 0, stdout: '' }
    }
    const lines: string[] = []
    await install({
      paths,
      servicesDir: services,
      log: (line) => lines.push(line),
      run,
      platform: 'darwin',
      uid: 501,
      sleep: () => Promise.resolve(),
      fetchWellKnown: () => Promise.resolve({ service: { id: 'okolos-agent', instance: 'default' } }),
    })
    expect(calls.indexOf('launchctl bootout')).toBeLessThan(calls.indexOf('launchctl bootstrap'))
    expect(existsSync(path.join(paths.current, 'dist/bin/okolos-agent.mjs'))).toBe(true)
    expect(existsSync(paths.command)).toBe(true)
    expect(JSON.parse(readFileSync(path.join(services, 'okolos-agent.default.json'), 'utf8')).lifecycle).toEqual({ manager: 'launchd', label: LABEL, plist: paths.plist })

    let loaded = true
    await uninstall({
      paths,
      servicesDir: services,
      log: (line) => lines.push(line),
      run: (argv) => (argv[1] === 'print' ? { status: loaded ? ((loaded = false), 0) : 1 } : { status: 0 }),
      platform: 'darwin',
      uid: 501,
      sleep: () => Promise.resolve(),
    })
    expect(existsSync(paths.command)).toBe(false)
    expect(existsSync(paths.plist)).toBe(false)
    expect(existsSync(path.join(services, 'okolos-agent.default.json'))).toBe(false)
    expect(lines.at(-1)).toContain('--purge removes them')
  })
})
