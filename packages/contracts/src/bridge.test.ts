import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, expectTypeOf, it } from 'vitest'

import type { Confidence, Evidence, VerdictCategory } from './verdict.js'
import type {
  BridgeSessionVerb,
  CensusEntry,
  OpenResult,
  ReadResult,
  SessionOpenResult,
  SnapshotFinding,
  SnapshotResult,
  SnapshotVerdict,
} from './index.js'
import * as contracts from './index.js'

import {
  BRIDGE_REFUSALS,
  BRIDGE_SESSION_VERBS,
  BRIDGE_VERBS,
  REFUSAL_RETRYABLE,
  SCOPE_LIMITS,
  inScope,
  originOf,
  refusalKey,
  refuse,
  validateScope,
  verbAllowed,
} from './bridge.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

function messageKeys(locale: string): Set<string> {
  const file = path.join(root, 'apps/agent/_locales', locale, 'messages.json')
  return new Set(Object.keys(JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>))
}

const base = {
  goal: 'Read the invoices page',
  origins: { read: ['https://billing.example.com/path?x=1'], write: [] },
  verbs: ['open', 'snapshot'],
  ttlSeconds: 600,
  stepBudget: 50,
  profile: 'agent',
}

describe('a task scope', () => {
  it('is accepted and normalised to origins', () => {
    expect(validateScope(base)).toMatchObject({
      ok: true,
      scope: { origins: { read: ['https://billing.example.com'], write: [] }, profile: 'agent' },
    })
  })

  it('names its profile, because a default would hand the person’s logins to a task that never asked', () => {
    const withoutProfile: Record<string, unknown> = { ...base }
    delete withoutProfile.profile
    expect(validateScope(withoutProfile)).toEqual({ ok: false, reason: "profile must be 'agent' or 'disposable'" })
    expect(validateScope({ ...base, profile: 'incognito' }).ok).toBe(false)
    expect(validateScope({ ...base, profile: 'disposable' })).toMatchObject({ ok: true, scope: { profile: 'disposable' } })
  })

  it('refuses an origin that is not http(s)', () => {
    for (const bad of ['file:///etc/passwd', 'chrome://settings', 'javascript:alert(1)', 'not a url']) {
      const r = validateScope({ ...base, origins: { read: [bad], write: [] } })
      expect(r.ok, bad).toBe(false)
    }
  })

  it('refuses this machine and the local network, naming the origin, however the address is spelled', () => {
    // An agent that may read localhost or the router reaches what no page on the
    // web can (ревью F9). The parser canonicalises 127.1, 2130706433 and 0x7f000001
    // to 127.0.0.1, so the check has one spelling to hold.
    const refused: Record<string, string> = {
      'http://localhost:3000/admin': 'http://localhost:3000',
      'http://LOCALHOST./': 'http://localhost.',
      'http://app.localhost/': 'http://app.localhost',
      'http://127.0.0.1/': 'http://127.0.0.1',
      'http://127.255.255.254/': 'http://127.255.255.254',
      'http://127.1/': 'http://127.0.0.1',
      'http://2130706433/': 'http://127.0.0.1',
      'http://0x7f000001/': 'http://127.0.0.1',
      'http://0.0.0.0:8080/': 'http://0.0.0.0:8080',
      'http://[::1]:8080/': 'http://[::1]:8080',
      'http://[0:0:0:0:0:0:0:1]/': 'http://[::1]',
      'http://[::]/': 'http://[::]',
      'http://[::ffff:127.0.0.1]/': 'http://[::ffff:7f00:1]',
      'http://[::ffff:192.168.0.1]/': 'http://[::ffff:c0a8:1]',
      'http://10.0.0.1/': 'http://10.0.0.1',
      'http://10.255.255.255/': 'http://10.255.255.255',
      'http://172.16.0.1/': 'http://172.16.0.1',
      'http://172.31.255.255/': 'http://172.31.255.255',
      'https://192.168.1.1/': 'https://192.168.1.1',
      'http://169.254.169.254/latest/meta-data/': 'http://169.254.169.254',
      'http://[fe80::1]/': 'http://[fe80::1]',
      'http://[febf::1]/': 'http://[febf::1]',
      'http://[fd00::1]/': 'http://[fd00::1]',
      'http://printer.local/': 'http://printer.local',
      'http://printer.local./': 'http://printer.local.',
    }
    for (const [url, origin] of Object.entries(refused)) {
      expect(validateScope({ ...base, origins: { read: [url], write: [] } }), url).toEqual({
        ok: false,
        reason: `origins.read: not a public origin: ${origin}`,
      })
    }
    const write = validateScope({
      ...base,
      origins: { read: ['https://a.example', 'http://10.1.2.3'], write: ['http://10.1.2.3'] },
    })
    expect(write).toEqual({ ok: false, reason: 'origins.read: not a public origin: http://10.1.2.3' })
  })

  it('accepts the public addresses just outside each local range', () => {
    for (const url of [
      'http://126.255.255.255/',
      'http://128.0.0.1/',
      'http://11.0.0.1/',
      'http://172.15.255.255/',
      'http://172.32.0.0/',
      'http://192.169.0.1/',
      'http://169.255.0.1/',
      'http://[fec0::1]/',
      'http://[2001:db8::1]/',
      'https://local.example/',
      'https://notlocal.example/',
      'https://localhost.example/',
    ]) {
      expect(validateScope({ ...base, origins: { read: [url], write: [] } }).ok, url).toBe(true)
    }
  })

  it('refuses write origins that the task does not also read', () => {
    const r = validateScope({ ...base, origins: { read: ['https://a.example'], write: ['https://b.example'] } })
    expect(r).toEqual({ ok: false, reason: 'origins.write must be a subset of origins.read: https://b.example' })
  })

  it('refuses a verb outside the closed set, so an agent cannot ask for eval by name', () => {
    const r = validateScope({ ...base, verbs: ['open', 'eval'] })
    expect(r).toEqual({ ok: false, reason: 'unknown verbs: eval' })
  })

  it('holds the limits on time, steps and reach', () => {
    expect(SCOPE_LIMITS).toMatchObject({ maxTtlSeconds: 3600, maxStepBudget: 500 })
    expect(validateScope({ ...base, ttlSeconds: 3601 })).toEqual({
      ok: false,
      reason: 'ttlSeconds must be an integer from 1 to 3600',
    })
    expect(validateScope({ ...base, stepBudget: 501 })).toEqual({
      ok: false,
      reason: 'stepBudget must be an integer from 1 to 500',
    })
    expect(validateScope({ ...base, ttlSeconds: 3600, stepBudget: 500 }).ok).toBe(true)
    expect(validateScope({ ...base, ttlSeconds: SCOPE_LIMITS.maxTtlSeconds + 1 }).ok).toBe(false)
    expect(validateScope({ ...base, stepBudget: 0 }).ok).toBe(false)
    expect(validateScope({ ...base, stepBudget: 1.5 }).ok).toBe(false)
    const many = Array.from({ length: SCOPE_LIMITS.maxOrigins + 1 }, (_, i) => `https://s${i}.example`)
    expect(validateScope({ ...base, origins: { read: many, write: [] } }).ok).toBe(false)
  })

  it('refuses an empty goal and an empty reach', () => {
    expect(validateScope({ ...base, goal: '   ' }).ok).toBe(false)
    expect(validateScope({ ...base, origins: { read: [], write: [] } }).ok).toBe(false)
    expect(validateScope(null).ok).toBe(false)
  })
})

