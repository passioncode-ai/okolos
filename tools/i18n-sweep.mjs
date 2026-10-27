#!/usr/bin/env node
/**
 * Which user-facing sentences the code still holds instead of asking the
 * catalogue for.
 *
 *   node tools/i18n-sweep.mjs          # the count, by file; exit 1 if any is unexplained
 *   node tools/i18n-sweep.mjs --list   # every hit, with its line
 *
 * **It refuses, and that is the point.** For its first weeks it printed a number
 * and exited 0 from every state, including three sentences outside the catalogue —
 * so it was a report, and a report nothing reads is a report nobody reads. A gate
 * that cannot refuse is a comment with a run time.
 *
 * **`i18n-exempt: <reason>`, at the site, with the reason.** Some of these strings
 * are not copy: a control-flow signal caught two frames up and rendered nowhere, a
 * programming mistake thrown at whoever holds the debugger. Marking them here — on
 * the line or in the three lines above it — keeps the decision beside the string
 * instead of in a central list that outlives every reason in it. A bare marker is
 * refused (an exemption with no reason is an allowlist wearing a comment's
 * clothes), and so is a marker that annotates nothing: when the string it covered
 * was catalogued or moved, the marker left behind is how the next one gets waved
 * through.
 *
 * **What it cannot see.** Untranslated copy also travels as *data*: a value
 * passed into a substitution (`since: 'the last seven days'`), and a field
 * stored on a record and rendered later (`payloadShape: 'none'`). Both looked
 * like arguments to this sweep and like English to the reader, and both were
 * found by looking at a screenshot rather than by counting. A number from here
 * is a floor, not a total.
 *
 * Half of that class has a shape now, and it is still invisible here. An argument that
 * is a message of ours travels as `{ messageKey: '…' }` and is resolved for whoever
 * reads the row rather than for whoever wrote it (B-77) — a *stored* argument was our
 * word frozen on the day of the write, which is the same defect one level down from the
 * sentence. `tools/locales.test.ts` sees that form, because a field ending in `Key` is
 * what it reads; this sweep counts quoted prose and neither knows nor should.
 *
 * It exists because the number kept being wrong. Four iterations reported 49,
 * 43, 36 and 15 remaining, each derived by a fresh throwaway regex, and every
 * one of them undercounted: the pattern required a capital first letter, and
 * the self-audit log's purpose lines — "downloading the list of known-bad
 * sites", "triggered by alarm:feeds" — start lowercase. The true figure when
 * this file was written is 44. A measurement re-invented per run is a guess
 * wearing a number's clothes.
 */
import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'

import { isComment, sentencesIn } from './i18n-pattern.mjs'
import { filesUnder } from './tree.mjs'

/**
 * Copy that is known, counted and not yet moved — with an owner.
 *
 * Widening the sweep to every package and to sentences that begin with a value found
 * 61 of them at once (B-51). Two dishonest ways out were available and both were
 * refused: marking them `i18n-exempt` would dress debt as a decision, which is the
 * allowlist-wearing-a-comment failure this file warns about; leaving the gate red
 * would make the one load-bearing gate of this project something to skip.
 *
 * So the debt is **recorded with a date and a rule**: exact match per file. More hits
 * than the entry is a regression and refuses; fewer means the debt was paid and the
 * number has to come down in the same change, which also refuses — a ceiling nobody
 * lowers is a ceiling that rots upward.
 */
const BASELINE = JSON.parse(
  readFileSync(path.join(import.meta.dirname, 'i18n-baseline.json'), 'utf8'),
)

const root = path.resolve(import.meta.dirname, '..')
/**
 * Everywhere a user-facing sentence can be written.
 *
 * It was `apps/extension/src` and `packages/ui/src`, which left every `core-*`
 * package unswept — and `core-recovery` holds the recovery checklist's own wording,
 * twenty-three sentences of it. A sweep whose roots are narrower than the product is
 * a floor pretending to be a total (B-51).
 */
/**
 * Every place the product keeps words a person will read.
 *
 * `apps/mail-cli/src` joined on 2026-09-11 with the app itself. A new surface
 * outside the sweep is the exact shape standing instruction 6 names: the defect
 * is an absence, and no amount of looking harder at the roots already listed
 * would find it. Adding the app and its gate in one change is the only version
 * of this that stays true.
 */
