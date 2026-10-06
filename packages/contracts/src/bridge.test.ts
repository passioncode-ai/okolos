import { describe, expect, it } from 'vitest'

import { BRIDGE_REFUSALS, REFUSAL_RETRYABLE, SCOPE_LIMITS, inScope, originOf, refuse, validateScope } from './bridge.js'

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
})
