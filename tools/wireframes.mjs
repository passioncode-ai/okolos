/**
 * Wireframes derived from the renderers, not written beside them.
 *
 * Every screen record in `screens.md` points at a wireframe. Hand-written, that
 * file becomes a fourth copy of the truth — after the code, the scenario and
 * the screen record — and the one nobody updates. So it is generated: the
 * element inventory comes out of the renderer that produces it, and a test
 * asserts the committed file still matches. A screen that gains a control fails
 * the build until its wireframe is regenerated, which makes drift impossible
 * rather than merely discouraged.
 *
 * What a generated wireframe is good for is the same thing a hand-drawn one is:
 * seeing at a glance what is on a screen and in what order. What it cannot do
 * is describe intent — that lives in the screen record's Purpose line, which is
 * written by a person and quoted here.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { isMain } from './is-main.mjs'

const root = process.cwd()

export const SCREENS = {
  'SCR-01': { title: 'First run', source: 'packages/ui/src/first-run/screen.ts' },
  'SCR-02': { title: 'Popup', source: 'packages/ui/src/popup/popup.ts' },
  'SCR-03': { title: 'In-page warning banner', source: 'packages/ui/src/banner/banner.ts' },
  'SCR-04': { title: 'Finding inspector', source: 'packages/ui/src/inspector/inspector.ts' },
  'SCR-05': { title: 'Block interstitial', source: 'packages/ui/src/interstitial/interstitial.ts' },
  'SCR-06': { title: 'Agent action gate', source: 'packages/ui/src/gate/gate.ts' },
  'SCR-07': { title: 'Findings queue', source: 'packages/ui/src/queue/queue.ts' },
  'SCR-08': { title: 'Leaks and repair', source: 'packages/ui/src/leaks/leaks.ts' },
  'SCR-09': { title: 'Extensions watch', source: 'packages/ui/src/extensions/extensions.ts' },
  'SCR-10': { title: 'Self-audit', source: 'packages/ui/src/self-audit/panel.ts' },
  'SCR-11': { title: 'Journal and weekly diff', source: 'packages/ui/src/journal/journal.ts' },
  'SCR-12': { title: 'Settings — data controls', source: 'packages/ui/src/settings/data-controls.ts' },
  'SCR-13': { title: 'Recovery checklist', source: 'packages/ui/src/recovery/recovery.ts' },
  'SCR-14': { title: 'Public domain status', source: 'apps/proxy/src/router.ts' },
  'SCR-15': { title: 'Dashboard overview', source: 'packages/ui/src/dashboard/overview.ts' },
  'SCR-16': { title: 'Trusted domains', source: 'packages/ui/src/trusted/trusted.ts' },
}

/**
 * The file's own role-emitting helpers, found by their signature.
 *
 * This used to be a list of five names — `text|button|row|action|line` — and it failed on
 * whichever helper was written last: `note(...)` lost SCR-12 two roles on 2026-08-20 and
 * `span(...)` lost SCR-07 two more on 2026-08-21, both while the screens emitted them. An
 * allow-list of helper names is the same silent-by-default shape as an allow-list of styled
 * roles.
 *
 * Matching *any* call shaped `f(doc, 'literal')` is too wide in the other direction —
 * measured: it read `createOverlayHost(doc, 'banner')` as a role and put three roles that
 * do not exist into three wireframes. What actually identifies these helpers is their
 * signature: they take a parameter called `role`. So the file is read for functions that
 * declare one, and only their call sites count — with the argument taken from the position
 * the parameter sits in, which is how `note(role, …)` is covered without naming it.
 */
function roleHelpers(text) {
  const helpers = []
  for (const match of text.matchAll(/function (\w+)\(([^)]*)\)/g)) {
    const params = (match[2] ?? '').split(',').map((param) => param.trim())
    const at = params.findIndex((param) => /^role\??:/.test(param))
    if (at >= 0) helpers.push({ name: match[1], at })
  }
  return helpers
}

/** Every `data-role` the renderer can emit, in the order the source names them. */
export function rolesOf(source) {
  const text = readFileSync(path.join(root, source), 'utf8')

  /**
   * Candidates with the position they were found at, so the order is the source's.
   *
   * The two passes below find roles in different ways and would otherwise report them in
   * pass order, which renamed nothing and reordered fifteen wireframes — a diff that says
   * "everything changed" about a change that added two roles. The heading above promises
   * source order; sorting keeps the promise.
   */
  const found = []

  for (const helper of roleHelpers(text)) {
    for (const call of text.matchAll(new RegExp(`\\b${helper.name}\\(`, 'g'))) {
      const literal = argumentAt(text, (call.index ?? 0) + call[0].length, helper.at)
      if (literal !== null) found.push({ at: call.index ?? 0, role: literal })
    }
  }

  const patterns = [
    /setAttribute\(\s*'data-role',\s*'([a-z0-9-]+)'/g,
    // Server-rendered screens have no DOM calls; the roles are in the markup.
    /data-role="([a-z0-9-]+)"/g,
  ]
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      found.push({ at: match.index ?? 0, role: match[1] })
    }
  }

  const roles = []
  for (const { role } of found.sort((a, b) => a.at - b.at)) {
    if (!roles.includes(role)) roles.push(role)
  }
  return roles
}

/**
 * The literal at one argument position of a call, or null.
 *
 * Commas are counted at depth zero only, so a nested call or an object literal cannot
 * shift the position the role sits in.
 */
function argumentAt(text, from, index) {
  const args = []
  let depth = 1
  let current = ''
  for (let i = from; i < text.length && depth > 0; i += 1) {
    const ch = text[i]
    if (ch === '(' || ch === '[' || ch === '{') depth += 1
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1
    if (depth === 1 && ch === ',') {
      args.push(current.trim())
      current = ''
      continue
    }
    if (depth > 0) current += ch
  }
  args.push(current.trim())
  const literal = /^'([a-z0-9-]+)'$/.exec(args[index] ?? '')
  return literal ? literal[1] : null
}

