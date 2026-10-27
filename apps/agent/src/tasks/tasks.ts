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
 * epoch) into every call that asks whether a task is still alive. Nothing here reads the time. Every
 * method that takes `now` throws a TypeError before it acts unless `now` is a safe integer >= 0, the
 * clock contract Pairing holds (fix round 1): NaN would compare false and switch expiry off.
 *
 * Two kinds of object leave this module (fix round 1). `open` and `get` give the task itself, the
 * live handle the verbs (N-011) charge, check and set the window on. `list` and `sweep` give frozen
 * copies for reading (the page, N-015, and the windows to close): `charge`, `checkLanded` and
 * `setWindow` answer `no_such_task` to a copy, so whoever reads the list cannot spend another agent's
 * steps or move its window fields. The scope is frozen at `open`, on the handle and on every copy.
 *
 * A task whose time ran out stays in the table until `sweep` removes it (fix round 2, spec §2.1,
 * SCR-24 `taskTimeOver`): `get` and `charge` already refuse it as `task_expired`, but `list` still
 * shows it, marked `expired`, so the page keeps the row until the timer closes its window.
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
  /** The CDP targetId of the task's window (`SessionOpenResult.windowId`), once N-011 has set it with `setWindow`. */
  readonly windowId?: string
  /** Whether the task's window is open (SCR-24 taskWindowOpen / taskWindowClosed); N-011 sets it with `setWindow` from N-010's window events. */
  readonly windowOpen: boolean
}

/**
 * What `list` gives for one task: a frozen copy of its fields at `now`, and whether its time has run
 * out by then (`openedAt + ttlSeconds * 1000` and after). Only the copy carries `expired`: the live
 * handle would hold a value that goes stale as the clock moves.
 */
export interface TaskSnapshot extends Task {
  readonly expired: boolean
}

/** What `setWindow` records; a field left out keeps its value. */
export interface TaskWindow {
  readonly windowId?: string
  readonly windowOpen?: boolean
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

/** Draws of a task id before `open` gives up: with 128 random bits even a second draw practically never happens. */
const ID_DRAWS = 8

export type RandomSource = (size: number) => Uint8Array

export interface TasksOptions {
  /** Where task ids come from; `crypto.randomBytes` unless a test gives another. */
  readonly random?: RandomSource
}

interface TaskRecord extends Task {
  stepsUsed: number
  windowId?: string
  windowOpen: boolean
}

/**
 * The records that sit in some table now, whichever `Tasks` holds them: `checkLanded` keeps the
 * plan's signature (task, url) and still knows whether the task is open. A record joins at `open` and
 * leaves at `close`, `closeAllOf` and `sweep`; a copy never joins.
 */
const liveTasks = new WeakSet<Task>()

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
    checkClock(now, 'open')
    if (typeof scopeInput === 'object' && scopeInput !== null) {
      const fault = goalFault((scopeInput as Record<string, unknown>).goal)
      if (fault !== null) {
        const refused = refuse('invalid_scope', `goal: ${fault}`)
        return { success: false, error: { ...refused.error, code: 'invalid_scope', field: 'goal', reason: fault } }
      }
    }
    const checked = validateScope(scopeInput)
    if (!checked.ok) return refuse('invalid_scope', checked.reason)