describe('what a task may open', () => {
  const scope = (() => {
    const r = validateScope(base)
    if (!r.ok) throw new Error(r.reason)
    return r.scope
  })()

  it('is its read origins and nothing else', () => {
    expect(inScope(scope, 'https://billing.example.com/invoices#top')).toBe(true)
    expect(inScope(scope, 'https://billing.example.com.evil.example/')).toBe(false)
    expect(inScope(scope, 'http://billing.example.com/')).toBe(false)
    expect(inScope(scope, 'about:blank')).toBe(false)
  })

  it('reads an origin the way the browser does', () => {
    expect(originOf('HTTPS://Example.COM:443/a')).toBe('https://example.com')
    expect(originOf('https://xn--pple-43d.com/')).toBe('https://xn--pple-43d.com')
  })
})

describe('the verbs', () => {
  const scope = (() => {
    const r = validateScope(base)
    if (!r.ok) throw new Error(r.reason)
    return r.scope
  })()

  it('leave screenshot to Б2, so pixels cannot carry what the cleaner removed', () => {
    expect(BRIDGE_VERBS).not.toContain('screenshot')
    expect(validateScope({ ...base, verbs: ['open', 'screenshot'] })).toEqual({
      ok: false,
      reason: 'unknown verbs: screenshot',
    })
  })

  it('name the two calls that live outside a task', () => {
    expect(BRIDGE_SESSION_VERBS).toEqual(['session.open', 'hygiene.census'])
  })

  it('are the ones the task named, and close, which is never refused', () => {
    expect(scope.verbs).not.toContain('close')
    expect(verbAllowed(scope, 'open')).toBe(true)
    expect(verbAllowed(scope, 'snapshot')).toBe(true)
    expect(verbAllowed(scope, 'read')).toBe(false)
    expect(verbAllowed(scope, 'close')).toBe(true)
  })
})

