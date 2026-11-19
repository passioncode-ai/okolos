import { describe, expect, it } from 'vitest'

import { answerAction, type ActionSinks, type AgentActionEntry } from './agent-actions.js'

const AGENT = { agentId: 'a1', name: 'scout' }
const NOW = Date.parse('2026-11-19T12:00:00.000Z')

function sinks() {
  const calls: string[] = []
  const journal: AgentActionEntry[] = []
  const s: ActionSinks = {
    openFinding: async (id) => (id === 'f1' ? { host: 'news.example' } : null),
    changedExtension: async (id) => id === 'ext1',
    trusted: async (domain) => domain === 'bank.example',
    resolve: async (id) => void calls.push(`resolve ${id}`),
    defer: async (id, until) => void calls.push(`defer ${id} ${until}`),
    accept: async (id) => void calls.push(`accept ${id}`),
    untrust: async (domain) => void calls.push(`untrust ${domain}`),
    journal: async (entry) => void journal.push(entry),
    now: () => NOW,
  }
  return { s, calls, journal }
}

describe('an agent acts in Okolos as the button does, and the journal names it (WC-1, WC-3)', () => {
  it('resolves an open finding and says which agent did it, as a weakening it can undo', async () => {
    const { s, calls, journal } = sinks()
    expect(await answerAction('okolos.finding.resolve', { id: 'f1' }, AGENT, s)).toEqual({ success: true, data: { done: true } })
    expect(calls).toEqual(['resolve f1'])
    expect(journal).toEqual([
      { explainKey: 'logAgentResolved', explainArgs: ['scout', 'news.example'], agentId: 'a1', verb: 'okolos.finding.resolve', ref: 'f1', weakens: true },
    ])
  })

  it('defers for the days asked, from now, and names the day', async () => {
    const { s, calls, journal } = sinks()
    await answerAction('okolos.finding.defer', { id: 'f1', days: 7 }, AGENT, s)
    expect(calls).toEqual(['defer f1 2026-11-26T12:00:00.000Z'])
    expect(journal[0]?.explainArgs).toEqual(['scout', 'news.example', '2026-11-26'])
  })

  it('accepts a listed extension change and untrusts a trusted site; untrusting weakens nothing', async () => {
    const { s, calls, journal } = sinks()
    await answerAction('okolos.extension.accept', { id: 'ext1' }, AGENT, s)
    await answerAction('okolos.trust.revoke', { domain: 'Bank.example' }, AGENT, s)
    expect(calls).toEqual(['accept ext1', 'untrust bank.example'])
    expect(journal.map((entry) => [entry.explainKey, entry.weakens])).toEqual([
      ['logAgentAccepted', true],
      ['logAgentUntrusted', false],
    ])
  })
})

describe('nothing happens on what is not there, or without the agent (WC-4)', () => {
  it('refuses an unknown or closed finding, an unlisted extension, a site not trusted, a defer past 30 days', async () => {
    const { s, calls, journal } = sinks()
    for (const [verb, input] of [
      ['okolos.finding.resolve', { id: 'gone' }],
      ['okolos.finding.defer', { id: 'f1', days: 31 }],
      ['okolos.extension.accept', { id: 'other' }],
      ['okolos.trust.revoke', { domain: 'shop.example' }],
    ] as const) {
      expect(await answerAction(verb, input, AGENT, s), verb).toMatchObject({ success: false })
    }
    expect(calls).toEqual([])
    expect(journal).toEqual([])
  })

  it('refuses an action that does not say which agent asked, and a verb it does not know', async () => {
    const { s, calls } = sinks()
    expect(await answerAction('okolos.finding.resolve', { id: 'f1' }, undefined, s)).toMatchObject({ success: false })
    expect(await answerAction('okolos.trust.add', { domain: 'bank.example' }, AGENT, s)).toMatchObject({ success: false })
    expect(calls).toEqual([])
  })
})
