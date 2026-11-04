import { decideAction } from '@okolos/contracts'
import type { Evidence, HiddenTextCandidate, PageCandidates, Verdict } from '@okolos/contracts'

import type { DetectContext } from './stage1.js'

/**
 * Stage 3 — the classifier, and the conditions under which it is allowed to
 * run at all.
 *
 * The interesting part of this stage is not the model. It is the gate. Running
 * inference on every page would cost a quarter of a second of someone's
 * browsing for nothing, and running it on text a deterministic rule already
 * decided would pay that price to learn what is already known. So it runs in
 * exactly one situation: hidden text exists (stage 1 fired) and no rule matched
 * it (stage 2 was silent). That is the only place a model can tell us something
 * the earlier stages cannot.
 *
 * Its verdicts are capped at `inform` by the ladder, not by this file. A score
 * cannot be checked by the person it affects, so it may raise suspicion and
 * never act.
 */

/**
 * Supplied by whatever context runs a model. None ships today (ADR-0006, B-131); the
 * library host is `createInferenceHost` in `@okolos/model`, and nothing wires it.
 */
export interface InferenceHost {
  /** False when the model is absent or the device cannot run it. */
  available(): boolean
  /** Probability that the text is an instruction planted for a model. */
  score(text: string): Promise<number>
}

export interface ClassifyOptions {
  /** Anything slower is abandoned: a warning that arrives late is not a warning. */
  readonly timeoutMs: number
  /** Ceiling on how much one page may cost. */
  readonly maxCandidates: number
}

const DEFAULTS: ClassifyOptions = { timeoutMs: 250, maxCandidates: 8 }

/** Below this the model is not confident enough to be worth a person's attention. */
const REPORT_THRESHOLD = 0.75

export async function classifyUndecided(
  page: PageCandidates,
  decidedLocators: readonly string[],
  host: InferenceHost,
  ctx: DetectContext,
  options: Partial<ClassifyOptions> = {},
): Promise<Verdict[]> {
  const opts = { ...DEFAULTS, ...options }

  if (page.candidates.length === 0) return []
  if (!host.available()) return []

  const decided = new Set(decidedLocators)
  const undecided = page.candidates
    .filter((candidate) => !decided.has(candidate.locator))
    .slice(0, opts.maxCandidates)

  if (undecided.length === 0) return []

  const verdicts: Verdict[] = []
  for (const candidate of undecided) {
    const score = await scoreWithin(host, candidate, opts.timeoutMs)
    if (score === null || score < REPORT_THRESHOLD) continue
    verdicts.push(toVerdict(page, candidate, score, ctx))
  }
  return verdicts
}

/**
 * A model that fails or hangs produces silence, never an exception and never a
 * block. The deterministic stages have already had their say; this one is an
 * addition, and an addition that breaks the page would be worse than absent.
 */
async function scoreWithin(
  host: InferenceHost,
  candidate: HiddenTextCandidate,
  timeoutMs: number,
): Promise<number | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs)
  })

  try {
    return await Promise.race([host.score(candidate.text), timeout])
  } catch {
    return null
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function toVerdict(
  page: PageCandidates,
  candidate: HiddenTextCandidate,
  score: number,
  ctx: DetectContext,
): Verdict {
  const evidence: Evidence = {
    kind: 'hidden-text',
    stage: 'model',
    locator: candidate.locator,
    snippet: candidate.text.slice(0, 200),
    detail: {
      // The score is shown to the user, because a finding they cannot argue
      // with is a finding they can only obey or ignore.
      score: Math.round(score * 100) / 100,
      concealment: candidate.concealment.join(','),
      carrier: candidate.carrier,
      partialScan: page.truncated,
    },
  }

  const confidence = 'medium' as const
  return {
    id: ctx.newId(),
    subject: { kind: 'page', ref: page.url },
    category: 'injection',
    severity: 'minor',
    confidence,
    evidence: [evidence],
    action: decideAction({ confidence, evidence: [evidence] }),
    sources: [{ name: 'stage:model', version: '1', updatedAt: ctx.now }],
    createdAt: ctx.now,
  }
}
