import { readFileSync } from 'node:fs'

import { REFUSAL_RETRYABLE, SCOPE_LIMITS, type BridgeResult, type TaskScope } from '@okolos/contracts'
import { describe, expect, it } from 'vitest'

import { GOAL_SHOWN_MAX, Tasks, checkLanded, goalShown, type Task, type TaskSnapshot } from './tasks.js'

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

/** What `list` shows of `task`: its fields as they are now, and whether its time has run out. */
function listed(task: Task, expired = false): TaskSnapshot {
  return { ...task, expired }
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

describe('Tasks.get', () => {
  it('returns the task to the agent that opened it', () => {
    const tasks = new Tasks()
    const task = opened(tasks)
    expect(ok(tasks.get('agent-a', task.id, T0 + 1000))).toBe(task)
  })

  it('refuses an id no task has as no_such_task, not retryable', () => {
    const error = refusal(new Tasks().get('agent-a', 'f'.repeat(32), T0))
    expect(error.code).toBe('no_such_task')
    expect(error.retryable).toBe(false)
  })

  it("refuses another agent's task as no_such_task, the same answer as an id that does not exist (ревью F8)", () => {
    const tasks = new Tasks()
    const task = opened(tasks, 'agent-a')
    const foreign = refusal(tasks.get('agent-b', task.id, T0))
    const missing = refusal(tasks.get('agent-b', 'f'.repeat(32), T0))
    expect(foreign.code).toBe('no_such_task')
    expect(foreign).toEqual(missing)
    expect(foreign.message).not.toContain(task.id)
    expect(foreign.message).not.toContain('agent-a')
  })

  it('refuses a task whose ttl has run out as task_expired, from openedAt + ttlSeconds on', () => {
    const tasks = new Tasks()
    const task = opened(tasks, 'agent-a', { ttlSeconds: 60 })
    expect(ok(tasks.get('agent-a', task.id, T0 + 59_999)).id).toBe(task.id)
    const error = refusal(tasks.get('agent-a', task.id, T0 + 60_000))
    expect(error.code).toBe('task_expired')
    expect(error.retryable).toBe(false)
    expect(tasks.list(T0 + 60_000)).toEqual([listed(task, true)])
  })

  it("answers no_such_task, not task_expired, for another agent's expired task", () => {
    const tasks = new Tasks()
    const task = opened(tasks, 'agent-a', { ttlSeconds: 60 })
    expect(refusal(tasks.get('agent-b', task.id, T0 + 120_000)).code).toBe('no_such_task')
  })
})

describe('Tasks.charge', () => {
  it('charges one step for an allowed call inside the task', () => {
    const tasks = new Tasks()
    const task = opened(tasks)
    expect(tasks.charge(task, 'open', T0, 'https://example.com/flights?to=LIS')).toEqual({ success: true, data: undefined })
    expect(tasks.charge(task, 'snapshot', T0)).toEqual({ success: true, data: undefined })
    expect(task.stepsUsed).toBe(2)
  })

  it('refuses a verb the task did not name as verb_not_in_task, and charges the step', () => {
    const tasks = new Tasks()
    const task = opened(tasks, 'agent-a', { verbs: ['open'] })
    const error = refusal(tasks.charge(task, 'read', T0))
    expect(error.code).toBe('verb_not_in_task')
    expect(error.retryable).toBe(false)
    expect(task.stepsUsed).toBe(1)
  })

  it('refuses a URL outside origins.read as origin_not_in_task, and charges the step', () => {
    const tasks = new Tasks()
    const task = opened(tasks, 'agent-a', { stepBudget: 10 })
    for (const url of ['https://evil.example.net/', 'http://example.com/', 'https://example.com:8443/', 'https://sub.example.com/', 'file:///etc/passwd', 'not a url']) {
      expect(refusal(tasks.charge(task, 'open', T0, url)).code).toBe('origin_not_in_task')
    }
    expect(refusal(tasks.charge(task, 'open', T0, 'https://evil.example.net/')).retryable).toBe(false)
    expect(task.stepsUsed).toBe(7)
  })

  it('refuses the call after the last step as budget_exhausted, and the count stays at the budget', () => {
    const tasks = new Tasks()
    const task = opened(tasks, 'agent-a', { stepBudget: 2 })
    ok(tasks.charge(task, 'snapshot', T0))
    ok(tasks.charge(task, 'snapshot', T0))
    const error = refusal(tasks.charge(task, 'snapshot', T0))
    expect(error.code).toBe('budget_exhausted')
    expect(error.retryable).toBe(false)
    expect(refusal(tasks.charge(task, 'open', T0, 'https://evil.example.net/')).code).toBe('budget_exhausted')
    expect(task.stepsUsed).toBe(2)
  })

  it('a refusal spends a step too: refused calls alone exhaust the budget (spec §2.3)', () => {
    const tasks = new Tasks()
    const task = opened(tasks, 'agent-a', { stepBudget: 2, verbs: ['open'] })
    expect(refusal(tasks.charge(task, 'read', T0)).code).toBe('verb_not_in_task')
    expect(refusal(tasks.charge(task, 'open', T0, 'https://evil.example.net/')).code).toBe('origin_not_in_task')
    expect(task.stepsUsed).toBe(2)
    expect(refusal(tasks.charge(task, 'open', T0, 'https://example.com/')).code).toBe('budget_exhausted')
  })

  it('the fragment of a URL does not change the origin check', () => {
    const tasks = new Tasks()
    const task = opened(tasks)
    ok(tasks.charge(task, 'open', T0, 'https://example.com/page#https://evil.example.net/'))
    ok(tasks.charge(task, 'open', T0, 'https://shop.example.org/#'))
    expect(refusal(tasks.charge(task, 'open', T0, 'https://evil.example.net/#https://example.com')).code).toBe('origin_not_in_task')
  })

  it('close is never charged and never refused, not even with every step used or unnamed in verbs', () => {
    const tasks = new Tasks()
    const task = opened(tasks, 'agent-a', { stepBudget: 1, verbs: ['snapshot'] })
    ok(tasks.charge(task, 'snapshot', T0))
    expect(refusal(tasks.charge(task, 'snapshot', T0)).code).toBe('budget_exhausted')
    expect(tasks.charge(task, 'close', T0)).toEqual({ success: true, data: undefined })
    expect(task.stepsUsed).toBe(1)
  })

  it('refuses a task that is no longer in the table as no_such_task, without charging it', () => {
    const tasks = new Tasks()
    const task = opened(tasks)
    tasks.closeAllOf('agent-a')
    expect(refusal(tasks.charge(task, 'snapshot', T0)).code).toBe('no_such_task')
    expect(task.stepsUsed).toBe(0)
  })

  it('refuses a copy of a task that is not the one in the table as no_such_task', () => {
    const tasks = new Tasks()
    const task = opened(tasks)
    const forged = { ...task, stepsUsed: 0, scope: { ...task.scope, stepBudget: 500 } }
    expect(refusal(tasks.charge(forged, 'snapshot', T0)).code).toBe('no_such_task')
  })
})

describe('checkLanded: where the navigation actually ended (ревью F9, аудит #39)', () => {
  it('passes a landing inside origins.read', () => {
    const task = opened(new Tasks())
    expect(checkLanded(task, 'https://shop.example.org/cart?id=7')).toEqual({ success: true, data: undefined })
  })

  it('refuses a landing outside origins.read as origin_not_in_task, a redirect included', () => {
    const task = opened(new Tasks())
    for (const url of ['https://evil.example.net/login', 'http://example.com/', 'about:blank', 'chrome-error://chromewebdata/', '']) {
      const error = refusal(checkLanded(task, url))
      expect(error.code).toBe('origin_not_in_task')
      expect(error.retryable).toBe(false)
    }
  })

  it('ignores the fragment of the URL it landed on', () => {
    const task = opened(new Tasks())
    ok(checkLanded(task, 'https://example.com/#evil.example.net'))
    expect(refusal(checkLanded(task, 'https://evil.example.net/#https://example.com')).code).toBe('origin_not_in_task')
  })

  it('charges nothing: the open that navigated was the step', () => {
    const tasks = new Tasks()
    const task = opened(tasks)
    checkLanded(task, 'https://evil.example.net/')
    expect(task.stepsUsed).toBe(0)
  })
})

describe('Tasks.close and closeAllOf', () => {
  it('close removes the task and returns it, so the caller closes its window', () => {
    const tasks = new Tasks()
    const task = opened(tasks)
    const other = opened(tasks)
    expect(ok(tasks.close('agent-a', task.id))).toBe(task)
    expect(refusal(tasks.get('agent-a', task.id, T0)).code).toBe('no_such_task')
    expect(tasks.list(T0)).toEqual([listed(other)])
  })

  it('close works on a task that used all its steps, and on one whose time ran out', () => {
    const tasks = new Tasks()
    const spent = opened(tasks, 'agent-a', { stepBudget: 1 })
    ok(tasks.charge(spent, 'snapshot', T0))
    expect(refusal(tasks.charge(spent, 'snapshot', T0)).code).toBe('budget_exhausted')
    expect(ok(tasks.close('agent-a', spent.id)).stepsUsed).toBe(1)
    const late = opened(tasks, 'agent-a', { ttlSeconds: 1 })
    expect(refusal(tasks.get('agent-a', late.id, T0 + 5_000)).code).toBe('task_expired')
    expect(ok(tasks.close('agent-a', late.id)).id).toBe(late.id)
  })

  it("close of another agent's task is no_such_task and leaves it open", () => {
    const tasks = new Tasks()
    const task = opened(tasks, 'agent-a')
    expect(refusal(tasks.close('agent-b', task.id)).code).toBe('no_such_task')
    expect(ok(tasks.get('agent-a', task.id, T0)).id).toBe(task.id)
  })

  it('closeAllOf closes every task of one agent, and only of that agent, and returns them', () => {
    const tasks = new Tasks()
    const a1 = opened(tasks, 'agent-a')
    const b1 = opened(tasks, 'agent-b')
    const a2 = opened(tasks, 'agent-a')
    expect(tasks.closeAllOf('agent-a')).toEqual([a1, a2])
    expect(tasks.list(T0)).toEqual([listed(b1)])
    expect(refusal(tasks.get('agent-a', a1.id, T0)).code).toBe('no_such_task')
    expect(tasks.closeAllOf('agent-a')).toEqual([])
  })
})

describe('Tasks.list and sweep', () => {
  it('list gives the tasks of every agent, oldest first, with what the page row needs', () => {
    const tasks = new Tasks()
    const a = opened(tasks, 'agent-a', {}, T0)
    const b = opened(tasks, 'agent-b', { ttlSeconds: 30 }, T0 + 1_000)
    expect(tasks.list(T0 + 2_000)).toEqual([listed(a), listed(b)])
    // Round 2: a task whose time ran out stays in the list, marked expired, until sweep removes it.
    expect(tasks.list(T0 + 31_000)).toEqual([listed(a), listed(b, true)])
  })

  // Fix round 2 (spec §2.1, SCR-24 taskTimeOver): the page keeps an expired task in its list until
  // the timer closes its window, so list shows it with expired true; get and charge still refuse it.
  it('an expired task not yet swept is listed with expired true and its window as set', () => {
    const tasks = new Tasks()
    const task = opened(tasks, 'agent-a', { ttlSeconds: 10 })
    ok(tasks.setWindow(task, { windowId: 'TARGET-1', windowOpen: true }))
    const [shown] = tasks.list(T0 + 20_000)
    expect(shown).toEqual({ ...task, windowId: 'TARGET-1', windowOpen: true, expired: true })
    expect(shown!.expired).toBe(true)
    expect(shown!.windowOpen).toBe(true)
    expect(Object.isFrozen(shown)).toBe(true)
    expect(refusal(tasks.get('agent-a', task.id, T0 + 20_000)).code).toBe('task_expired')
    expect(refusal(tasks.charge(task, 'snapshot', T0 + 20_000)).code).toBe('task_expired')
  })

  it('after sweep the expired task is gone from the list', () => {
    const tasks = new Tasks()
    const task = opened(tasks, 'agent-a', { ttlSeconds: 10 })
    expect(tasks.list(T0 + 20_000)).toEqual([listed(task, true)])
    expect(tasks.sweep(T0 + 20_000)).toEqual([task])
    expect(tasks.list(T0 + 20_000)).toEqual([])
  })

  it('a task whose time has not run out is listed with expired false', () => {
    const tasks = new Tasks()
    const task = opened(tasks, 'agent-a', { ttlSeconds: 10 })
    expect(tasks.list(T0)[0]!.expired).toBe(false)
    expect(tasks.list(T0 + 9_999)).toEqual([listed(task, false)])
  })

  it('the boundary instant openedAt + ttlSeconds * 1000 is already expired in the list', () => {
    const tasks = new Tasks()
    const task = opened(tasks, 'agent-a', { ttlSeconds: 10 }, T0 + 5)
    expect(tasks.list(T0 + 5 + 9_999)[0]!.expired).toBe(false)
    expect(tasks.list(T0 + 5 + 10_000)).toEqual([listed(task, true)])
    expect(refusal(tasks.get('agent-a', task.id, T0 + 5 + 10_000)).code).toBe('task_expired')
  })

  it('sweep removes the tasks whose time ran out and returns them, so their windows are closed', () => {
    const tasks = new Tasks()
    const short = opened(tasks, 'agent-a', { ttlSeconds: 10 })
    const long = opened(tasks, 'agent-b', { ttlSeconds: 600 })
    expect(tasks.sweep(T0 + 9_999)).toEqual([])
    expect(tasks.sweep(T0 + 10_000)).toEqual([short])
    expect(refusal(tasks.get('agent-a', short.id, T0 + 10_000)).code).toBe('no_such_task')
    expect(tasks.list(T0 + 10_000)).toEqual([listed(long)])
  })
})

// Fix round 1 (cert N-009 r1, unit finding 1): what list and sweep give is a frozen copy, so the page
// that reads the list cannot charge a task, move its window fields or widen its scope.
describe('list and sweep give snapshots, not the tasks themselves', () => {
  it("charging a list() element is no_such_task and charges nothing, another agent's task included", () => {
    const tasks = new Tasks()
    const mine = opened(tasks, 'agent-a')
    const theirs = opened(tasks, 'agent-b')
    const [mineShown, theirsShown] = tasks.list(T0)
    expect(mineShown).toEqual(listed(mine))
    expect(mineShown).not.toBe(mine)
    expect(refusal(tasks.charge(mineShown!, 'snapshot', T0)).code).toBe('no_such_task')
    expect(refusal(tasks.charge(theirsShown!, 'snapshot', T0)).code).toBe('no_such_task')
    expect(ok(tasks.get('agent-a', mine.id, T0)).stepsUsed).toBe(0)
    expect(ok(tasks.get('agent-b', theirs.id, T0)).stepsUsed).toBe(0)
  })

  it('mutating a list() element throws and changes nothing in the table', () => {
    const tasks = new Tasks()
    const task = opened(tasks)
    const shown = tasks.list(T0)[0] as unknown as Record<string, unknown> & { scope: { stepBudget: number; origins: { read: string[] }; verbs: string[] } }
    expect(Object.isFrozen(shown)).toBe(true)
    expect(() => { shown.windowOpen = true }).toThrow(TypeError)
    expect(() => { shown.windowId = 'TARGET-X' }).toThrow(TypeError)
    expect(() => { shown.stepsUsed = 99 }).toThrow(TypeError)
    expect(() => { shown.agentId = 'agent-b' }).toThrow(TypeError)
    expect(() => { shown.scope.stepBudget = 500 }).toThrow(TypeError)
    expect(() => shown.scope.origins.read.push('https://evil.example.net')).toThrow(TypeError)
    expect(() => shown.scope.verbs.push('click')).toThrow(TypeError)
    const live = ok(tasks.get('agent-a', task.id, T0))
    expect(live).toMatchObject({ agentId: 'agent-a', windowOpen: false, stepsUsed: 0 })
    expect(live.windowId).toBeUndefined()
    expect(live.scope.stepBudget).toBe(3)
    expect(live.scope.origins.read).toEqual(['https://example.com', 'https://shop.example.org'])
    expect(refusal(tasks.charge(live, 'open', T0, 'https://evil.example.net/')).code).toBe('origin_not_in_task')
  })

  it('setWindow and checkLanded refuse a list() element as no_such_task', () => {
    const tasks = new Tasks()
    const task = opened(tasks)
    const shown = tasks.list(T0)[0]!
    expect(refusal(tasks.setWindow(shown, { windowId: 'TARGET-X', windowOpen: true })).code).toBe('no_such_task')
    expect(refusal(checkLanded(shown, 'https://example.com/')).code).toBe('no_such_task')
    expect(ok(tasks.get('agent-a', task.id, T0))).toMatchObject({ windowOpen: false })
  })

  it('a snapshot is a copy at the time of the call: later steps do not move it', () => {
    const tasks = new Tasks()
    const task = opened(tasks)
    const before = tasks.list(T0)[0]!
    ok(tasks.charge(task, 'snapshot', T0))
    expect(before.stepsUsed).toBe(0)
    expect(tasks.list(T0)[0]!.stepsUsed).toBe(1)
  })

  it('sweep gives frozen snapshots too', () => {
    const tasks = new Tasks()
    const task = opened(tasks, 'agent-a', { ttlSeconds: 10 })
    const [swept] = tasks.sweep(T0 + 10_000)
    expect(swept).toEqual(task)
    expect(swept).not.toBe(task)
    expect(Object.isFrozen(swept)).toBe(true)
    expect(Object.isFrozen(swept!.scope)).toBe(true)
  })
})

describe('setWindow: N-011 records the window of a task it got through get', () => {
  it('sets windowId and windowOpen on the live task, and list shows them', () => {
    const tasks = new Tasks()
    const task = opened(tasks)
    const live = ok(tasks.get('agent-a', task.id, T0))
    expect(tasks.setWindow(live, { windowId: 'TARGET-1', windowOpen: true })).toEqual({ success: true, data: undefined })
    expect(tasks.list(T0)[0]).toMatchObject({ windowId: 'TARGET-1', windowOpen: true })
    // The window closed: windowOpen alone moves, the id stays for the record.
    ok(tasks.setWindow(live, { windowOpen: false }))
    expect(tasks.list(T0)[0]).toMatchObject({ windowId: 'TARGET-1', windowOpen: false })
  })

  it('refuses a task no longer in the table, and a copy, as no_such_task', () => {
    const tasks = new Tasks()
    const task = opened(tasks)
    const copy = { ...task }
    expect(refusal(tasks.setWindow(copy, { windowOpen: true })).code).toBe('no_such_task')
    ok(tasks.close('agent-a', task.id))
    expect(refusal(tasks.setWindow(task, { windowOpen: true })).code).toBe('no_such_task')
    expect(task.windowOpen).toBe(false)
  })
})

// Fix round 1 (cert N-009 r1, seam finding 2): one clock contract with Pairing. A time that is not a
// whole non-negative ms would switch expiry off (NaN compares false), so it is never taken.
describe('the clock a caller passes', () => {
  const BAD = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, 1.5, 2 ** 53, '1' as unknown as number]

  it('open throws a TypeError on a time it cannot use, and opens nothing', () => {
    const tasks = new Tasks()
    for (const now of BAD) expect(() => tasks.open('agent-a', scope(), now), String(now)).toThrow(TypeError)
    expect(() => tasks.open('agent-a', scope(), Number.NaN)).toThrow(/^Tasks\.open: now must be a safe integer >= 0, got NaN$/)
    expect(tasks.list(T0)).toEqual([])
  })

  it('get, charge, list and sweep throw a TypeError on it before they act', () => {
    const tasks = new Tasks()
    const task = opened(tasks, 'agent-a', { ttlSeconds: 1 })
    for (const now of BAD) {
      const label = String(now)
      expect(() => tasks.get('agent-a', task.id, now), label).toThrow(TypeError)
      expect(() => tasks.charge(task, 'snapshot', now), label).toThrow(TypeError)
      expect(() => tasks.charge(task, 'close', now), label).toThrow(TypeError)
      expect(() => tasks.list(now), label).toThrow(TypeError)
      expect(() => tasks.sweep(now), label).toThrow(TypeError)
    }
    expect(() => tasks.get('agent-a', task.id, Number.POSITIVE_INFINITY)).toThrow(/^Tasks\.get: now must be a safe integer >= 0, got Infinity$/)
    expect(task.stepsUsed).toBe(0)
    expect(tasks.list(T0)).toEqual([listed(task)])
  })
})

