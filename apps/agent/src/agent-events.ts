/**
 * What Okolos Agent writes into its events feed about access and the agent window
 * (N-011, plan tests 28 and 9): fixed sentences from the agent catalogue, with the
 * agent's name and a time, never a request id or a key.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { fromCatalogue, type Catalogue } from '@okolos/i18n'

import type { PairingNotice } from './pairing/pairing.js'
import { defaultLocalesDir, type Locale } from './service/messages.js'

export const AGENT_EVENT_KEYS = [
  'eventAgentAsked',
  'eventAgentConfirmed',
  'eventAgentDeclined',
  'eventAgentRequestExpired',
  'eventAgentClaimExpired',
  'eventAgentPaired',
  'eventAgentRevoked',
  'eventWindowCloseIncomplete',
] as const

export interface AgentEvents {
  /** The feed's kind, level and sentence for a pairing notice. */
  notice(notice: PairingNotice): { kind: string; level: 'info' | 'notice' | 'warning'; text: string }
  windowCloseIncomplete(pid: number): string
}

export function agentEvents(locale: Locale, localesDir: string = defaultLocalesDir(), timeZone?: string): AgentEvents {
  const file = path.join(localesDir, locale, 'messages.json')
  const catalogue = JSON.parse(readFileSync(file, 'utf8')) as Catalogue
  const missing = AGENT_EVENT_KEYS.filter((key) => typeof catalogue[key]?.message !== 'string')
  if (missing.length > 0) {
    // i18n-exempt: a start failure for whoever installs the daemon, naming the catalogue file and its missing keys
    throw new Error(`The agent catalogue ${file} lacks ${missing.join(', ')}.`)
  }
  const say = fromCatalogue(catalogue)
  const time = (at: number): string =>
    new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', ...(timeZone === undefined ? {} : { timeZone }) }).format(at)
  return {
    notice: (notice) => {
      switch (notice.kind) {
        case 'requested':
          return { kind: 'pairing_requested', level: 'notice', text: say('eventAgentAsked', [notice.name]) }
        case 'confirmed':
          return { kind: 'pairing_confirmed', level: 'info', text: say('eventAgentConfirmed', [notice.name]) }
        case 'declined':
          return { kind: 'pairing_declined', level: 'info', text: say('eventAgentDeclined', [notice.name]) }
        case 'expired':
          return { kind: 'pairing_expired', level: 'info', text: say('eventAgentRequestExpired', [notice.name, time(notice.at)]) }
        case 'claim_expired':
          return { kind: 'pairing_claim_expired', level: 'info', text: say('eventAgentClaimExpired', [notice.name, time(notice.at)]) }
        case 'paired':
          return { kind: 'pairing_paired', level: 'notice', text: say('eventAgentPaired', [notice.name]) }
        case 'revoked':
          return { kind: 'pairing_revoked', level: 'notice', text: say('eventAgentRevoked', [notice.name]) }
        default: {
          const unhandled: never = notice
          throw new Error(`no event for notice ${JSON.stringify(unhandled)}`) // i18n-exempt: a programming error the type check makes unreachable
        }
      }
    },
    windowCloseIncomplete: (pid) => say('eventWindowCloseIncomplete', [String(pid)]),
  }
}
