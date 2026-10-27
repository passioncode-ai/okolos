import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

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
}

describe('a task scope', () => {
  it('is accepted and normalised to origins', () => {
    expect(validateScope(base)).toMatchObject({
      ok: true,
      scope: { origins: { read: ['https://billing.example.com'], write: [] }, profile: 'agent' },
    })
  })

  it('refuses an origin that is not http(s)', () => {
    for (const bad of ['file:///etc/passwd', 'chrome://settings', 'javascript:alert(1)', 'not a url']) {
      const r = validateScope({ ...base, origins: { read: [bad], write: [] } })
      expect(r.ok, bad).toBe(false)
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
