import { describe, test } from 'vitest'

import { buildRules, RULE_LIMIT } from './rules.js'
import type { FeedSnapshot } from './apply.js'

/**
 * How long it takes to turn a feed into blocking rules.
 *
 * REQ-09 named "rules ≤5 ms" as an acceptance criterion and nothing measured it: there
 * were no benchmark files at all, and `pnpm bench` exited 1 (B-49). This is the path the
 * number was about — it runs on every accepted feed update and on every change to the
 * exception list, which is every time a person marks a site legitimate.
 *
 * It reports rather than gates, for the reason `stage1.bench.ts` gives: a wall-clock
 * ceiling in CI is a flake, and this project keeps those out of the gate chain
 * deliberately.
 */

const feed = (entries: number): FeedSnapshot => ({
  name: 'phishing',
  version: 7,
  updatedAt: '2026-08-20T00:00:00.000Z',
  // Distinct hosts, because a list of duplicates measures the deduplicator and nothing
  // else — and a real feed is distinct by construction.
  entries: Array.from({ length: entries }, (_, index) => `bad-${index}.example.test`),
})

describe('turning a feed into blocking rules', () => {
  const typical = feed(2000)
  // At the limit, where the slice is doing real work and every entry has been considered.
  const atLimit = feed(RULE_LIMIT)
  // Over it: the case that decides what gets dropped, which is the expensive branch.
  const over = feed(RULE_LIMIT * 2)
  const exceptions = Array.from({ length: 50 }, (_, index) => `trusted-${index}.example.test`)

  test('2000 entries, no exceptions', async ({ bench }) => {
    await bench('2000 entries, no exceptions', () => {
      buildRules(typical, [], '/blocked')
    }).run()
  })

  test('5000 entries at the rule limit', async ({ bench }) => {
    await bench('5000 entries at the rule limit', () => {
      buildRules(atLimit, [], '/blocked')
    }).run()
  })

  test('10000 entries, over the limit', async ({ bench }) => {
    await bench('10000 entries, over the limit', () => {
      buildRules(over, [], '/blocked')
    }).run()
  })

  test('5000 entries with 50 exceptions', async ({ bench }) => {
    await bench('5000 entries with 50 exceptions', () => {
      buildRules(atLimit, exceptions, '/blocked')
    }).run()
  })
})
