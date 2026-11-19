import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { AGENT_EVENT_KEYS, agentEvents } from './agent-events.js'
import type { PairingNotice } from './pairing/pairing.js'

const AT = Date.UTC(2026, 10, 19, 9, 30)
const NOTICES: PairingNotice[] = [
  { kind: 'requested', handle: 'h-secret-1', name: 'scout', at: AT },
  { kind: 'confirmed', handle: 'h-secret-1', name: 'scout', at: AT },
  { kind: 'declined', handle: 'h-secret-1', name: 'scout', at: AT },
  { kind: 'expired', handle: 'h-secret-1', name: 'scout', at: AT, cause: 'timeout' },
  { kind: 'claim_expired', handle: 'h-secret-1', name: 'scout', at: AT, cause: 'timeout' },
  { kind: 'paired', handle: 'h-secret-1', agentId: 'a-secret', name: 'scout', at: AT },
  { kind: 'revoked', agentId: 'a-secret', name: 'scout', at: AT },
]

describe('the events Okolos Agent writes about access and its window (N-011, test 28)', () => {
  for (const locale of ['ru', 'en'] as const) {
    it(`names the agent and the deadline in ${locale}, never the request id or the agent id`, () => {
      const say = agentEvents(locale, undefined, 'UTC')
      const kinds = new Set<string>()
      for (const notice of NOTICES) {
        const event = say.notice(notice)
        kinds.add(event.kind)
        expect(event.text).toContain('scout')
        expect(event.text).not.toMatch(/secret|\$[A-Z]+\$|\[/)
      }
      expect(kinds.size).toBe(NOTICES.length)
      // The two endings by time say the deadline, not when it was noticed.
      for (const notice of NOTICES.slice(3, 5)) expect(say.notice(notice).text).toContain('09:30')
      expect(say.windowCloseIncomplete(4242)).toContain('4242')
    })
  }

  it('refuses to start on a catalogue that lacks one of its keys', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'okolos-agent-events-'))
    try {
      const catalogue = JSON.parse(readFileSync(path.join(import.meta.dirname, '..', '_locales', 'en', 'messages.json'), 'utf8')) as Record<string, unknown>
      delete catalogue[AGENT_EVENT_KEYS[0]]
      mkdirSync(path.join(dir, 'en'))
      writeFileSync(path.join(dir, 'en', 'messages.json'), JSON.stringify(catalogue))
      expect(() => agentEvents('en', dir)).toThrow(AGENT_EVENT_KEYS[0])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