/*
 * `apps/agent/src` joined on 2026-10-27 with the daemon's service shell (Okolos Bridge Б1,
 * node N-005), for the same reason. The vendored Fabric kit under `apps/agent/src/fabric/` is
 * `.mjs` and is not read: this sweep reads `.ts`, and the kit's words are the kit's.
 */
const ROOTS = ['apps/extension/src', 'apps/mail-cli/src', 'apps/agent/src', 'packages']

/**
 * Three or more words with at least two lowercase ones after the first. Prose,
 * in other words — not an identifier, a role name or a key.
 *
 * **A leading interpolation is allowed, and that is the second half of B-51.** The
 * anchored form required a letter immediately after the quote, so every sentence that
 * begins with a value — `` `${outcome.gone} passages were not put back…` `` — was
 * invisible. Six in `packages/ui` and three on the restore banner itself, all of them
 * with English pluralisation that does not work in Russian, all of them shipping to a
 * ru-default interface.
 *
 * Still anchored, though: the first word must follow the interpolations, not appear
 * anywhere in the string. A pattern that matches prose *somewhere* sweeps up
 * `'data-role=x'` and selector soup, and a check that widens until it fails is not
 * stricter — it is broken.
 */
/**
 * Sources this sweep reads: `.ts` that ships. Not a test, not a benchmark.
 *
 * The walk is `tree.mjs`'s — twelve gates and four tools each wrote their own, and one
 * of them read a directory's *entries* as if they were its directories (B-58). The
 * filter stays here, because which files ship is this sweep's rule.
 *
 * `.bench.ts` joined `.test.ts` on 2026-08-20, when the first benchmarks were written
 * and this gate refused a push over their fixtures — a page of "ordinary text nobody is
 * trying to hide" and a `describe` label (B-49). Both kinds are found by a runner,
 * by name, and nothing in either reaches a person. The reachability gate needed the same
 * sentence on the same afternoon, which is the tell that "a file a runner loads" is a
 * category this repository has, and each gate had been spelling it out one suffix at a
 * time.
 */
function walk(dir) {
  return filesUnder(dir, '.ts').filter(
    (file) => !file.endsWith('.test.ts') && !file.endsWith('.bench.ts'),
  )
}

/** A reason long enough to be one. `i18n-exempt: no` explains nothing. */
const EXEMPT = /i18n-exempt:\s*(\S[^\n]{14,})/
const MARKER = /i18n-exempt:/

const hits = []
const exempt = []
/** Markers that cover no hit — an exemption that outlived its string. */
const stale = []
/** Markers whose reason is missing or too short to be one. */
const unreasoned = []
for (const base of ROOTS) {
  const dir = path.join(root, base)
  try {
    statSync(dir)
  } catch {
    continue
  }
  for (const file of walk(dir)) {
    const lines = readFileSync(file, 'utf8').split('\n')
    const relative = path.relative(root, file)
    /** Which marker lines were used by a hit, so the unused ones can be named. */
    const used = new Set()

    lines.forEach((line, index) => {
      if (isComment(line)) return
      for (const value of sentencesIn(line)) {
        // The line itself, or the three above it: a marker sits above the code it
        // explains as often as beside it, and a window of one made every reason a
        // trailing comment.
        const window = [index, index - 1, index - 2, index - 3].filter((n) => n >= 0)
        const markerAt = window.find((n) => MARKER.test(lines[n] ?? ''))
        const hit = { file: relative, line: index + 1, value }

        if (markerAt === undefined) {
          hits.push(hit)
          continue
        }
        used.add(markerAt)
        const reason = EXEMPT.exec(lines[markerAt] ?? '')
        if (reason === null) {
          unreasoned.push({ ...hit, marker: markerAt + 1 })
          continue
        }
        exempt.push({ ...hit, reason: reason[1].trim() })
      }
    })

    lines.forEach((line, index) => {
      if (MARKER.test(line) && !used.has(index)) {
        stale.push({ file: relative, line: index + 1 })
      }
    })
  }
}

