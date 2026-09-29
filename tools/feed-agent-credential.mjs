import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

/**
 * Where the feed agent's Cloudflare token comes from.
 *
 * The agent ran for weeks on a CLOUDFLARE_API_TOKEN that had been revoked: it
 * inherited one from the login environment, and the environment outranks
 * ~/.okolos/cloudflare.env in publish-feed. So the list was built and signed
 * every twelve hours and never reached the worker (B-133). When this machine
 * runs Project Observatory and its vault holds the slot below, the agent takes
 * the token from there — issued narrow (D1 Write, one account) and rotated in
 * one place — and the stale variable cannot shadow it, because the runner puts
 * the vault's value into the child's environment last.
 */
export const SLOT = { project: 'okolos', env: 'prod', name: 'CLOUDFLARE_API_TOKEN' }

/** One shell word: single-quoted, so a path with a space stays one argument. */
export function quote(word) {
  return `'${String(word).replaceAll("'", `'\\''`)}'`
}

/**
 * The words that go before `pnpm feed:refresh`, or '' when there is no door.
 * Pure: everything it needs is passed in, so the rendering is testable without
 * this machine.
 */
export function runnerPrefix(door) {
  if (!door) return ''
  const { python, root } = door
  return [
    quote(python),
    quote(`${root}/tools/use_secret.py`),
    'run',
    '--env',
    SLOT.env,
    SLOT.project,
    SLOT.name,
    '--',
  ].join(' ')
}

/** Escapes what an XML <string> cannot hold as-is. */
export function xml(text) {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

/**
 * The Observatory on this machine, if it has one and the slot exists.
 * Returns { python, root } or null, and says why on null — a silent fallback
 * is how the revoked token went unnoticed.
 */
export function discover({ run = execFileSync, read = readFileSync, log = console.warn } = {}) {
  let launcher
  let root
  try {
    launcher = run('which', ['project-observatory'], { encoding: 'utf8' }).trim()
    root = run('project-observatory', ['full-path'], { encoding: 'utf8' }).trim()
  } catch {
    log('feed agent: Project Observatory is not installed — the token comes from the environment or ~/.okolos/cloudflare.env')
    return null
  }
  const shebang = read(launcher, 'utf8').split('\n', 1)[0] ?? ''
  const python = shebang.startsWith('#!') ? shebang.slice(2).trim() : ''
  if (!python || !root) {
    log('feed agent: could not resolve the Observatory interpreter — falling back to the environment')
    return null
  }
  let names = ''
  try {
    names = run(python, [`${root}/tools/use_secret.py`, 'names', SLOT.project], { encoding: 'utf8' })
  } catch {
    names = ''
  }
  if (!names.includes(`vault:${SLOT.project}/${SLOT.env}`) || !names.includes(SLOT.name)) {
    log(
      `feed agent: the vault has no ${SLOT.project}/${SLOT.env}/${SLOT.name} — issue it with ` +
        `cloudflare.py issue --preset d1-edit --vault ${SLOT.project}/${SLOT.env}/${SLOT.name}`,
    )
    return null
  }
  return { python, root }
}
