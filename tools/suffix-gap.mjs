#!/usr/bin/env node
/**
 * How far the shipped suffix table is from the real Public Suffix List, in numbers.
 *
 * **Why a tool and not a gate.** The list lives at `publicsuffix.org`, and a gate that
 * fetches it goes red on the day that host has a bad afternoon — the flake class this
 * project refuses, and the same reason `graph:check` is not in `pnpm gates`. So this is
 * run on purpose, like rebuilding the graph, and what it prints is what the decision in
 * `suffixes.json` rests on.
 *
 * **Why the decision is not "vendor it".** Measured 2026-08-20: the whole list is 171 KB
 * of JSON against a 61.5 KB content script, injected and parsed on every page; the
 * private section alone is 69 KB. Both leave 283 wildcard and 8 exception rules
 * unimplemented. What it buys, against the 248 hosts of the shipped feed: three sat
 * under a private suffix this table lacked, and **zero** were themselves an unknown
 * private apex — the case that emits a `||host^` rule over an entire platform. Those
 * three families were added by hand instead.
 *
 * **The two sections fail in opposite directions, which is why they are counted apart.**
 * A missing ICANN suffix reads a registrant's domain one label short and can only lose
 * a finding. A missing private suffix lets the blocklist treat a platform's apex as a
 * site and take the platform down for everyone who installed this.
 *
 *   node tools/suffix-gap.mjs                 # fetch and compare
 *   node tools/suffix-gap.mjs <file.dat>      # compare against a copy already on disk
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const SOURCE = 'https://publicsuffix.org/list/public_suffix_list.dat'

/** The list's own sections, kept apart because their failure directions differ. */
function parse(text) {
  let section = null
  const icann = new Set()
  const priv = new Set()
  for (const line of text.split(/\r?\n/)) {
    const rule = line.trim()
    if (rule.startsWith('// ===BEGIN ICANN')) {
      section = 'icann'
      continue
    }
    if (rule.startsWith('// ===BEGIN PRIVATE')) {
      section = 'private'
      continue
    }
    if (rule.startsWith('// ===END')) {
      section = null
      continue
    }
    if (rule === '' || rule.startsWith('//')) continue
    if (section === 'icann') icann.add(rule)
    else if (section === 'private') priv.add(rule)
  }
  return { icann, priv }
}

async function load() {
  const local = process.argv[2]
  if (local !== undefined) return readFileSync(path.resolve(local), 'utf8')
  const answer = await fetch(SOURCE)
  if (!answer.ok) throw new Error(`${SOURCE} answered ${answer.status}`)
  return answer.text()
}

const table = JSON.parse(
  readFileSync(path.join(root, 'packages/core-lookalike/src/suffixes.json'), 'utf8'),
)
const feed = JSON.parse(readFileSync(path.join(root, 'feeds/phishing.json'), 'utf8'))
const hosts = (feed.body?.entries ?? []).map((entry) =>
  typeof entry === 'string' ? entry : (entry.host ?? ''),
)

let text
try {
  text = await load()
} catch (cause) {
  console.error(`\n  could not read the list: ${String(cause)}`)
  console.error('  Pass a local copy: node tools/suffix-gap.mjs public_suffix_list.dat\n')
  process.exit(1)
}

const { icann, priv } = parse(text)
if (icann.size === 0 || priv.size === 0) {
  // An empty parse would make every number below flattering and every claim false.
  console.error('\n  the list parsed to an empty section — the markers must have changed\n')
  process.exit(1)
}

const whole = new Set([...icann, ...priv])
const mine = new Set([...table.icann, ...table.private])

const beyond = [...mine].filter((suffix) => !whole.has(suffix)).sort()
const recorded = new Set(table.beyondThePublicSuffixList ?? [])
const unrecorded = beyond.filter((suffix) => !recorded.has(suffix))
const goneStale = [...recorded].filter((suffix) => whole.has(suffix)).sort()

/** A feed host under a private suffix we do not know: a finding lost. */
const lost = hosts.filter((host) => {
  const labels = host.split('.')
  for (let at = 1; at < labels.length; at += 1) {
    const suffix = labels.slice(at).join('.')
    if (priv.has(suffix)) return !mine.has(suffix)
  }
  return false
})

/** A feed host that IS an unknown private apex: a platform blocked for everyone. */
const outages = hosts.filter((host) => priv.has(host) && !mine.has(host))

const wildcards = [...whole].filter((rule) => rule.startsWith('*')).length
const exceptions = [...whole].filter((rule) => rule.startsWith('!')).length

console.log(`\nthe real list: ${whole.size} rules (${icann.size} ICANN, ${priv.size} private)`)
console.log(`  of those, ${wildcards} wildcard and ${exceptions} exception rules — this table implements neither`)
console.log(`shipped here: ${mine.size} (${table.icann.length} ICANN-shaped, ${table.private.length} private-shaped)`)
console.log(`  beyond the real list: ${beyond.length}, of which ${unrecorded.length} unrecorded`)
console.log(`\nagainst the ${hosts.length} hosts of the shipped feed:`)
console.log(`  findings lost to a missing private suffix: ${lost.length}`)
console.log(`  platforms a missing private apex would block: ${outages.length}`)

for (const host of lost.slice(0, 10)) console.log(`    lost: ${host}`)
for (const host of outages) console.error(`    OUTAGE RISK: ${host} is a private apex this table does not know`)
for (const suffix of unrecorded) console.error(`    UNRECORDED: ${suffix} is not in the real list and not in beyondThePublicSuffixList`)
for (const suffix of goneStale) console.error(`    NO LONGER AN ADDITION: ${suffix} is in the real list now — move it out of beyondThePublicSuffixList`)

if (outages.length > 0 || unrecorded.length > 0 || goneStale.length > 0) {
  console.error(
    '\n  Refusing. An outage risk is a platform this extension would block for every user;' +
      '\n  an unrecorded divergence is one a future sync deletes without knowing why.\n',
  )
  process.exit(1)
}
console.log('\n  OK — the divergence is the one recorded in suffixes.json, and nothing is at risk.\n')
