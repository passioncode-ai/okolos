/**
 * The sentences the service shell says to a person, from the agent catalogue
 * (`apps/agent/_locales/{ru,en}/messages.json`, the brand pack's words).
 *
 * Events are read in Fabric Dashboards' event view, the degraded reason beside the service's
 * status, and the refusal while stopping may be relayed by an agent to its person. None of them is
 * written in code: each is a key, resolved with `@okolos/i18n` for the locale the service was
 * started with. The catalogue is read when the service starts, never at import.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { fromCatalogue, type Catalogue } from '@okolos/i18n'

/** The language of the sentences a person reads; Fabric's interface speaks Russian by default. */
export type Locale = 'ru' | 'en'

/** Every catalogue key this shell resolves. */
export const SERVICE_KEYS = [
  'eventStarted',
  'eventStopping',
  'eventDrainCutOff',
  'serviceStopping',
  'eventsUnreadable',
] as const

export interface ServiceMessages {
  started(): string
  stopping(): string
  /** The drain's deadline passed with `count` requests still open; they were cut off. */
  drainCutOff(count: number): string
  refusingWhileStopping(): string
  unreadableEvents(count: number): string
}

/** apps/agent/_locales, beside src/ (or dist/) in the checkout. A release passes its own. */
export function defaultLocalesDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '_locales')
}

export function serviceMessages(locale: Locale, localesDir: string = defaultLocalesDir()): ServiceMessages {
  const file = path.join(localesDir, locale, 'messages.json')
  const catalogue = JSON.parse(readFileSync(file, 'utf8')) as Catalogue
  // A stale catalogue would put "[key]" into the feed a person reads: refuse to start instead.
  const missing = SERVICE_KEYS.filter((key) => typeof catalogue[key]?.message !== 'string')
  if (missing.length > 0) {
    // i18n-exempt: a start failure for whoever installs the daemon, naming the catalogue file and its missing keys
    throw new Error(`The agent catalogue ${file} lacks ${missing.join(', ')}.`)
  }
  const say = fromCatalogue(catalogue)
  return {
    started: () => say('eventStarted'),
    stopping: () => say('eventStopping'),
    drainCutOff: (count) => say('eventDrainCutOff', [String(count)]),
    refusingWhileStopping: () => say('serviceStopping'),
    unreadableEvents: (count) => say('eventsUnreadable', [String(count)]),
  }
}