describe('the answers', () => {
  // The daemon and its tests build these; the package entry is the one door
  // both import through, so the shapes are checked as the entry exports them.
  it('are exported from the package entry with the bridge helpers', () => {
    expect(contracts.BRIDGE_SESSION_VERBS).toBe(BRIDGE_SESSION_VERBS)
    expect(contracts.refusalKey).toBe(refusalKey)
    expect(contracts.verbAllowed).toBe(verbAllowed)
    expectTypeOf<BridgeSessionVerb>().toEqualTypeOf<'session.open' | 'hygiene.census'>()
  })

  it('carry the shapes of spec §2.2, and no fragment-bearing or argv field', () => {
    // windowId is the CDP targetId of the task's window, a string.
    expectTypeOf<SessionOpenResult>().toEqualTypeOf<{ readonly sessionId: string; readonly windowId: string }>()
    expectTypeOf<OpenResult>().toEqualTypeOf<{ readonly url: string }>()
    expectTypeOf<SnapshotFinding>().toEqualTypeOf<{
      readonly kind: VerdictCategory
      readonly confidence: Confidence
      readonly evidence: readonly Evidence[]
    }>()
    expectTypeOf<SnapshotVerdict>().toEqualTypeOf<{
      readonly level: 'clean' | 'finding'
      readonly findings: readonly SnapshotFinding[]
    }>()
    expectTypeOf<SnapshotResult>().toEqualTypeOf<{
      readonly text: string
      readonly refs: readonly string[]
      readonly verdict: SnapshotVerdict
      readonly cursor?: string
      readonly partial: boolean
    }>()
    expectTypeOf<ReadResult>().toEqualTypeOf<{
      readonly text: string
      readonly boundary: { readonly nonce: string; readonly origin: string }
    }>()
    // The census names a process by its executable and the flags the classifier
    // needs, never by its command line, which carries other programs' tokens (F11).
    expectTypeOf<CensusEntry>().toEqualTypeOf<{
      readonly pid: number
      readonly ppid: number
      readonly executable: string
      readonly owner: string | null
      readonly ageSeconds: number
      readonly flags: readonly string[]
      readonly keep: boolean
      readonly reason: string
    }>()
  })
})

describe('a refusal', () => {
  it('says whether asking again can change it, for every code', () => {
    for (const code of BRIDGE_REFUSALS) {
      expect(typeof REFUSAL_RETRYABLE[code], code).toBe('boolean')
    }
    expect(refuse('origin_not_in_task', 'x')).toEqual({
      success: false,
      error: { code: 'origin_not_in_task', message: 'x', retryable: false },
    })
  })

  it('covers a page it could not fully clean and a cursor from another snapshot, and neither is worth retrying', () => {
    // Asking again cannot change either: the page that defeated the cleaner
    // defeats it the same way, and a cursor never becomes another snapshot's.
    for (const code of ['cleaning_incomplete', 'stale_cursor'] as const) {
      expect(BRIDGE_REFUSALS, code).toContain(code)
      expect(REFUSAL_RETRYABLE[code], code).toBe(false)
      expect(refuse(code, 'x').error.retryable, code).toBe(false)
    }
  })

  it('has a string for the person in both languages, for every code', () => {
    const keys = BRIDGE_REFUSALS.map(refusalKey)
    expect(keys).toEqual(BRIDGE_REFUSALS.map((code) => `refusal_${code}`))
    expect(new Set(keys).size).toBe(BRIDGE_REFUSALS.length)
    for (const locale of ['ru', 'en']) {
      const present = messageKeys(locale)
      expect(keys.filter((key) => !present.has(key)), locale).toEqual([])
    }
  })
})
