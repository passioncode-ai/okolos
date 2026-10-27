/**
 * Tasks of Okolos Agent (spec 2026-10-06 Б1 §2.1, §2.3; REQ-59): what an agent may reach, for how
 * long and for how many calls.
 *
 * A task is born from the scope the agent sent with `session.open`, belongs to the agent that
 * opened it, and is named by 128 random bits (`SessionOpenResult.sessionId` is `Task.id`). Every
 * later call names the task, is checked against it and costs one step, refused or not (§2.3), so an
 * agent that keeps retrying a refusal runs out of budget instead of probing forever. `close` is the
 * exception: it only gives back the window and the processes the task holds, so it is never charged
 * and never refused for an exhausted budget.
 *
 * The table lives in memory; the daemon owns the clock and passes `now` (milliseconds since the
 * epoch) into every call that asks whether a task is still alive. Nothing here reads the time.
 */

import { randomBytes } from 'node:crypto'

import { SCOPE_LIMITS, refuse, validateScope, type BridgeError, type BridgeResult, type TaskScope } from '@okolos/contracts'

import { checkFreeText, type FreeTextRefusal } from '../pairing/name.js'

/** One open task. `scope`, `id`, `agentId`, `openedAt` never change; `stepsUsed` only grows. */
export interface Task {
  /** 128 random bits as 32 lower-case hex characters; the `sessionId` the agent names the task by. */
  readonly id: string
  readonly agentId: string
  /** The scope as `validateScope` normalised it, the goal trimmed. */
  readonly scope: TaskScope
  /** `now` at `open`, in milliseconds since the epoch. */
  readonly openedAt: number
  /** Calls charged so far, refused ones included; at most `scope.stepBudget`. */
  readonly stepsUsed: number
  /** The CDP targetId of the task's window (`SessionOpenResult.windowId`), once N-011 has opened it. */
  windowId?: string
  /** Whether the task's window is open (SCR-24 taskWindowOpen / taskWindowClosed); N-011 sets it from N-010's window events. */
  windowOpen: boolean
}

/** A refusal of the goal: `invalid_scope`, naming the field and the `checkFreeText` code. */
export interface GoalRefusal extends BridgeError {
  readonly code: 'invalid_scope'
  readonly field: 'goal'
  readonly reason: FreeTextRefusal
}

/** What `open` answers: a task, or a refusal; a refusal of the goal carries `field` and `reason`. */
export type OpenTaskResult = BridgeResult<Task> | { readonly success: false; readonly error: GoalRefusal }

/** Bytes behind a task id. */
const ID_BYTES = 16

export type RandomSource = (size: number) => Uint8Array

export interface TasksOptions {
  /** Where task ids come from; `crypto.randomBytes` unless a test gives another. */
  readonly random?: RandomSource
}

interface TaskRecord extends Task {
  stepsUsed: number
}

/**
 * Why the goal cannot be shown, or null. Decided here, stated once: the length is the raw string's,
 * in UTF-16 units against `SCOPE_LIMITS.maxGoalChars`, exactly what `validateScope` measures, so
 * the two never disagree about "too long"; the content is checked on the trimmed goal, which is the
 * text the task stores and the page shows, so blanks and line breaks around it (which `trim` takes
 * away) are no reason to refuse, and anything left inside is. `checkFreeText` is the rule the agent
 * name shares, without the name's allowlist and digit rule.
 */
function goalFault(goal: unknown): FreeTextRefusal | null {
  if (typeof goal !== 'string') return 'text_not_text'
  if (goal.length > SCOPE_LIMITS.maxGoalChars) return 'text_too_long'
  return checkFreeText(goal.trim(), SCOPE_LIMITS.maxGoalChars)
}

export class Tasks {
  private readonly random: RandomSource
  private readonly table = new Map<string, TaskRecord>()

  constructor(options: TasksOptions = {}) {
    this.random = options.random ?? randomBytes
  }

  /**
   * Opens a task for `agentId` from what the agent sent. The goal is checked first, so a goal the
   * page cannot show is refused as `invalid_scope` with `field: 'goal'` and the `checkFreeText` code
   * (the agent can act on it); every other fault is `validateScope`'s reason.
   */
  open(agentId: string, scopeInput: unknown, now: number): OpenTaskResult {
    if (typeof scopeInput === 'object' && scopeInput !== null) {
      const fault = goalFault((scopeInput as Record<string, unknown>).goal)
      if (fault !== null) {
        const refused = refuse('invalid_scope', `goal: ${fault}`)
        return { success: false, error: { ...refused.error, code: 'invalid_scope', field: 'goal', reason: fault } }
      }
    }
    const checked = validateScope(scopeInput)
    if (!checked.ok) return refuse('invalid_scope', checked.reason)

    const task: TaskRecord = { id: this.newId(), agentId, scope: checked.scope, openedAt: now, stepsUsed: 0, windowOpen: false }
    this.table.set(task.id, task)
    return { success: true, data: task }
  }

  /** The tasks still alive at `now`, oldest first. */
  list(now: number): Task[] {
    return [...this.table.values()].filter((task) => !expired(task, now))
  }

  private newId(): string {
    for (;;) {
      const id = Buffer.from(this.random(ID_BYTES)).toString('hex')
      if (!this.table.has(id)) return id
    }
  }
}

/** A task is over once `ttlSeconds` have passed since it opened: at `openedAt + ttl` it is already expired. */
function expired(task: Task, now: number): boolean {
  return now >= task.openedAt + task.scope.ttlSeconds * 1000
}
