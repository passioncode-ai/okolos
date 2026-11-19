/** @vitest-environment happy-dom */
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { fromCatalogue, useResolver, type Catalogue } from '@okolos/i18n'
import { describe, expect, it, vi } from 'vitest'

import { renderHelp } from './help.js'

const CATALOGUE = JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, '../../../../apps/extension/_locales/ru/messages.json'), 'utf8'),
) as Catalogue
useResolver(fromCatalogue(CATALOGUE))

describe('«Помощь» in «Ваши данные» (B-232)', () => {
  it('offers support and the privacy page, and nothing that does not exist yet', () => {
    const onSupport = vi.fn()
    const onPrivacy = vi.fn()
    const el = renderHelp(document, { onSupport, onPrivacy })
    expect(el.querySelector('[data-role=help-title]')?.textContent).toBe(CATALOGUE['helpTitle']?.message)
    ;(el.querySelector('[data-role=help-support]') as HTMLButtonElement).click()
    ;(el.querySelector('[data-role=help-privacy]') as HTMLButtonElement).click()
    expect(onSupport).toHaveBeenCalledOnce()
    expect(onPrivacy).toHaveBeenCalledOnce()
    expect(el.querySelectorAll('button')).toHaveLength(2)
  })
})
