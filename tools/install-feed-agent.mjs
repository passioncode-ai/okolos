#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { discover, runnerPrefix, xml } from './feed-agent-credential.mjs'

/**
 * Installs the feed-refresh agent on this machine, or prints what it would do.
 *
 *   node tools/install-feed-agent.mjs            # write the plist and load it
 *   node tools/install-feed-agent.mjs --dry-run  # print the plist, touch nothing
 *   node tools/install-feed-agent.mjs --uninstall
 *
 * The schedule cannot live in CI: ADR-0002 keeps the signing key off every
 * server, so the feed is signed and published from the machine that holds it.
 * That makes installing the agent a human step, and this reduces it to one
 * command — which is the difference between a step someone does and a step
 * someone means to do. Measured 2026-08-19, the meaning-to version left the
 * shipped list six days old, blocking one live host out of 248.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const LABEL = 'app.okolos.feed'
const source = path.join(root, 'tools/launchd', `${LABEL}.plist`)
const target = path.join(os.homedir(), 'Library/LaunchAgents', `${LABEL}.plist`)
const domain = `gui/${process.getuid?.() ?? 501}`

const dryRun = process.argv.includes('--dry-run')
const uninstall = process.argv.includes('--uninstall')

/** The plist launchd will read: the placeholder replaced by this checkout. */
export function rendered(repo = root, template = readFileSync(source, 'utf8'), runner = '') {
  if (!template.includes('REPO_PATH')) {
    // The template is the only place the path is templated. If the marker is
    // gone, this script would write a plist pointing at somebody else's machine
    // and launchd would fail silently every twelve hours.
    throw new Error(`${source} no longer contains REPO_PATH — refusing to guess`)
  }
  if (!template.includes('CREDENTIAL_RUNNER')) {
    throw new Error(`${source} no longer contains CREDENTIAL_RUNNER — refusing to guess`)
  }
  // The runner is the Observatory's door to the vault slot, or nothing. Empty
  // collapses to the old command; a present one prefixes it, so the token the
  // vault holds is the one wrangler sees (tools/feed-agent-credential.mjs).
  return template
    .replaceAll('REPO_PATH', repo)
    .replaceAll('CREDENTIAL_RUNNER ', runner ? `${xml(runner)} ` : '')
}

if (uninstall) {
  if (process.platform !== 'darwin') {
    console.log('launchd is a macOS thing; nothing to remove here.')
    process.exit(0)
  }
  try {
    execFileSync('launchctl', ['bootout', `${domain}/${LABEL}`], { stdio: 'inherit' })
  } catch {
    // Already gone is the outcome asked for, not a failure.
  }
  console.log(`removed ${LABEL}; the plist stays at ${target} until you delete it`)
  process.exit(0)
}

const plist = rendered(root, readFileSync(source, 'utf8'), runnerPrefix(discover()))

if (dryRun) {
  console.log(plist)
  console.log(`\n— would write ${target}`)
  console.log(`— would run: launchctl bootstrap ${domain} ${target}`)
  process.exit(0)
}

if (process.platform !== 'darwin') {
  console.error(
    'launchd is a macOS thing. On Linux the same schedule is a systemd timer or a\n' +
      'crontab line running `pnpm feed:refresh` every twelve hours, from a machine\n' +
      'that holds the signing key.',
  )
  process.exit(1)
}

mkdirSync(path.dirname(target), { recursive: true })
writeFileSync(target, plist)
console.log(`wrote ${target}`)

// Bootout first so re-running is an update rather than an error about an agent
// that is already loaded.
if (existsSync(target)) {
  try {
    execFileSync('launchctl', ['bootout', `${domain}/${LABEL}`], { stdio: 'ignore' })
  } catch {
    // Not loaded yet, which is the ordinary case on a first install.
  }
}
execFileSync('launchctl', ['bootstrap', domain, target], { stdio: 'inherit' })
console.log(
  `loaded ${LABEL} — refreshes every 12 hours and once now.\n` +
    `  launchctl print ${domain}/${LABEL} | grep -E 'state|last exit'\n` +
    `  tail -f /tmp/okolos-feed.log`,
)