    const task: TaskRecord = { id: this.newId(), agentId, scope: frozenScope(checked.scope), openedAt: now, stepsUsed: 0, windowOpen: false }
    this.table.set(task.id, task)
    liveTasks.add(task)
    return { success: true, data: task }
  }

  /**
   * The task `taskId` of `agentId`. Another agent's task is `no_such_task`, the same answer, word for
   * word, as an id no task has, so an agent learns nothing about tasks it does not hold (ревью F8). A
   * task whose ttl has run out is `task_expired` until it is closed or swept.
   */
  get(agentId: string, taskId: string, now: number): BridgeResult<Task> {
    checkClock(now, 'get')
    const task = this.table.get(taskId)
    if (task === undefined || task.agentId !== agentId) return noSuchTask()
    if (expired(task, now)) return expiredTask()
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
   * copy (what `list` and `sweep` give is one), is `no_such_task` and is not charged. A task whose
   * ttl ran out by `now` is `task_expired` and is not charged either (fix round 1), so a caller that
   * did not `get` first still spends nothing on it.
   */
  charge(task: Task, verb: BridgeVerb, now: number, url?: string): BridgeResult<void> {
    checkClock(now, 'charge')
    const record = this.table.get(task.id)
    if (record === undefined || record !== task) return noSuchTask()
    if (verb === 'close') return DONE
    if (expired(record, now)) return expiredTask()
    if (record.stepsUsed >= record.scope.stepBudget) return refuse('budget_exhausted', `the task has used all ${record.scope.stepBudget} of its steps`) // i18n-exempt: a refusal read by the agent over MCP, not by the person
    record.stepsUsed += 1
    if (!verbAllowed(record.scope, verb)) return refuse('verb_not_in_task', `the task does not name the verb ${verb}`) // i18n-exempt: a refusal read by the agent over MCP, not by the person
    if (url !== undefined && !inScope(record.scope, url)) return notInTask()
    return DONE
  }

  /**
   * Records the task's window: its CDP targetId once N-011 opened it, and whether it is open, from
   * N-010's window events. `task` must be the live handle `open` or `get` returned and still in the
   * table; a copy, or a task no longer open, is `no_such_task` and nothing moves.
   */
  setWindow(task: Task, window: TaskWindow): BridgeResult<void> {
    const record = this.table.get(task.id)
    if (record === undefined || record !== task) return noSuchTask()
    if (window.windowId !== undefined) record.windowId = window.windowId
    if (window.windowOpen !== undefined) record.windowOpen = window.windowOpen
    return DONE
  }

  /**
   * Closes the task `taskId` of `agentId` and returns it, so the caller closes its window. Works on a
   * task that used all its steps and on one whose time ran out: closing only gives back what the
   * task holds. Another agent's task is `no_such_task` and stays open.
   */
  close(agentId: string, taskId: string): BridgeResult<Task> {
    const task = this.table.get(taskId)
    if (task === undefined || task.agentId !== agentId) return noSuchTask()
    this.table.delete(taskId)
    liveTasks.delete(task)
    return { success: true, data: task }
  }

  /** Closes every task of `agentId` (the agent's access was revoked) and returns them, so the caller closes their windows. */
  closeAllOf(agentId: string): Task[] {
    const closed = [...this.table.values()].filter((task) => task.agentId === agentId)
    for (const task of closed) {
      this.table.delete(task.id)
      liveTasks.delete(task)
    }
    return closed
  }

  /**
   * Frozen copies of every task in the table at `now`, oldest first, each marked `expired` when its
   * time has run out: an expired task stays listed until `sweep` removes it (fix round 2). A copy is
   * for reading only.
   */
  list(now: number): TaskSnapshot[] {
    checkClock(now, 'list')
    return [...this.table.values()].map((task) => Object.freeze({ ...snapshot(task), expired: expired(task, now) }))
  }

  /** Removes the tasks whose time ran out by `now` and returns frozen copies, so the caller closes their windows. */
  sweep(now: number): Task[] {
    checkClock(now, 'sweep')
    const over = [...this.table.values()].filter((task) => expired(task, now))
    for (const task of over) {
      this.table.delete(task.id)
      liveTasks.delete(task)
    }
    return over.map(snapshot)
  }

  /**
   * A fresh id: exactly ID_BYTES from the random source, drawn again on a clash with an open task, at
   * most ID_DRAWS times. A source that gives another length, or keeps clashing, is broken; `open`
   * throws rather than shorten the id or loop for ever.
   */
  private newId(): string {
    for (let draw = 0; draw < ID_DRAWS; draw += 1) {
      const bytes = this.random(ID_BYTES)
      if (bytes.length !== ID_BYTES) throw new Error(`Tasks: the random source gave ${bytes.length} bytes, ${ID_BYTES} needed`) // i18n-exempt: a fault of the random source thrown to the daemon's code, never shown to the person
      const id = Buffer.from(bytes).toString('hex')
      if (!this.table.has(id)) return id
    }
    throw new Error(`Tasks: no free task id after ${ID_DRAWS} draws`) // i18n-exempt: a fault of the random source thrown to the daemon's code, never shown to the person
  }
}

