import { beforeEach, describe, expect, it } from 'vitest'

import { explained, fromCatalogue, resolveArgs, t, useResolver, type Catalogue } from './index.js'

const CATALOGUE: Catalogue = {
  plain: { message: 'Эта страница заблокирована до загрузки' },
  withOne: {
    message: 'Помечена списком $FEED$.',
    placeholders: { feed: { content: '$1' } },
  },
  withTwo: {
    message: 'Помечена списком $FEED$$ENTRY$.',
    placeholders: { feed: { content: '$1' }, entry: { content: '$2' } },
  },
}

beforeEach(() => {
  useResolver(fromCatalogue(CATALOGUE))
})

describe('a message that exists', () => {
  it('is returned as written', () => {
    expect(t('plain')).toBe('Эта страница заблокирована до загрузки')
  })

  it('takes substitutions through named placeholders, as the platform requires', () => {
    /**
     * Not `$1` in the message. A first version did that, and Chrome refused to
     * load the extension at all — a bare `$` outside a declared placeholder is
     * a catalogue error, and a catalogue error is a dead extension, not a
     * broken string. The whole end-to-end suite failed at fixture setup.
     */
    expect(t('withOne', 'OpenPhish')).toBe('Помечена списком OpenPhish.')
    expect(t('withTwo', 'OpenPhish', ', запись от 2026-08-01')).toBe(
      'Помечена списком OpenPhish, запись от 2026-08-01.',
    )
  })

  it('leaves a placeholder alone when nothing was passed for it', () => {
    // Better a visible `$ENTRY$` than a sentence that silently loses half of
    // itself.
    expect(t('withTwo', 'OpenPhish')).toBe('Помечена списком OpenPhish$ENTRY$.')
  })
})

describe('a message that does not exist', () => {
  it('shows the key rather than nothing at all', () => {
    /**
     * The whole design decision, in one assertion. A blank string would render
     * as a warning screen with no warning on it — this product's worst failure
     * mode, and one it has already shipped twice in other forms. The key in
     * brackets is ugly on purpose: it is a bug report on the screen.
     */
    expect(t('nothingHere')).toBe('[nothingHere]')
  })

  it('shows the key before a resolver is installed at all', () => {
    // A page whose entry point forgot to install one must not go quiet.
    useResolver(fromCatalogue({}))
    expect(t('plain')).toBe('[plain]')
  })
})

describe('the resolver the host installs', () => {
  it('is used instead of any built-in lookup', () => {
    // The host is the only thing that knows which browser this is. Chrome
    // resolves through `chrome.i18n`, the tests through a plain object, and
    // this package must not care which.
    useResolver((key) => `resolved:${key}`)
    expect(t('plain')).toBe('resolved:plain')
  })

  it('receives the substitutions untouched', () => {
    let seen: readonly string[] = []
    useResolver((key, subs = []) => {
      seen = subs
      return key
    })
    t('withTwo', 'a', 'b')
    expect(seen).toEqual(['a', 'b'])
  })
})

/**
 * The two catalogues below are the whole point: a row written under one and read under
 * the other. The journal resolves `explainKey` at read time so the reader's language
 * decides — and its *arguments* were stored as finished strings, which quietly undid half
 * of that. A feed's name or "неназванная сторона" is our word, resolved on the day of the
 * write, so a reader who switched language got their own sentence with one word of the
 * old one inside it (B-77).
 */
const RU: Catalogue = {
  listed: {
    message: 'Список $FEED$ отклонён: $WHY$',
    placeholders: { feed: { content: '$1' }, why: { content: '$2' } },
  },
  feedName: { message: 'Okolos: фишинг' },
  unnamed: { message: 'неназванная сторона' },
}

const EN: Catalogue = {
  listed: {
    message: 'The $FEED$ list was refused: $WHY$',
    placeholders: { feed: { content: '$1' }, why: { content: '$2' } },
  },
  feedName: { message: 'Okolos phishing list' },
  unnamed: { message: 'an unnamed party' },
}

describe('an argument that is a message rather than data', () => {
  it('is stored resolved and keyed, so it reads in either language', () => {
    useResolver(fromCatalogue(RU))
    const row = explained('listed', [{ messageKey: 'feedName' }, 'HTTP 503'])

    // Written: legible as-is to anything that does not know this convention — an older
    // build, an export dump, a person reading the raw database.
    expect(row.explainArgs).toEqual(['Okolos: фишинг', 'HTTP 503'])
    expect(row.explainArgKeys).toEqual(['feedName', null])

    // Read later, in another language: the message argument comes back in the reader's
    // words, the data argument comes through untouched.
    useResolver(fromCatalogue(EN))
    expect(t(row.explainKey, ...resolveArgs(row.explainArgs, row.explainArgKeys))).toBe(
      'The Okolos phishing list list was refused: HTTP 503',
    )
  })

  it('leaves data alone, because inventing a translation of it would invent a fact', () => {
    useResolver(fromCatalogue(RU))
    const row = explained('listed', ['some-other-list', 'offline'])
    expect(row.explainArgKeys).toEqual([null, null])

    useResolver(fromCatalogue(EN))
    expect(resolveArgs(row.explainArgs, row.explainArgKeys)).toEqual(['some-other-list', 'offline'])
  })

  it('reads a row written before the convention, in the words it was written with', () => {
    /**
     * No migration, and that is deliberate. A row from an older build has no
     * `explainArgKeys`, and inventing which key each of its arguments came from is how a
     * journal stops being evidence. It degrades to the language of its day — which is
     * exactly what it was before — rather than to a bare identifier.
     */
    useResolver(fromCatalogue(EN))
    expect(resolveArgs(['Okolos: фишинг', 'HTTP 503'])).toEqual([
      'Okolos: фишинг',
      'HTTP 503',
    ])
    expect(resolveArgs(['x'], [])).toEqual(['x'])
  })

  it('treats an empty key as no key, because that is what an unset field looks like', () => {
    useResolver(fromCatalogue(EN))
    expect(resolveArgs(['неназванная сторона'], [''])).toEqual(['неназванная сторона'])
  })

  it('takes no arguments at all without complaining', () => {
    useResolver(fromCatalogue(RU))
    const row = explained('feedName')
    expect(row).toEqual({ explainKey: 'feedName', explainArgs: [], explainArgKeys: [] })
  })
})
