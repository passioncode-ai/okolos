#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { runBounded } from './feed/bounded.mjs'
import { feedPaths } from './feed/paths.mjs'
import { readStatus } from './feed/status.mjs'
import { discover, quote, runnerArgv, xml } from './feed-agent-credential.mjs'

/**
 * Installs the feed-refresh agent on this machine, or prints what it would do.
 *
 *   node tools/install-feed-agent.mjs                      # checkout, plist, load
 *   node tools/install-feed-agent.mjs --dry-run            # print the plist, touch nothing
 *   node tools/install-feed-agent.mjs --status             # plist, launchd's view, last run
 *   node tools/install-feed-agent.mjs --uninstall          # bootout, delete the plist, verify
 *   node tools/install-feed-agent.mjs --uninstall --purge  # and the checkout, state and logs
 *
 * The schedule cannot live in CI: ADR-0002 keeps the signing key off every
 * server, so the feed is signed and published from the machine that holds it.
 * That makes installing the agent a human step, and this reduces it to one
 * command — which is the difference between a step someone does and a step
 * someone means to do. Measured 2026-08-19, the meaning-to version left the
 * shipped list six days old, blocking one live host out of 248.
 *
 * Symmetric by construction (LC-14): uninstall removes what install added and
 * proves launchd no longer knows the label — the plist used to stay behind and
 * launchd loaded it again at the next login (F5). And the operator's intent wins:
 * an install over an agent the operator disabled updates the file and loads
 * nothing.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const LABEL = 'app.okolos.feed'
const source = path.join(root, 'tools/launchd', `${LABEL}.plist`)

const PLACEHOLDERS = ['{{CHECKOUT}}', '{{RUNNER}}', '{{LOG_DIR}}']
const LAUNCHCTL_TIMEOUT_MS = 15_000

/** launchctl, bounded. Returns `{ code, stdout, stderr }`. */
async function realLaunchctl(args) {
  const result = await runBounded('launchctl', args, { timeoutMs: LAUNCHCTL_TIMEOUT_MS })
  return { code: result.code ?? 1, stdout: result.stdout, stderr: result.stderr || result.error || '' }
}

/**
 * The plist launchd will read: placeholders replaced inside their strings only, so
 * no comment is rewritten, and a template that lost one is refused rather than
 * guessed at — launchd would fail silently every twelve hours.
 */
export function rendered({ template = readFileSync(source, 'utf8'), checkout, runner, logDir }) {
  for (const token of PLACEHOLDERS) {
    if (!template.includes(token)) throw new Error(`${source} no longer contains ${token} — refusing to guess`)
  }
  const out = template
    .replaceAll('{{CHECKOUT}}', xml(quote(checkout)))
    .replaceAll('{{RUNNER}}', runner ? xml(JSON.stringify(runner)).replaceAll('"', '&quot;') : '')
    .replaceAll('{{LOG_DIR}}', xml(logDir))
  if (out.includes('{{')) throw new Error('a placeholder survived rendering')
  return out
}

/** Whether `launchctl print-disabled` lists `label` as disabled (both spellings macOS uses). */
export function isDisabled(printDisabled, label = LABEL) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`"${escaped}"\\s*=>\\s*(?:disabled|true)\\b`).test(printDisabled)
}

/**
 * The agent's own checkout: a detached worktree of this repository at origin/main,
 * with only the publish tools installed. Left alone when it exists — the job
 * fast-forwards it before every run.
 */
export async function ensureCheckout({ repo = root, checkout, tool = runBounded, log = console.log }) {
  if (existsSync(checkout)) {
    log(`agent checkout: ${checkout} (kept; the job fast-forwards it)`)
    return
  }
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  delete env.CLOUDFLARE_API_TOKEN
  const steps = [
    ['git', ['-C', repo, 'fetch', '--quiet', 'origin', 'main'], { env, timeoutMs: 90_000 }],
    ['git', ['-C', repo, 'worktree', 'add', '--detach', checkout, 'origin/main'], { env, timeoutMs: 120_000 }],
    ['pnpm', ['install', '--frozen-lockfile', '--filter', '@okolos/proxy'], { cwd: checkout, env, timeoutMs: 600_000 }],
  ]
  for (const [command, args, options] of steps) {
    const result = await tool(command, args, options)
    if (result.code !== 0) {
      throw new Error(`${command} ${args.join(' ')} failed: ${(result.stderr || result.error || '').trim()}`)
    }
  }
  log(`agent checkout: ${checkout} at origin/main`)
}

/** Writes the plist and loads it — unless the operator disabled the service. */
export async function installAgent({ label = LABEL, domain, target, plist, launchctl = realLaunchctl, log = console.log }) {
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, plist)
  log(`wrote ${target}`)

  const disabled = await launchctl(['print-disabled', domain])
  if (isDisabled(disabled.stdout, label)) {
    log(
      `${label} is disabled in ${domain} — the operator's choice, kept. The plist is updated; ` +
        `nothing was loaded. To turn it back on: launchctl enable ${domain}/${label}, then run this again.`,
    )
    return { state: 'disabled' }
  }

  // Bootout first so re-running is an update rather than an error about an agent
  // that is already loaded. Not loaded yet is the ordinary case on a first install.
  await launchctl(['bootout', `${domain}/${label}`])
  const loaded = await launchctl(['bootstrap', domain, target])
  if (loaded.code !== 0) throw new Error(`launchctl bootstrap failed: ${loaded.stderr.trim()}`)
  return { state: 'loaded' }
}

