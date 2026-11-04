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
      'browser-lock',
      'outside-link',
      'credential-guard',
      'download',
      'leaked-password',
    ],
  },
  /** A check the person asked for finished. */
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
