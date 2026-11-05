import type { PasswordVerdict } from '@okolos/core-credential'

import type { TrapKind } from '../../content/traps.js'

/**
 * Every usage and error event Okolos may send, and every value each of its props may take.
 *
 * Closed on purpose (B-198, B-199, ADR-0019). A prop is one of the listed strings or the event
 * is refused at the sink: there is no free text anywhere in an event, so a page address, page
 * text, a file name, an email or a password cannot ride along by mistake. `docs/analytics.md`
 * is this table for people, and a test keeps the two equal.
 */
export const CATALOGUE = {
  /** The extension was installed or updated (`runtime.onInstalled`). */
  extension_installed: { reason: ['install', 'update'] },
  /** The first-run screen finished its checks. */
  first_run_completed: { result: ['clean', 'findings', 'partial'] },
  /** A warning was put in front of the person. */
  warning_shown: {
    kind: [
      'hidden-instruction',
      'lookalike',
      'blocked-page',
      'clickfix',
      'tech-support',
      'outside-link',
      'credential-guard',
      'download',
      'leaked-password',
    ],
  },
  /**
   * A check finished: one the person asked for, or the password check a submitted login form starts
   * by itself. Fixed before the first production send (the event-history rule).
   */
  check_done: {
    check: ['password', 'leak-inventory', 'extensions'],
    result: ['ok', 'found', 'unavailable'],
  },
  /** Something failed on the person's device: where, and what kind of failure. */
  error_occurred: {
    area: ['scan', 'feed', 'download', 'password', 'leak', 'storage', 'ui', 'usage'],
    kind: ['timeout', 'network', 'storage-full', 'refused', 'unexpected'],
  },
} as const satisfies Record<string, Record<string, readonly string[]>>

export type EventName = keyof typeof CATALOGUE
export type EventProps<E extends EventName> = {
  readonly [K in keyof (typeof CATALOGUE)[E]]: (typeof CATALOGUE)[E][K] extends readonly (infer V)[] ? V : never
}

/**
 * Whether `props` is exactly what `name` allows: every declared prop present, each one of its
 * listed values, and nothing else. A refusal, never a repair: a value outside the list means a
 * caller is about to send something nobody reviewed.
 */
export function admissible(name: string, props: Readonly<Record<string, unknown>>): name is EventName {
  if (!Object.hasOwn(CATALOGUE, name)) return false
  const allowed = CATALOGUE[name as EventName] as Readonly<Record<string, readonly string[]>>
  const keys = Object.keys(props)
  if (keys.length !== Object.keys(allowed).length) return false
  return keys.every((key) => Object.hasOwn(allowed, key) && (allowed[key] as readonly unknown[]).includes(props[key]))
}

/**
 * A page trap's kind, as the content script names it, to the value `warning_shown` counts it
 * under. Typed by `TrapKind`, so a kind added there fails the build until it is mapped here.
 * A kind nobody mapped is not counted (`null`), never sent as it came.
 */
const TRAP_WARNING: Readonly<Record<TrapKind, EventProps<'warning_shown'>['kind']>> = {
  clickfix: 'clickfix',
  techsupport: 'tech-support',
  'outside-link': 'outside-link',
}

export function trapWarning(kind: string): EventProps<'warning_shown'>['kind'] | null {
  return Object.hasOwn(TRAP_WARNING, kind) ? TRAP_WARNING[kind as TrapKind] : null
}

/**
 * A password check, by what it found out. Not by where the answer came from: the built-in list
 * answers offline only when it finds the password, and a range query that failed is a question
 * not answered, never a clean result.
 */
export function passwordCheckResult(code: PasswordVerdict['explain']['code']): EventProps<'check_done'>['result'] {
  switch (code) {
    case 'in-common-list':
    case 'found':
      return 'found'
    case 'absent':
      return 'ok'
    case 'unreachable':
    case 'unreadable':
      return 'unavailable'
  }
}

/**
 * A download verdict counts as `warning_shown{download}` only when it warned and a page took it:
 * from a bookmark or a background tab no content script answers (`tabs.sendToActive` is false),
 * the journal records it as unseen, and nobody was warned. The event's meaning is fixed at its
 * first production send (the event-history rule), so it means "shown", not "decided".
 */
export function downloadWarningShown(action: 'block' | 'warn' | 'inform', told: boolean): boolean {
  return told && (action === 'block' || action === 'warn')
}
