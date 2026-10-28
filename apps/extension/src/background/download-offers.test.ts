import { describe, expect, it } from 'vitest'

import { createDownloadOffers } from './download-offers.js'

describe('which downloads a page may discard (B-165, round 5)', () => {
  it('only one the background offered, from the tab it was offered to, once', () => {
    const offers = createDownloadOffers()
    expect(offers.take(5, 1)).toBe(false)
    offers.offer(5, 1)
    expect(offers.take(5, 2)).toBe(false)
    expect(offers.take(5, 1)).toBe(true)
    expect(offers.take(5, 1)).toBe(false)
  })

  it('takes an offer made to an unknown tab from any tab, once', () => {
    const offers = createDownloadOffers()
    offers.offer(6, null)
    expect(offers.take(6, 9)).toBe(true)
    expect(offers.take(6, 9)).toBe(false)
  })

  it('keeps a bounded number of offers, the newest', () => {
    const offers = createDownloadOffers()
    for (let id = 0; id < 40; id += 1) offers.offer(id, 1)
    expect(offers.take(0, 1)).toBe(false)
    expect(offers.take(39, 1)).toBe(true)
  })
})
