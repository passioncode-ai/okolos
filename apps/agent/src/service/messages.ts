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
export const SERVICE_KEYS = ['eventStarted', 'eventStopping', 'serviceStopping', 'eventsUnreadable'] as const

export interface ServiceMessages {
  started(): string
  stopping(): string
  refusingWhileStopping(): string
  unreadableEvents(count: number): string
}

/** apps/agent/_locales, beside src/ (or dist/) in the checkout. A release passes its own. */
export function defaultLocalesDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '_locales')
}

export function serviceMessages(locale: Locale, localesDir: string = defaultLocalesDir()): ServiceMessages {
  const catalogue = JSON.parse(readFileSync(path.join(localesDir, locale, 'messages.json'), 'utf8')) as Catalogue
  const say = fromCatalogue(catalogue)
  return {
    started: () => say('eventStarted'),
    stopping: () => say('eventStopping'),
    refusingWhileStopping: () => say('serviceStopping'),
    unreadableEvents: (count) => say('eventsUnreadable', [String(count)]),
  }
}