/** The states the screen record declares, so the two documents cannot disagree. */
export function statesOf(id) {
  const screens = readFileSync(path.join(root, 'docs/ux/screens.md'), 'utf8')
  const block = screens.split(new RegExp(`^### ${id}:`, 'm'))[1]?.split(/^### SCR-/m)[0] ?? ''
  return [...block.matchAll(/^\s*\|\s*(loading|empty|error|success)\s*\|\s*([^|]+)\|/gim)].map(
    (match) => ({ state: match[1].trim(), trigger: match[2].trim() }),
  )
}

export function purposeOf(id) {
  const screens = readFileSync(path.join(root, 'docs/ux/screens.md'), 'utf8')
  const block = screens.split(new RegExp(`^### ${id}:`, 'm'))[1]?.split(/^### SCR-/m)[0] ?? ''
  return /- \*\*Purpose:\*\*\s*(.+)/.exec(block)?.[1]?.trim() ?? ''
}

/**
 * Roles emitted by the local modules a screen imports, one hop deep.
 *
 * A screen in this project is composed: `popup.ts` renders the queue from
 * `queue/queue.ts`, so `[data-role=item]` is addressable on SCR-02 and no amount of
 * reading `popup.ts` will say so. The cross-check in `wireframes.test.ts` knew that and
 * walked one hop; the generator did not — so "Elements" meant "roles this one file names"
 * while the heading said "elements of the screen" (B-71). The gate knew about composition
 * and the document it guards did not.
 *
 * One hop, deliberately. Two would pull in every leaf helper of every component and turn
 * an inventory a person reads at a glance into a transitive closure. Where a screen
 * composes a component that itself composes another, the second level shows up in *that*
 * component's own wireframe, which is where a reader looking for it would go.
 *
 * @param {string} source
 * @returns {{ role: string, from: string }[]}
 */
export function composedRoles(source) {
  const text = readFileSync(path.join(root, source), 'utf8')
  // `source` is repository-relative and spelled with `/`; path.posix keeps it so on
  // Windows, where the "from" line would otherwise print backslashes (B-164).
  const dir = path.posix.dirname(source)
  const found = []
  for (const match of text.matchAll(/from '(\.[^']+)\.js'/g)) {
    const target = path.posix.join(dir, `${match[1]}.ts`)
    try {
      readFileSync(path.join(root, target), 'utf8')
    } catch {
      continue
    }
    for (const role of rolesOf(target)) found.push({ role, from: target })
  }
  return found
}

/**
 * Which composed roles get a "from" line, and which are the screen's own.
 *
 * A role emitted by the screen *and* by a component it composes belongs in the own list:
 * saying "from `queue/queue.ts`" about something `popup.ts` also writes sends a reader to
 * the wrong file to change it. No screen in this tree currently emits a role one of its
 * components also emits — which is exactly why this is a function with its own test
 * rather than a condition inside the template. A guard whose case the tree does not
 * contain cannot be checked through the tree, and an unchecked guard is a comment.
 *
 * Deduplicated too: two components emitting the same role produce one line, attributed to
 * the first, because the reader needs somewhere to start and not a list of everywhere.
 *
 * @param {readonly string[]} own
 * @param {readonly {role: string, from: string}[]} composed
 * @returns {{role: string, from: string}[]}
 */
export function attributeRoles(own, composed) {
  const mine = new Set(own)
  const seen = new Set()
  const out = []
  for (const { role, from } of composed) {
    if (mine.has(role) || seen.has(role)) continue
    seen.add(role)
    out.push({ role, from })
  }
  return out
}

export function wireframe(id) {
  const { title, source } = SCREENS[id]
  const roles = rolesOf(source)
  const composed = attributeRoles(roles, composedRoles(source))
  const states = statesOf(id)
  const purpose = purposeOf(id)

  return `<!-- Generated by tools/wireframes.mjs from ${source}. Do not edit by hand:
     run \`pnpm wireframes\` after changing the screen, and commit the result. -->

# ${id} — ${title}

**Purpose:** ${purpose}

**Elements this screen emits itself, in the order the renderer names them.** Each is
addressable as \`[data-role=<name>]\`, which is also how the tests reach them.

${roles.map((role) => `- \`${role}\``).join('\n')}
${
  composed.length === 0
    ? ''
    : `
**Elements it shows through the components it composes.** Addressable on this screen in
exactly the same way; listed separately because the file to change is not this screen's.

${composed.map(({ role, from }) => `- \`${role}\` — from \`${from}\``).join('\n')}
`
}
**States**

${
  states.length === 0
    ? '_None declared in the screen record._'
    : states.map((entry) => `- **${entry.state}** — ${entry.trigger}`).join('\n')
}

**Source of truth:** \`${source}\`. This file is derived from it; if the two
disagree, the renderer is right and this file is stale.
`
}

export function writeAll() {
  const dir = path.join(root, 'docs/ux/wireframes')
  mkdirSync(dir, { recursive: true })
  for (const id of Object.keys(SCREENS)) {
    writeFileSync(path.join(dir, `${id}.md`), wireframe(id), 'utf8')
  }
  return Object.keys(SCREENS).length
}

// The path, not a `file://` string built from it: on Windows argv[1] is `C:\…`, and
// the string never equalled the URL, so `pnpm wireframes` wrote nothing (B-162).
// Real paths, so a run through a symlink or a junction still runs (tools/is-main.mjs).
if (isMain(import.meta.filename)) {
  console.log(`wrote ${writeAll()} wireframes`)
}
