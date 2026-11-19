import { readFileSync } from 'node:fs'
import path from 'node:path'

import { fromCatalogue, type Catalogue } from '@okolos/i18n'
import { describe, expect, it } from 'vitest'

import type { RecentJournal } from '../journal/journal.js'
import type { AgentRecord, PublicRequest } from '../pairing/pairing.js'
import type { TaskSnapshot } from '../tasks/tasks.js'
import { pageView, type ViewInput } from './view.js'

const say = fromCatalogue(JSON.parse(readFileSync(path.join(import.meta.dirname, '..', '..', '_locales', 'en', 'messages.json'), 'utf8')) as Catalogue)
const NOW = Date.UTC(2026, 10, 19, 12, 0)
const format = (at: number) => new Date(at).toISOString().slice(0, 16).replace('T', ' ')

const AGENT: AgentRecord = { agentId: 'a1', name: 'scout', pairedAt: NOW - 3_600_000, lastCallAt: null }
const request = (over: Partial<PublicRequest>): PublicRequest =>
  ({ handle: 'h1', name: 'helper', code: '123456', createdAt: NOW - 60_000, expiresAt: NOW + 240_000, state: 'pending', confirmedAt: null, ...over }) as PublicRequest

const EMPTY_JOURNAL: RecentJournal = { answers: [], refusals: [], rejections: { request: [], state: [] }, dayFull: [], unreadable: 0 } as unknown as RecentJournal

function view(over: Partial<ViewInput> = {}) {
  return pageView({
    say,
    now: NOW,
    doorUrl: 'http://127.0.0.1:47871',
    pairing: { requests: [], agents: [] },
    tasks: [],
    journal: { recent: EMPTY_JOURNAL },
    journalWriteFailure: null,
    format,
    ...over,
  })
}

