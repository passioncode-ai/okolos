import { describe, expect, it } from 'vitest'

import { policyDate, PRIVACY_URL, servedPolicyBehind } from './privacy-served.mjs'

describe('the served privacy page, before a store archive', () => {
  const doc = '# Что Okolos отправляет\n\nОбновлено 2026-11-05.\n'

  it('reads the date from the document and from the served HTML alike', () => {
    expect(policyDate(doc)).toBe('2026-11-05')
    expect(policyDate('<p>Обновлено 2026-08-08.</p>')).toBe('2026-08-08')
    expect(policyDate('<p>nothing here</p>')).toBeNull()
  })

  it('refuses a served page older than the document: it would deny what the archive sends', () => {
    expect(servedPolicyBehind('<p>Обновлено 2026-08-08.</p>', doc, '<p>x</p>')).toMatch(/policy of 2026-08-08.*2026-11-05/)
  })

  it('refuses a served page with no date at all', () => {
    expect(servedPolicyBehind('<p>Not found</p>', doc, '<p>x</p>')).toMatch(/carries no/)
  })

  it('lets through a served page that carries the document as the generator renders it', () => {
    const html = '<p>Обновлено 2026-11-05.</p><p>Что уходит</p>'
    expect(servedPolicyBehind(`<html><body>${html}</body></html>`, doc, html)).toBeNull()
  })

  it('refuses a served page of the same day with other content: the document changed five times on 2026-11-05', () => {
    const html = '<p>Обновлено 2026-11-05.</p><p>Что уходит теперь</p>'
    expect(servedPolicyBehind('<p>Обновлено 2026-11-05.</p><p>Что уходит</p>', doc, html)).toMatch(/differs/)
  })

  it('names both dates when the served page is newer and still differs (B-215)', () => {
    const behind = servedPolicyBehind('<p>Обновлено 2026-11-06.</p><p>y</p>', doc, '<p>Обновлено 2026-11-05.</p><p>x</p>')
    expect(behind).toMatch(/2026-11-06/)
    expect(behind).toMatch(/2026-11-05/)
  })

  it('reads the page the store listing names as the policy, not a copy of its address', async () => {
    const { readFileSync } = await import('node:fs')
    const listing = readFileSync(new URL('../docs/store/listing.md', import.meta.url), 'utf8')
    expect(listing).toContain(PRIVACY_URL)
  })

  it('reads it at the worker the extension talks to (round 13, seam tier)', async () => {
    const { PROXY_ORIGIN } = await import('../apps/extension/src/config.js')
    expect(PRIVACY_URL).toBe(`${PROXY_ORIGIN}/privacy`)
  })
})