/**
 * Boots the agent out, deletes its plist, and verifies with `launchctl print` that
 * launchd no longer knows the label. With `purge`, also removes the agent's
 * checkout, state and logs.
 */
export async function uninstallAgent({ label = LABEL, domain, target, launchctl = realLaunchctl, log = console.log, purge }) {
  // Not loaded is the outcome asked for, not a failure.
  await launchctl(['bootout', `${domain}/${label}`])
  rmSync(target, { force: true })

  if (purge) {
    const { repo, paths, tool = runBounded } = purge
    if (existsSync(paths.agentCheckout)) {
      const removed = await tool('git', ['-C', repo, 'worktree', 'remove', '--force', paths.agentCheckout], { timeoutMs: 60_000 })
      if (removed.code !== 0) log(`git worktree remove failed (${(removed.stderr || '').trim()}); removing the directory`)
      rmSync(paths.agentCheckout, { recursive: true, force: true })
    }
    rmSync(paths.state, { recursive: true, force: true })
    rmSync(paths.logs, { recursive: true, force: true })
    log(`purged ${paths.agentCheckout}, ${paths.state} and ${paths.logs}`)
  }

  const still = await launchctl(['print', `${domain}/${label}`])
  if (still.code === 0) {
    return { ok: false, reason: `${domain}/${label} is still loaded after bootout — check launchctl print ${domain}/${label}` }
  }
  log(`removed ${label}: no plist at ${target}, and launchd no longer lists it`)
  return { ok: true }
}

function field(printed, name) {
  return new RegExp(`^\\s*${name} = (.+)$`, 'm').exec(printed)?.[1]?.trim()
}

/** The plist, launchd's view of the service, and the last run's record. */
export async function agentStatus({ label = LABEL, domain, target, launchctl = realLaunchctl, paths = feedPaths() }) {
  const printed = await launchctl(['print', `${domain}/${label}`])
  const loaded = printed.code === 0
  const runs = Number(field(printed.stdout, 'runs'))
  const lastExit = Number(field(printed.stdout, 'last exit code'))
  return {
    plist: existsSync(target),
    loaded,
    launchd: loaded
      ? {
          state: field(printed.stdout, 'state') ?? null,
          runs: Number.isFinite(runs) ? runs : null,
          lastExit: Number.isFinite(lastExit) ? lastExit : null,
        }
      : null,
    lastRun: readStatus(paths.status),
    log: paths.log,
  }
}

async function main() {
  const argv = process.argv.slice(2)
  const target = path.join(os.homedir(), 'Library/LaunchAgents', `${LABEL}.plist`)
  const domain = `gui/${process.getuid?.() ?? 501}`
  const paths = feedPaths()

  if (process.platform !== 'darwin') {
    console.error(
      'launchd is a macOS thing. On Linux the same schedule is a systemd timer or a\n' +
        'crontab line running `node tools/feed-job.mjs --agent` every twelve hours, from a\n' +
        'checkout at origin/main on a machine that holds the signing key.',
    )
    process.exit(argv.includes('--uninstall') ? 0 : 1)
  }

  if (argv.includes('--status')) {
    console.log(JSON.stringify(await agentStatus({ domain, target, paths }), null, 2))
    return
  }

  if (argv.includes('--uninstall')) {
    const result = await uninstallAgent({
      domain,
      target,
      purge: argv.includes('--purge') ? { repo: root, paths } : undefined,
    })
    if (!result.ok) {
      console.error(`install-feed-agent: ${result.reason}`)
      process.exit(1)
    }
    return
  }

  const plist = rendered({ checkout: paths.agentCheckout, runner: runnerArgv(discover()), logDir: paths.logs })
  if (argv.includes('--dry-run')) {
    console.log(plist)
    console.log(`\n— would create ${paths.agentCheckout} (a worktree at origin/main) if missing`)
    console.log(`— would write ${target}`)
    console.log(`— would run: launchctl bootstrap ${domain} ${target} (unless the operator disabled it)`)
    return
  }

  await ensureCheckout({ checkout: paths.agentCheckout })
  mkdirSync(paths.logs, { recursive: true, mode: 0o700 })
  const { state } = await installAgent({ domain, target, plist })
  if (state === 'loaded') {
    console.log(
      `loaded ${LABEL} — refreshes every 12 hours, and now if the served feed is stale.\n` +
        `  node tools/install-feed-agent.mjs --status\n` +
        `  tail -f ${paths.log}`,
    )
  }
}

if (import.meta.filename === process.argv[1]) {
  main().catch((cause) => {
    console.error(`install-feed-agent: ${cause instanceof Error ? cause.message : String(cause)}`)
    process.exit(1)
  })
}
