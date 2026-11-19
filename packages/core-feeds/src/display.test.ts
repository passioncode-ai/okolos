import { describe, expect, it } from 'vitest'

import { displayFeedName, displayFeedNameRu, isOurFeed, OUR_FEEDS } from './display.js'

/** Stands in for the extension's catalogue lookup. */
const translate = (key: string): string => `«${key}»`

describe('naming a list', () => {
  it('gives our own list a name instead of its identifier', () => {
    expect(displayFeedName('phishing', translate)).toBe('«feedNamePhishing»')
    expect(displayFeedNameRu('phishing')).toBe('Okolos: фишинг')
  })

  it('names our list without the word «список», because every sentence it goes into says it already', () => {
    // «Помечена списком $FEED$», «в списке $FEED$», «из списка $FEED$» and the proxy's
    // «числится в списке …» read «списком Список Okolos: фишинг» while the name began with it;
    // the store image of the block screen showed it (B-215).
    for (const name of Object.values(OUR_FEEDS)) expect(name.ru).not.toMatch(/^спис/i)
  })

  it('leaves a third-party list called what it calls itself', () => {
    // The terminology says these names are not translated. Inventing one would
    // be renaming somebody else's list.
    for (const other of ['OpenPhish', 'PhishTank', 'URLhaus', 'Hudson Rock']) {
      expect(displayFeedName(other, translate)).toBe(other)
      expect(displayFeedNameRu(other)).toBe(other)
    }
  })

  it('says nothing rather than something empty when there is no list', () => {
    for (const nothing of [null, undefined, '']) {
      expect(displayFeedName(nothing, translate)).toBeNull()
      expect(displayFeedNameRu(nothing)).toBeNull()
    }
  })

  it('knows which identifiers are ours to name', () => {
    expect(isOurFeed('phishing')).toBe(true)
    expect(isOurFeed('OpenPhish')).toBe(false)
    // Object.hasOwn, not `in`: `isOurFeed('toString')` must not be true.
    expect(isOurFeed('toString')).toBe(false)
    expect(isOurFeed('constructor')).toBe(false)
  })

  it('carries a key and a Russian name for every list it claims', () => {
    /**
     * The key is how every surface inside the extension names it; the literal is for
     * `apps/proxy`, which has no catalogue. There used to be an English literal here too,
     * and it was the one being printed onto `lang="ru"` pages while the extension read
     * the catalogue (B-24). Two copies of a name, and the unused copy shipped.
     */
    const entries = Object.entries(OUR_FEEDS)
    expect(entries.length).toBeGreaterThan(0)
    for (const [id, name] of entries) {
      expect(name.messageKey, `${id} has no catalogue key`).toMatch(/^feedName[A-Z]/)
      expect(name.ru.length, `${id} has no Russian name`).toBeGreaterThan(3)
      expect(name.ru, `${id} shows its own identifier as a name`).not.toBe(id)
    }
  })
})