describe('pageView (N-015)', () => {
  it('says empty when nothing waits and no task is open, and fills the how-to with the door address', () => {
    const v = view()
    expect(v.pairing.state).toBe('empty')
    expect(v.activity.state).toBe('empty')
    expect(v.strings['pairingHow']).toContain('http://127.0.0.1:47871')
    expect(Object.values(v.strings).some((s) => s.startsWith('['))).toBe(false)
  })

  it('shows the code grouped three and three, buttons only on a pending row, and flags look-alike names', () => {
    const v = view({
      pairing: {
        requests: [
          request({}),
          request({ handle: 'h2', name: 'Helper', state: 'confirmed' }),
          request({ handle: 'h3', name: 'sc0ut', state: 'expired' }),
        ],
        agents: [AGENT],
      },
    })
    if (v.pairing.state === 'error') throw new Error('error state')
    const [pending, confirmed, expired] = v.pairing.requests
    expect(pending).toMatchObject({ code: '123 456', status: null, agent: 'Agent helper (a name it gave itself)' })
    expect(pending?.duplicate).not.toBeNull()
    expect(confirmed?.status).toContain('The key waits for the agent until')
    expect(expired?.status).toBe(say('pairingExpired'))
    expect(expired?.lookalike?.agents).toEqual([`Agent scout (access since ${format(AGENT.pairedAt)})`])
    expect(JSON.stringify(v)).not.toContain('requestId')
  })

  it('says the access list cannot be read instead of an empty one', () => {
    expect(view({ pairing: { unreadable: 'unreadable' } }).pairing).toEqual({ state: 'error', error: say('pairingStoreError', ['unreadable']) })
  })

  it('shows a task with its profile, goal, sites, time and steps; out of time when it is', () => {
    const task = {
      id: 't1',
      agentId: 'a1',
      scope: { goal: 'Find the price', origins: { read: ['https://example.com'], write: [] }, verbs: ['open'], ttlSeconds: 600, stepBudget: 40, profile: 'agent' },
      openedAt: NOW - 120_000,
      stepsUsed: 3,
      windowOpen: true,
      expired: false,
    } as unknown as TaskSnapshot
    const v = view({ pairing: { requests: [], agents: [AGENT] }, tasks: [task, { ...task, id: 't2', openedAt: NOW - 700_000, expired: true, scope: { ...task.scope, profile: 'disposable' } } as TaskSnapshot] })
    expect(v.activity.state).toBe('success')
    expect(v.activity.tasks[0]).toEqual({
      agent: `Agent scout (access since ${format(AGENT.pairedAt)})`,
      profile: say('taskProfileAgent'),
      goal: say('taskGoal', ['Find the price']),
      sites: say('taskSites', ['https://example.com']),
      time: say('taskTimeLeft', ['8']),
      steps: say('taskSteps', ['3', '40']),
      window: say('taskWindowOpen'),
    })
    expect(v.activity.tasks[1]).toMatchObject({ profile: say('taskProfileDisposable'), time: say('taskTimeOver') })
  })

  it('says refusals in words, failures on their own line, door refusals by their reason, and a revoked agent as revoked', () => {
    const journal = {
      ...EMPTY_JOURNAL,
      refusals: [
        { at: '2026-11-19T11:00:00.000Z', outcome: 'refused', agent: 'scout', agentId: 'a1', pairedAt: '2026-11-19T11:00:00.000Z', verb: 'session.open', code: 'origin_not_in_task' },
        { at: '2026-11-19T11:01:00.000Z', outcome: 'refused', agent: 'old', agentId: 'gone', pairedAt: '2026-11-18T10:00:00.000Z', verb: 'waitFor', code: 'cleaning_incomplete' },
        { at: '2026-11-19T11:02:00.000Z', outcome: 'refused', agent: 'scout', agentId: 'a1', pairedAt: '2026-11-19T11:00:00.000Z', verb: 'snapshot', code: 'local_answer' },
      ],
      rejections: {
        request: [{ at: '2026-11-19T11:03:00.000Z', outcome: 'rejected', code: 'bad_origin' }],
        state: [{ at: '2026-11-19T11:04:00.000Z', outcome: 'rejected', code: 'store_unreadable' }],
      },
    } as unknown as RecentJournal
    const v = view({ pairing: { requests: [], agents: [AGENT] }, journal: { recent: journal } })
    const [local, failure, policy] = v.activity.refusals
    expect(policy).toContain(say('verb_session_open'))
    expect(policy).toContain(say('refusal_origin_not_in_task'))
    expect(failure).toContain('Okolos Agent failure')
    expect(failure).toContain('(access since 2026-11-18 10:00, revoked)')
    expect(local).toContain(say('refusal_local_answer'))
    expect(v.activity.door).toEqual([
      say('refusalDoorFailureLine', ['2026-11-19 11:04', say('rejection_store_unreadable')]),
      say('refusalDoorLine', ['2026-11-19 11:03', say('rejection_bad_origin')]),
    ])
    expect(JSON.stringify(v)).not.toMatch(/session\.open|waitFor/)
  })

  it('marks the list incomplete while the journal cannot be written, and shows no list when it cannot be read', () => {
    expect(view({ journalWriteFailure: 'no_space' }).activity).toMatchObject({ notes: [say('refusalsIncomplete')], journalError: say('journalError', ['no_space']) })
    expect(view({ journal: { failure: 'unreadable' } }).activity).toMatchObject({ state: 'journal-unreadable', refusals: [], door: [] })
  })

  it('shows the day-full state with its hour, marks the list incomplete, and names an earlier full day and a write gap', () => {
    const journal = {
      ...EMPTY_JOURNAL,
      dayFull: [
        { at: '2026-11-17T20:00:00.000Z', outcome: 'day_full' },
        { at: '2026-11-19T10:00:00.000Z', outcome: 'day_full' },
      ],
    } as unknown as RecentJournal
    const v = view({ journal: { recent: journal }, writeGaps: [{ from: Date.UTC(2026, 10, 18, 8), to: Date.UTC(2026, 10, 18, 9) }] })
    expect(v.activity.state).toBe('day-full')
    expect(v.activity.journalError).toBe(say('journalDayFull'))
    expect(v.activity.notes).toEqual([
      say('refusalsIncomplete'),
      say('refusalsGap', ['2026-11-17 20:00', '2026-11-18 00:00']),
      say('refusalsGap', ['2026-11-18 08:00', '2026-11-18 09:00']),
    ])
  })

  it('shows the store-unwritable state while the access list cannot be written, and the lists as before', () => {
    const v = view({ pairing: { requests: [], agents: [AGENT] }, pairingWriteFailure: 'no_space' })
    if (v.pairing.state === 'error') throw new Error('error state')
    expect(v.pairing.unwritable).toBe(say('pairingStoreUnwritable', ['no_space']))
    expect(v.pairing.agents).toHaveLength(1)
  })
})
