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
    expect(servedPolicyBehind('<p>Обновлено 2026-08-08.</p>', doc)).toMatch(/policy of 2026-08-08.*2026-11-05/)
  })

  it('refuses a served page with no date at all', () => {
    expect(servedPolicyBehind('<p>Not found</p>', doc)).toMatch(/carries no/)
  })

  it('lets a served page as new as the document, or newer, through', () => {
    expect(servedPolicyBehind('<p>Обновлено 2026-11-05.</p>', doc)).toBeNull()
    expect(servedPolicyBehind('<p>Обновлено 2026-11-06.</p>', doc)).toBeNull()
  })

  it('reads the page the store listing names as the policy, not a copy of its address', async () => {
    const { readFileSync } = await import('node:fs')
    const listing = readFileSync(new URL('../docs/store/listing.md', import.meta.url), 'utf8')
    expect(listing).toContain(PRIVACY_URL)
  })
})