// Fix round 1 (cert N-009 r1, seam finding 3): a gate passed after the person revoked the agent must
// not let page text out, so checkLanded asks whether the task is still open.
describe('checkLanded on a task that is no longer open', () => {
  it('refuses a closed task as no_such_task, even when the URL is inside', () => {
    const tasks = new Tasks()
    const task = opened(tasks)
    ok(tasks.close('agent-a', task.id))
    expect(refusal(checkLanded(task, 'https://example.com/')).code).toBe('no_such_task')
  })

  it('refuses a task of a revoked agent (closeAllOf) as no_such_task', () => {
    const tasks = new Tasks()
    const task = opened(tasks)
    tasks.closeAllOf('agent-a')
    expect(refusal(checkLanded(task, 'https://example.com/')).code).toBe('no_such_task')
  })

  it('refuses a swept task as no_such_task', () => {
    const tasks = new Tasks()
    const task = opened(tasks, 'agent-a', { ttlSeconds: 10 })
    tasks.sweep(T0 + 10_000)
    expect(refusal(checkLanded(task, 'https://example.com/')).code).toBe('no_such_task')
  })

  it('refuses a copy of a live task as no_such_task', () => {
    const tasks = new Tasks()
    const task = opened(tasks)
    expect(refusal(checkLanded({ ...task }, 'https://example.com/')).code).toBe('no_such_task')
    ok(checkLanded(task, 'https://example.com/'))
  })
})

