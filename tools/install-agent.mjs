#!/usr/bin/env node
/**
 * Installs Okolos Agent on this Mac (Okolos Bridge, N-016, REQ-63): a release, its
 * fabric-service/0.1 descriptor, a launchd job and the `okolos-agent` command.
 *
 *   node tools/install-agent.mjs              build, install, load, wait for its well-known
 *   node tools/install-agent.mjs --dry-run    print the plist and the descriptor, change nothing
 *   node tools/install-agent.mjs --status     what is installed and whether launchd has it
 *   node tools/install-agent.mjs --uninstall [--purge]
 *
 * A release is `~/.local/share/okolos-agent/releases/<version>-<sha12>/`: the daemon's
 * bundle and the probe in `dist/bin/`, the catalogue in `_locales/`, the page in `static/`,
 * so it never reads the checkout it was built from; `current` points at it, and the two
 * newest releases are kept. launchd runs `node <current>/dist/bin/okolos-agent.mjs serve`
 * through the Fabric kit's plist (RunAtLoad, KeepAlive, ThrottleInterval 10, ProcessType
 * Standard, no secret). `~/.local/bin/okolos-agent` runs the same bundle for `pair`,
 * `mcp-stdio` and `doctor`.
 *
 * `--uninstall` unloads the job and removes the plist, the descriptor, the command and the
 * releases; the data (access list, agents' journal, events, logs, the agent profile, the
 * agents' keys in `clients/`) stay unless `--purge`, and the installer says so.
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { removeDescriptor, writeDescriptor } from '../apps/agent/src/fabric/fabric-descriptor.mjs'
import { serviceDirs } from '../apps/agent/src/fabric/fabric-paths.mjs'
import { launchdInstall, launchdLoaded, launchdPlist, launchdUninstall, pruneReleases } from '../apps/agent/src/fabric/fabric-supervisors.mjs'
import { buildAgent } from './build-agent.mjs'
import { isMain } from './is-main.mjs'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
export const SERVICE_ID = 'okolos-agent'
export const LABEL = 'ai.passioncode.okolos-agent'
export const PORT = 47871
export const ORIGIN = `http://127.0.0.1:${PORT}`

/** Where everything goes, under `home`; tests pass a temporary one. */
export function layout(home = os.homedir()) {
  const share = path.join(home, '.local', 'share', SERVICE_ID)
  const dirs = serviceDirs(SERVICE_ID)
  const data = home === os.homedir() ? dirs.data : path.join(home, 'Library', 'Application Support', SERVICE_ID)
  const logs = home === os.homedir() ? dirs.logs : path.join(home, 'Library', 'Logs', SERVICE_ID)
  return {
    share,
    releases: path.join(share, 'releases'),
    current: path.join(share, 'current'),
    command: path.join(home, '.local', 'bin', SERVICE_ID),
    plist: path.join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`),
    data,
    logs,
    // The host token's path is the service shell's own (servicePaths in apps/agent/src/service/dirs.ts).
    hostToken: path.join(data, 'host.token'),
    serviceLog: path.join(logs, 'service.jsonl'),
    stdoutLog: path.join(logs, 'stdout.log'),
  }
}

function version() {
  return JSON.parse(readFileSync(path.join(root, 'apps/agent/package.json'), 'utf8')).version
}

function commit() {
  try {
    return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    return '0'.repeat(40)
  }
}

/** The release's folder name: the version and the commit it was built from. */
export function releaseName(v = version(), sha = commit()) {
  return `${v}-${sha.slice(0, 12)}`
}

/** Builds the release into `dir`: everything the daemon reads at run time, nothing from the checkout. */
export async function stageRelease(dir) {
  await buildAgent(path.join(dir, 'dist', 'bin'))
  cpSync(path.join(root, 'apps/agent/_locales'), path.join(dir, '_locales'), { recursive: true })
  cpSync(path.join(root, 'apps/agent/static'), path.join(dir, 'static'), { recursive: true })
  writeFileSync(path.join(dir, 'dist', 'package.json'), `${JSON.stringify({ name: '@okolos/agent', version: version() }, null, 2)}\n`)
  return dir
}

/**
 * The node launchd starts: Homebrew's stable link rather than the versioned Cellar path
 * `process.execPath` names, which the next `brew upgrade` removes.
 */
export function stableNode(execPath = process.execPath, exists = existsSync) {
  const cellar = /^(.*)\/Cellar\/node(?:@\d+)?\/[^/]+\/bin\/node$/.exec(execPath)
  if (cellar !== null && exists(path.join(cellar[1], 'bin', 'node'))) return path.join(cellar[1], 'bin', 'node')
  return execPath
}

/** The launchd job, written by the Fabric kit. */
export function plistFor(paths, node = stableNode()) {
  return launchdPlist(LABEL, [node, path.join(paths.current, 'dist', 'bin', 'okolos-agent.mjs'), 'serve'], {
    workingDirectory: paths.share,
    stdoutPath: paths.stdoutLog,
  })
}

/** The fabric-service/0.1 descriptor Fabric Dashboards reads. */
export function descriptorFor(paths, now = new Date()) {
  return {
    protocol: 'fabric-service/0.1',
    id: SERVICE_ID,
    instance: 'default',
    name: 'Okolos Agent',
    summary: 'The door through which paired agents read pages in their own Chrome window, cleaned of what the page hid from people.',
    origin: ORIGIN,
    auth: { tokenFile: paths.hostToken },
    lifecycle: { manager: 'launchd', label: LABEL, plist: paths.plist },
    paths: { data: paths.data, logs: [paths.serviceLog] },
    source: { repository: 'https://github.com/passioncode-ai/okolos' },
    installedAt: now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    installedBy: { by: 'person', role: 'operator', tool: 'okolos tools/install-agent.mjs' },
  }
}

/** The `okolos-agent` command: a two-line script that runs the current release with this node. */
export function commandScript(paths, node = stableNode()) {
  return `#!/bin/sh\nexec "${node}" "${path.join(paths.current, 'dist', 'bin', 'okolos-agent.mjs')}" "$@"\n`
}

function writeCommand(paths) {
  mkdirSync(path.dirname(paths.command), { recursive: true })
  writeFileSync(paths.command, commandScript(paths), { mode: 0o755 })
  chmodSync(paths.command, 0o755)
  const onPath = (process.env.PATH ?? '').split(path.delimiter).includes(path.dirname(paths.command))
  return onPath ? null : `export PATH="${path.dirname(paths.command)}:$PATH"`
}

export async function install({ paths = layout(), log = console.log, dryRun = false, servicesDir, ...kit } = {}) {
  const plist = plistFor(paths)
  const descriptor = descriptorFor(paths)
  if (dryRun) {
    log(plist)
    log(JSON.stringify(descriptor, null, 2))
    return { dryRun: true }
  }
  const release = path.join(paths.releases, releaseName())
  rmSync(release, { recursive: true, force: true })
  await stageRelease(release)
  rmSync(paths.current, { force: true })
  symlinkSync(release, paths.current)
  const missingPath = writeCommand(paths)
  writeDescriptor(descriptor, ...(servicesDir === undefined ? [] : [servicesDir]))
  const answer = await launchdInstall(LABEL, paths.plist, plist, { origin: ORIGIN, serviceId: SERVICE_ID, ...kit })
  const removed = pruneReleases(paths.releases, { keep: 2, current: paths.current })
  log(`installed ${path.basename(release)}; launchd ${answer.disabled ? 'has it disabled by the operator' : 'runs it'}; ${removed.length} old release(s) removed`)
  if (missingPath !== null) log(`${path.dirname(paths.command)} is not on PATH; add to your shell profile: ${missingPath}`)
  return { release, answer, removed }
}

export async function uninstall({ paths = layout(), log = console.log, purge = false, servicesDir, ...kit } = {}) {
  const result = await launchdUninstall(LABEL, paths.plist, { purge, serviceId: SERVICE_ID, ...kit })
  removeDescriptor(SERVICE_ID, 'default', ...(servicesDir === undefined ? [] : [servicesDir]))
  for (const file of [paths.command, paths.current]) {
    try {
      unlinkSync(file)
    } catch {
      // already gone
    }
  }
  rmSync(paths.releases, { recursive: true, force: true })
  if (purge) log(`removed: ${result.purged.join(', ') || 'no data folder was there'}`)
  else log(`kept: ${paths.data} (access list, agents' journal, events, agent profile, agents' keys) and ${paths.logs}; --purge removes them`)
  return result
}

export function status({ paths = layout(), ...kit } = {}) {
  return {
    installed: existsSync(paths.current) ? path.basename(readlinkSafe(paths.current)) : null,
    plist: existsSync(paths.plist),
    loaded: process.platform === 'darwin' ? launchdLoaded(LABEL, kit) : false,
    command: existsSync(paths.command),
  }
}

function readlinkSafe(link) {
  try {
    return execFileSync('readlink', [link], { encoding: 'utf8' }).trim()
  } catch {
    return link
  }
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args.includes('--status')) console.log(JSON.stringify(status(), null, 2))
  else if (args.includes('--uninstall')) await uninstall({ purge: args.includes('--purge') })
  else await install({ dryRun: args.includes('--dry-run') })
}
