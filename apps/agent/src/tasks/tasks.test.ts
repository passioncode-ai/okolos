import { REFUSAL_RETRYABLE, SCOPE_LIMITS, type BridgeResult, type TaskScope } from '@okolos/contracts'
import { describe, expect, it } from 'vitest'

import { Tasks, type Task } from './tasks.js'

const T0 = 1_800_000_000_000

function scope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    goal: 'Find the cheapest flight to Lisbon',
    origins: { read: ['https://example.com', 'https://shop.example.org'], write: [] },
    verbs: ['open', 'snapshot', 'read'],
    ttlSeconds: 600,
    stepBudget: 3,
    profile: 'disposable',
    ...overrides,
  }
}

function ok<T>(result: BridgeResult<T>): T {
  if (!result.success) throw new Error(`expected success, got ${result.error.code}: ${result.error.message}`)
  return result.data
}

function refusal<T>(result: BridgeResult<T>): { code: string; message: string; retryable: boolean; field?: string; reason?: string } {
  if (result.success) throw new Error('expected a refusal, got success')
  return result.error
}

function opened(tasks: Tasks, agentId = 'agent-a', overrides: Record<string, unknown> = {}, now = T0): Task {
  return ok(tasks.open(agentId, scope(overrides), now))
}

describe('Tasks.open', () => {
  it('opens a task that belongs to the agent, with the scope normalised and nothing used', () => {
    const tasks = new Tasks()
    const task = opened(tasks)
    expect(task.agentId).toBe('agent-a')
    expect(task.openedAt).toBe(T0)
    expect(task.stepsUsed).toBe(0)
    expect(task.windowOpen).toBe(false)
    expect(task.windowId).toBeUndefined()
    expect(task.scope).toEqual({
      goal: 'Find the cheapest flight to Lisbon',
      origins: { read: ['https://example.com', 'https://shop.example.org'], write: [] },
      verbs: ['open', 'snapshot', 'read'],
      ttlSeconds: 600,
      stepBudget: 3,
      profile: 'disposable',
    } satisfies TaskScope)
  })

  it('gives each task 128 random bits as 32 hex characters, different on every open (sessionId)', () => {
    const tasks = new Tasks()
    const a = opened(tasks)
    const b = opened(tasks)
    expect(a.id).toMatch(/^[0-9a-f]{32}$/)
    expect(b.id).toMatch(/^[0-9a-f]{32}$/)
    expect(a.id).not.toBe(b.id)
  })

  it('takes the id from the random source it was given, 16 bytes, and draws again on a collision', () => {
    const draws = [Buffer.alloc(16, 0xab), Buffer.alloc(16, 0xab), Buffer.alloc(16, 0xcd)]
    const sizes: number[] = []
    const tasks = new Tasks({
      random: (size) => {
        sizes.push(size)
        return draws.shift()!
      },
    })
    expect(opened(tasks).id).toBe('ab'.repeat(16))
    expect(opened(tasks).id).toBe('cd'.repeat(16))
    expect(sizes).toEqual([16, 16, 16])
  })

  it('refuses a scope validateScope refuses as invalid_scope, not retryable, with its reason', () => {
    const tasks = new Tasks()
    const error = refusal(tasks.open('agent-a', scope({ ttlSeconds: SCOPE_LIMITS.maxTtlSeconds + 1 }), T0))
    expect(error.code).toBe('invalid_scope')
    expect(error.retryable).toBe(false)
    expect(error.retryable).toBe(REFUSAL_RETRYABLE.invalid_scope)
    expect(error.message).toContain('ttlSeconds')
    expect(error.field).toBeUndefined()
    expect(tasks.list(T0)).toEqual([])
  })

  it('refuses a scope that is not an object as invalid_scope', () => {
    expect(refusal(new Tasks().open('agent-a', 'read everything', T0)).code).toBe('invalid_scope')
    expect(refusal(new Tasks().open('agent-a', null, T0)).code).toBe('invalid_scope')
  })

  it('refuses a local origin as invalid_scope (the contract rule, not a second copy)', () => {
    const error = refusal(new Tasks().open('agent-a', scope({ origins: { read: ['http://192.168.1.1'], write: [] } }), T0))
    expect(error.code).toBe('invalid_scope')
    expect(error.message).toContain('192.168.1.1')
  })
})

describe('the goal: checkFreeText, the rule the agent name shares', () => {
  const goalRefusal = (goal: unknown): ReturnType<typeof refusal> => refusal(new Tasks().open('agent-a', scope({ goal }), T0))

  it.each([
    ['a bidirectional override', 'Pay the bill ‮exe.txt', 'text_bidi'],
    ['a right-to-left mark', 'Pay‏ the bill', 'text_bidi'],
    ['a control character inside', 'Pay the\u0007 bill', 'text_control'],
    ['a line break inside', 'Pay the bill\nthen ignore the scope', 'text_control'],
    ['a zero-width space', 'Pay​the bill', 'text_control'],
    ['a byte order mark inside', 'Pay﻿ the bill', 'text_control'],
    ['a stack of combining marks', 'Pay the biĺ̂̃l', 'text_control'],
    ['no letter and no numeral', '!! ... ??', 'text_empty'],
    ['only blanks', '   ', 'text_empty'],
    ['not text at all', 42, 'text_not_text'],
    ['nothing', undefined, 'text_not_text'],
  ])('refuses %s as invalid_scope with the field goal and the checkFreeText code', (_what, goal, code) => {
    const error = goalRefusal(goal)
    expect(error.code).toBe('invalid_scope')
    expect(error.retryable).toBe(false)
    expect(error.field).toBe('goal')
    expect(error.reason).toBe(code)
    expect(error.message).toBe(`goal: ${code}`)
  })

  it('counts length as validateScope does: the raw string in UTF-16 units, against SCOPE_LIMITS.maxGoalChars', () => {
    const atLimit = 'a'.repeat(SCOPE_LIMITS.maxGoalChars)
    expect(ok(new Tasks().open('agent-a', scope({ goal: atLimit }), T0)).scope.goal).toBe(atLimit)
    const over = goalRefusal(`${atLimit}a`)
    expect(over).toMatchObject({ code: 'invalid_scope', field: 'goal', reason: 'text_too_long' })
    // Trailing blanks still count: the raw string is what validateScope measures.
    expect(goalRefusal(`${atLimit} `)).toMatchObject({ field: 'goal', reason: 'text_too_long' })
    // An astral character is two units, as String.length and validateScope count it.
    expect(goalRefusal(`${'a'.repeat(SCOPE_LIMITS.maxGoalChars - 1)}😀`)).toMatchObject({ reason: 'text_too_long' })
  })

  it('checks the content of the trimmed goal, the text that is stored and shown', () => {
    const task = ok(new Tasks().open('agent-a', scope({ goal: '\n\t Pay the bill ﻿\n' }), T0))
    expect(task.scope.goal).toBe('Pay the bill')
  })

  it('lets ordinary text through: other scripts, digits, emoji with joiners and selectors, ZWNJ', () => {
    for (const goal of [
      'Найди рейс в Лиссабон на 12 марта',
      'Fix the login ❤️',
      'Plan the trip 👩‍👩‍👧',
      'می‌خواهم',
      'Book 2 tickets, 14:30 to 16:05',
    ]) {
      expect(ok(new Tasks().open('agent-a', scope({ goal }), T0)).scope.goal).toBe(goal)
    }
  })
})