// Fix round 1 (cert N-009 r1, unit finding 2): charge checks the ttl itself, so a caller that skipped
// get cannot spend a step on a task whose time ran out.
describe('charge checks the time', () => {
  it('refuses a task whose ttl has run out as task_expired, from openedAt + ttlSeconds on, without charging', () => {
    const tasks = new Tasks()
    const task = opened(tasks, 'agent-a', { ttlSeconds: 60 })
    ok(tasks.charge(task, 'snapshot', T0 + 59_999))
    const error = refusal(tasks.charge(task, 'snapshot', T0 + 60_000))
    expect(error.code).toBe('task_expired')
    expect(error.retryable).toBe(REFUSAL_RETRYABLE.task_expired)
    expect(refusal(tasks.charge(task, 'open', T0 + 60_000, 'https://evil.example.net/')).code).toBe('task_expired')
    expect(task.stepsUsed).toBe(1)
  })

  it('close is still neither charged nor refused on an expired task', () => {
    const tasks = new Tasks()
    const task = opened(tasks, 'agent-a', { ttlSeconds: 60 })
    expect(tasks.charge(task, 'close', T0 + 120_000)).toEqual({ success: true, data: undefined })
    expect(task.stepsUsed).toBe(0)
  })
})

// Fix round 1 (cert N-009 r1, unit finding 3): the id draw is bounded and takes only 16 bytes.
describe('the task id draw', () => {
  it('throws after a bounded number of draws when the random source keeps colliding, and opens nothing', () => {
    const sizes: number[] = []
    const tasks = new Tasks({
      random: (size) => {
        sizes.push(size)
        return Buffer.alloc(16, 0xab)
      },
    })
    const first = opened(tasks)
    expect(() => tasks.open('agent-a', scope(), T0)).toThrow(/^Tasks: no free task id after 8 draws$/)
    expect(sizes).toHaveLength(1 + 8)
    expect(tasks.list(T0)).toEqual([listed(first)])
  })

  it('throws when the random source gives other than 16 bytes, and opens nothing', () => {
    for (const bytes of [15, 0, 17]) {
      const tasks = new Tasks({ random: () => Buffer.alloc(bytes, 0xab) })
      expect(() => tasks.open('agent-a', scope(), T0), String(bytes)).toThrow(`Tasks: the random source gave ${bytes} bytes, 16 needed`)
      expect(tasks.list(T0)).toEqual([])
    }
  })
})