/** The page shows at most this many visible characters of a goal (SCR-24, `taskGoal`), the ellipsis included. */
export const GOAL_SHOWN_MAX = 200

const ELLIPSIS = '\u2026'

/**
 * The goal as the page shows it: up to `GOAL_SHOWN_MAX` visible characters (grapheme clusters, so
 * an emoji sequence or a letter with its marks is one and is never split), a longer goal cut to one
 * less and ended with an ellipsis. The page puts it in as text, never as markup, after the label
 * that says these are the agent's words (`taskGoal`).
 */
export function goalShown(goal: string): string {
  const graphemes = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(goal)].map((part) => part.segment)
  if (graphemes.length <= GOAL_SHOWN_MAX) return goal
  return `${graphemes.slice(0, GOAL_SHOWN_MAX - 1).join('')}${ELLIPSIS}`
}

/** A task is over once `ttlSeconds` have passed since it opened: at `openedAt + ttl` it is already expired. */
function expired(task: Task, now: number): boolean {
  return now >= task.openedAt + task.scope.ttlSeconds * 1000
}

/**
 * Whether the URL a navigation actually landed on is still inside the task (ревью F9, аудит #39): a
 * redirect from a named origin to one the task did not name is `origin_not_in_task`. The fragment
 * does not count. Charges nothing: the call that navigated was the step.
 *
 * A task that is no longer open (closed, its agent revoked, swept) or a copy is `no_such_task`
 * whatever the URL (fix round 1), so a call in flight when the person revokes the agent does not pass
 * its last gate. The ttl is not judged here: the call that navigated was charged inside it.
 */
export function checkLanded(task: Task, actualUrl: string): BridgeResult<void> {
  if (!liveTasks.has(task)) return noSuchTask()
  return inScope(task.scope, actualUrl) ? DONE : notInTask()
}

/** A frozen copy of a task; its scope is the task's own, frozen at `open`. */
function snapshot(task: TaskRecord): Task {
  const copy: Task = {
    id: task.id,
    agentId: task.agentId,
    scope: task.scope,
    openedAt: task.openedAt,
    stepsUsed: task.stepsUsed,
    ...(task.windowId === undefined ? {} : { windowId: task.windowId }),
    windowOpen: task.windowOpen,
  }
  return Object.freeze(copy)
}

/** The scope frozen through: nobody holding a task or a copy widens what it may reach. */
function frozenScope(scope: TaskScope): TaskScope {
  return Object.freeze({
    ...scope,
    origins: Object.freeze({ read: Object.freeze([...scope.origins.read]), write: Object.freeze([...scope.origins.write]) }),
    verbs: Object.freeze([...scope.verbs]),
  })
}

/** A time the table takes: whole ms since the epoch, not negative (the rule of Pairing's `isTime`). */
function checkClock(now: number, method: string): void {
  if (typeof now !== 'number' || !Number.isSafeInteger(now) || now < 0) {
    throw new TypeError(`Tasks.${method}: now must be a safe integer >= 0, got ${String(now)}`)
  }
}

const DONE: BridgeResult<void> = { success: true, data: undefined }

function expiredTask(): BridgeResult<never> {
  return refuse('task_expired', 'the task has run out of time') // i18n-exempt: a refusal read by the agent over MCP, not by the person
}

function noSuchTask(): BridgeResult<never> {
  return refuse('no_such_task', 'no task with this id is open for this agent') // i18n-exempt: a refusal read by the agent over MCP, not by the person
}

/** The origin is not named: the message does not repeat the URL, which may carry what the page put in it. */
function notInTask(): BridgeResult<never> {
  return refuse('origin_not_in_task', 'the URL is outside the origins the task may read')
}