const byFile = new Map()
for (const hit of hits) byFile.set(hit.file, (byFile.get(hit.file) ?? 0) + 1)

/** What the recorded ceiling allows, per file. */
const allowed = BASELINE.files ?? {}
const overBudget = []
const underBudget = []
for (const [file, count] of byFile) {
  const budget = allowed[file] ?? 0
  if (count > budget) overBudget.push({ file, count, budget })
}
for (const [file, budget] of Object.entries(allowed)) {
  const count = byFile.get(file) ?? 0
  if (count < budget) underBudget.push({ file, count, budget })
}

/** Hits that sit inside a recorded ceiling — debt, not a refusal. */
const recorded = hits.filter((hit) => (allowed[hit.file] ?? 0) > 0).length

if (process.argv.includes('--list')) {
  for (const hit of hits) {
    console.log(`${hit.file}:${hit.line}  ${JSON.stringify(hit.value.slice(0, 72))}`)
  }
  console.log('')
}

for (const [file, count] of [...byFile].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(count).padStart(3)}  ${file}`)
}
console.log(`\n${hits.length} sentence(s) in ${byFile.size} file(s) outside the catalogue`)
console.log(`${exempt.length} exempt, each with its reason at the site`)
console.log(
  `${recorded} recorded as debt in tools/i18n-baseline.json (measured ${BASELINE.measured}) — B-75 carries them`,
)

for (const hit of hits) {
  const budget = allowed[hit.file] ?? 0
  if (budget > 0) continue
  console.error(`  UNEXPLAINED ${hit.file}:${hit.line}  ${JSON.stringify(hit.value.slice(0, 64))}`)
}
for (const over of overBudget) {
  console.error(
    `  MORE THAN RECORDED ${over.file}: ${over.count} where ${over.budget} are recorded ` +
      `(tools/i18n-baseline.json, measured ${BASELINE.measured})`,
  )
}
for (const under of underBudget) {
  console.error(
    `  FEWER THAN RECORDED ${under.file}: ${under.count} where ${under.budget} are recorded — ` +
      `lower the number in tools/i18n-baseline.json in this change`,
  )
}
for (const hit of unreasoned) {
  console.error(
    `  NO REASON    ${hit.file}:${hit.marker}  marks ${JSON.stringify(hit.value.slice(0, 48))}`,
  )
}
for (const mark of stale) {
  console.error(`  MARKS NOTHING ${mark.file}:${mark.line}  no sentence within three lines below`)
}

/**
 * A hit inside a recorded ceiling is not a refusal; going over one is, and so is
 * coming under one without lowering it.
 */
const refusals =
  hits.length - recorded + unreasoned.length + stale.length + overBudget.length + underBudget.length
if (refusals > 0) {
  console.error(
    `\n  ${refusals} problem(s). A sentence a user reads belongs in _locales; one they cannot` +
      `\n  belongs beside an \`i18n-exempt: <reason>\` saying why.\n`,
  )
  process.exit(1)
}
/**
 * The closing line says what this tool can support, and no more.
 *
 * With the ledger empty it once claimed "every user-facing sentence is in the
 * catalogue". It cannot know that. Two classes of sentence used to defeat its own anchor
 * — a first word ending in a colon, and a quote nested inside a template substitution —
 * and both were found by reading, after this tool had called their files clean. Four live
 * strings were sitting in them (B-76, closed 2026-08-20: the anchor reads both now, and
 * `i18n-pattern.test.ts` keeps a case for each).
 *
 * The line stays hedged anyway, because one limit is structural rather than a bug: this
 * reads **quoted sentences in source**. Copy that travels as data — a value passed into
 * a substitution, a field stored on a record and rendered later — looks like an argument
 * from here and like English to the reader. Both real examples in the header were found
 * from a screenshot, not from a count.
 */
console.log(
  recorded === 0
    ? '\n  OK — no sentence outside the catalogue is written in the source.\n' +
        '  Copy passed as data is invisible here by construction; see the header of this file.\n'
    : `\n  OK — nothing new, and the ${recorded} recorded still owe a translation (B-75).\n` +
        '  This is not "every sentence is in the catalogue": it is "the debt did not grow".\n',
)