describe('the goal as the page shows it', () => {
  it(`keeps a goal of up to ${GOAL_SHOWN_MAX} visible characters as it is`, () => {
    expect(GOAL_SHOWN_MAX).toBe(200)
    expect(goalShown('Pay the bill')).toBe('Pay the bill')
    expect(goalShown('a'.repeat(200))).toBe('a'.repeat(200))
  })

  it('cuts a longer goal to 200 visible characters, the ellipsis included', () => {
    const shown = goalShown('a'.repeat(201))
    expect(shown).toBe(`${'a'.repeat(199)}…`)
    expect([...shown].length).toBe(200)
  })

  it('counts what a person sees: an emoji family or a letter with its marks is one character, never split', () => {
    const family = '👩‍👩‍👧'
    expect(goalShown(family.repeat(200))).toBe(family.repeat(200))
    const cut = goalShown(family.repeat(201))
    expect(cut).toBe(`${family.repeat(199)}…`)
    const accented = 'é'
    expect(goalShown(accented.repeat(201))).toBe(`${accented.repeat(199)}…`)
  })

  it('the page labels the goal as the agent\'s words in both locales (taskGoal)', () => {
    for (const [locale, words] of [['ru', 'словами агента'], ['en', "in the agent's words"]] as const) {
      const catalogue = JSON.parse(readFileSync(new URL(`../../_locales/${locale}/messages.json`, import.meta.url), 'utf8')) as Record<string, { message: string }>
      expect(catalogue.taskGoal?.message).toContain(words)
      expect(catalogue.taskGoal?.message).toContain('$GOAL$')
    }
  })
})

describe('the clock is the caller\'s', () => {
  it('tasks.ts never reads the time itself', () => {
    const source = readFileSync(new URL('./tasks.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/Date\.now|new Date\b|performance\.now|process\.hrtime/)
  })
})
