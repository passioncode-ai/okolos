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

import {
  SCOPE_LIMITS,
  inScope,
  refuse,
  validateScope,
  verbAllowed,
  type BridgeError,
  type BridgeResult,
  type BridgeVerb,
  type TaskScope,
} from '@okolos/contracts'

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

  /**
   * The task `taskId` of `agentId`. Another agent's task is `no_such_task`, the same answer, word for
   * word, as an id no task has, so an agent learns nothing about tasks it does not hold (ревью F8). A
   * task whose ttl has run out is `task_expired` until it is closed or swept.
   */
  get(agentId: string, taskId: string, now: number): BridgeResult<Task> {
    const task = this.table.get(taskId)
    if (task === undefined || task.agentId !== agentId) return noSuchTask()
    if (expired(task, now)) return refuse('task_expired', 'the task has run out of time') // i18n-exempt: a refusal read by the agent over MCP, not by the person
    return { success: true, data: task }
  }

  /**
   * Charges one call of `verb` to `task`, checking it against the scope; `url` is the URL the call
   * targets, when it names one. The order is the contract's: a spent budget refuses before anything
   * is charged (`budget_exhausted`, and `stepsUsed` stays at the budget); otherwise the step is
   * charged first and then the verb (`verb_not_in_task`) and the URL's origin, fragment ignored
   * (`origin_not_in_task`) are checked, so a refused call costs its step as an allowed one does
   * (spec §2.3). `close` is neither charged nor refused: it only gives back what the task holds.
   *
   * `task` must be the object `open` or `get` returned and still in the table; a closed task, or a
   * copy, is `no_such_task` and is not charged. The ttl is `get`'s to check, with the clock.
   */
  charge(task: Task, verb: BridgeVerb, url?: string): BridgeResult<void> {
    const record = this.table.get(task.id)
    if (record === undefined || record !== task) return noSuchTask()
    if (verb === 'close') return DONE
    if (record.stepsUsed >= record.scope.stepBudget) return refuse('budget_exhausted', `the task has used all ${record.scope.stepBudget} of its steps`) // i18n-exempt: a refusal read by the agent over MCP, not by the person
    record.stepsUsed += 1
    if (!verbAllowed(record.scope, verb)) return refuse('verb_not_in_task', `the task does not name the verb ${verb}`) // i18n-exempt: a refusal read by the agent over MCP, not by the person
    if (url !== undefined && !inScope(record.scope, url)) return notInTask()
    return DONE
  }

  /** Closes every task of `agentId` (the agent's access was revoked) and returns them, so the caller closes their windows. */
  closeAllOf(agentId: string): Task[] {
    const closed = [...this.table.values()].filter((task) => task.agentId === agentId)
    for (const task of closed) this.table.delete(task.id)
    return closed
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

/**
 * Whether the URL a navigation actually landed on is still inside the task (ревью F9, аудит #39): a
 * redirect from a named origin to one the task did not name is `origin_not_in_task`. The fragment
 * does not count. Charges nothing: the call that navigated was the step.
 */
export function checkLanded(task: Task, actualUrl: string): BridgeResult<void> {
  return inScope(task.scope, actualUrl) ? DONE : notInTask()
}

const DONE: BridgeResult<void> = { success: true, data: undefined }

function noSuchTask(): BridgeResult<never> {
  return refuse('no_such_task', 'no task with this id is open for this agent') // i18n-exempt: a refusal read by the agent over MCP, not by the person
}

/** The origin is not named: the message does not repeat the URL, which may carry what the page put in it. */
function notInTask(): BridgeResult<never> {
  return refuse('origin_not_in_task', 'the URL is outside the origins the task may read') // i18n-exempt: a refusal read by the agent over MCP, not by the person
}
