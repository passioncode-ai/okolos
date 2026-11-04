/** @vitest-environment happy-dom */
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { fromCatalogue, useResolver, type Catalogue } from '@okolos/i18n'

import { watchCredentialFields, type CredentialDeps, type CredentialWatcher } from './credential.js'

/**
 * The shipped Russian catalogue, because `default_locale` is `ru` and a fake would let a
 * missing key pass. Installed here for the same reason the other surface tests install
 * it: without a resolver every sentence comes out as `[key]`, and a test that accepted
 * that would be asserting nothing.
 */
const CATALOGUE = JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, '../../_locales/ru/messages.json'), 'utf8'),
) as Catalogue

useResolver(fromCatalogue(CATALOGUE))

const NOW = '2026-08-05T12:00:00.000Z'
let watcher: CredentialWatcher | null = null

function watch(overrides: Partial<CredentialDeps> = {}): CredentialDeps {
  const deps: CredentialDeps = {
    doc: document,
    host: () => 'shop.test',
    now: () => NOW,
    facts: async () => ({
      trusted: false,
      firstSeen: '2026-08-05T09:00:00.000Z',
      secure: true,
      postsTo: null,
      resembles: null,
    }),
    trust: vi.fn(async () => undefined),
    leave: vi.fn(),
    ...overrides,
  }
  watcher = watchCredentialFields(deps)
  return deps
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
const banner = () => document.querySelector('okolos-banner')

function field(html = '<input id="p" type="password">'): HTMLElement {
  document.body.innerHTML = html
  return document.querySelector('input') as HTMLElement
}

beforeEach(() => {
  document.body.innerHTML = ''
})

afterEach(() => {
  watcher?.stop()
  watcher = null
})

describe('when the field is focused', () => {
  it('warns about a site this device has only just met', async () => {
    watch()
    field().dispatchEvent(new Event('focusin', { bubbles: true }))
    await settle()
    expect(banner()).not.toBeNull()
  })

  it('says nothing on a site the user trusts', async () => {
    watch({
      facts: async () => ({
        trusted: true,
        firstSeen: null,
        secure: false,
        postsTo: null,
        resembles: null,
      }),
    })
    field().dispatchEvent(new Event('focusin', { bubbles: true }))
    await settle()
    expect(banner()).toBeNull()
  })

  it('warns only once, however often focus moves', async () => {
    watch()
    const input = field()
    input.dispatchEvent(new Event('focusin', { bubbles: true }))
    await settle()
    document.querySelector('okolos-banner')?.remove()
    input.dispatchEvent(new Event('focusin', { bubbles: true }))
    await settle()
    expect(banner()).toBeNull()
  })

  it('ignores an ordinary text field', async () => {
    watch()
    field('<input id="q" type="text">').dispatchEvent(new Event('focusin', { bubbles: true }))
    await settle()
    expect(banner()).toBeNull()
  })

  it('watches a card number field too', async () => {
    watch()
    field('<input id="c" autocomplete="cc-number">').dispatchEvent(
      new Event('focusin', { bubbles: true }),
    )
    await settle()
    expect(banner()).not.toBeNull()
  })
})

describe('where the form sends it', () => {
  it('notices a form posting to another origin', async () => {
    const deps = watch({
      facts: async () => ({
        trusted: false,
        firstSeen: '2020-01-01T00:00:00.000Z',
        secure: true,
        postsTo: null,
        resembles: null,
      }),
    })
    document.body.innerHTML =
      '<form action="https://collector.test/steal"><input id="p" type="password"></form>'
    document.querySelector('input')?.dispatchEvent(new Event('focusin', { bubbles: true }))
    await settle()

    // Established site, encrypted, nothing else wrong — only the destination.
    expect(banner()).not.toBeNull()
    expect(deps.leave).not.toHaveBeenCalled()
  })

  it('says nothing about a form posting to itself', async () => {
    watch({
      facts: async () => ({
        trusted: false,
        firstSeen: '2020-01-01T00:00:00.000Z',
        secure: true,
        postsTo: null,
        resembles: null,
      }),
    })
    document.body.innerHTML = '<form action="/login"><input id="p" type="password"></form>'
    document.querySelector('input')?.dispatchEvent(new Event('focusin', { bubbles: true }))
    await settle()
    expect(banner()).toBeNull()
  })
})

describe('when we know nothing', () => {
  it('stays silent rather than warning from an empty hand', async () => {
    watch({
      facts: async () => {
        throw new Error('storage unavailable')
      },
    })
    field().dispatchEvent(new Event('focusin', { bubbles: true }))
    await settle()
    expect(banner()).toBeNull()
  })
})

describe('the words for a fact', () => {
  /**
   * The guard returns codes now (B-75). What must not happen is a code reaching the
   * screen: `not-encrypted` where a sentence belongs, or the resolver's `[credFact…]`
   * fallback, on a banner in front of somebody about to type a password.
   *
   * Read through the injected mount rather than the shadow root: the root is **closed**
   * outside the test-hook build, which is why every assertion above it can only check
   * that a banner exists. The injection added in B-69 is the seam that lets a test see
   * what the surface was asked to say.
   */
  /**
   * `postsTo` is read from the field's own form, not from `facts()` — so that case needs
   * a form with a cross-host action rather than a dep override. Found by the assertion
   * failing on exactly that one fact, which is the sort of thing a test that only
   * checked "a banner appeared" could never say.
   */
  async function detailFor(
    facts: Partial<Awaited<ReturnType<CredentialDeps['facts']>>>,
    action?: string,
  ): Promise<string> {
    document.body.replaceChildren()
    watcher?.stop()
    let seen = ''
    watch({
      facts: async () => ({
        trusted: false,
        firstSeen: '2026-08-05T09:00:00.000Z',
        secure: true,
        postsTo: null,
        resembles: null,
        ...facts,
      }),
      mountWarning: (props) => {
        seen = props.detail
        return { host: document.createElement('div'), root: null as never, showError() {}, alsoHere() {}, destroy() {} }
      },
    })
    const field = document.createElement('input')
    field.type = 'password'
    if (action === undefined) {
      document.body.append(field)
    } else {
      const form = document.createElement('form')
      form.setAttribute('action', action)
      form.append(field)
      document.body.append(form)
    }
    field.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    await settle()
    return seen
  }

  it('renders a catalogue sentence for every fact the guard can produce', async () => {
    const cases: Array<
      [string, Partial<Awaited<ReturnType<CredentialDeps['facts']>>>, string | undefined]
    > = [
      ['credFactNotEncrypted', { secure: false }, undefined],
      ['credFactImitates', { resembles: 'paypal.com' }, undefined],
      ['credFactPostsElsewhere', {}, 'https://collector.test/take'],
      ['credFactFirstDay', { firstSeen: NOW }, undefined],
    ]
    /**
     * The value as well as the sentence. Checking only the message's prefix left a plant
     * green: dropping `fact.resembles` from the substitution still produced the words up
     * to the first `$`, and "This address imitates ." is a sentence about nothing.
     */
    const values: Record<string, string | undefined> = {
      credFactImitates: 'paypal.com',
      credFactPostsElsewhere: 'collector.test',
    }
    const missing: string[] = []
    for (const [key, facts, action] of cases) {
      const detail = await detailFor(facts, action)
      const expected = (CATALOGUE[key]?.message ?? '').split('$')[0] ?? ''
      if (expected === '' || !detail.includes(expected)) missing.push(key)
      const value = values[key]
      if (value !== undefined && !detail.includes(value)) missing.push(`${key} (value)`)
    }
    expect(missing, 'these facts did not reach the screen as words').toEqual([])
  })

  it('never puts a bare code on the screen', async () => {
    const detail = await detailFor({ secure: false, resembles: 'paypal.com' })
    for (const code of ['not-encrypted', 'imitates', 'posts-elsewhere', 'first-day']) {
      expect(detail, `the code ${code} reached the screen`).not.toContain(code)
    }
    expect(detail, 'the resolver fell back to a key').not.toMatch(/\[cred/)
  })
})

/**
 * The frame's path, which for two releases did not exist.
 *
 * `watchCredentialFields` stood under `if (isTopFrame)` in the entry point, so an OAuth
 * or payment form in an iframe — the ordinary shape — was watched by nobody (B-79). The
 * watcher now reports instead of drawing when it is not the frame a person looks at, and
 * these say what "instead" means: nothing is mounted, and the facts leave as keys.
 */
describe('when the warning has to leave the frame', () => {
  it('reports the facts and mounts nothing', async () => {
    const report = vi.fn()
    watch({
      report,
      facts: async () => ({
        trusted: false,
        firstSeen: null,
        secure: false,
        postsTo: null,
        resembles: 'paypal.com',
      }),
    })
    field().dispatchEvent(new Event('focusin', { bubbles: true }))
    await settle()

    expect(banner()).toBeNull()
    expect(report).toHaveBeenCalledTimes(1)
    const finding = report.mock.calls[0]?.[0] as {
      severity: string
      lines: { explainKey: string; explainArgs: readonly string[] }[]
    }
    expect(finding.severity).toBe('critical')
    expect(finding.lines.map((line) => line.explainKey)).toContain('credFactNotEncrypted')
    const imitates = finding.lines.find((line) => line.explainKey === 'credFactImitates')
    expect(imitates?.explainArgs).toEqual(['paypal.com'])
  })

  /**
   * The plant this pair exists for: a report that carried the finished sentence would
   * pass every assertion above about *whether* something was reported and hide that the
   * frame decided the wording. Keys are checked because keys are the contract.
   */
  it('sends no finished sentence — the surface that draws owns the words', async () => {
    const report = vi.fn()
    watch({ report })
    field().dispatchEvent(new Event('focusin', { bubbles: true }))
    await settle()

    const finding = report.mock.calls[0]?.[0] as { lines: { explainKey: string }[] }
    for (const line of finding.lines) {
      expect(line.explainKey).not.toContain(' ')
      expect(CATALOGUE[line.explainKey]).toBeDefined()
    }
  })

  it('says nothing about a site the user trusts, in a frame either', async () => {
    const report = vi.fn()
    watch({
      report,
      facts: async () => ({
        trusted: true,
        firstSeen: null,
        secure: false,
        postsTo: null,
        resembles: null,
      }),
    })
    field().dispatchEvent(new Event('focusin', { bubbles: true }))
    await settle()

    expect(report).not.toHaveBeenCalled()
    expect(banner()).toBeNull()
  })
})

/**
 * The end of a judgement, said out loud.
 *
 * A test that asserts "no warning on an ordinary text field" has to know when the watcher
 * has finished looking, and the only thing it had was a fixed wait: under load the wait
 * ran out before the judgement did, and the assertion passed on a check that had not run
 * (B-169). `judged` is that signal. It fires once the decision is on screen, and never for
 * a judgement that could not be made, because "the facts could not be read" is not "the
 * field was judged safe".
 */
describe('saying that a focus has been judged', () => {
  it('says so at once for a field that asks for nothing sensitive', () => {
    const judged = vi.fn()
    watch({ judged })
    field('<input id="u" type="text">').dispatchEvent(new Event('focusin', { bubbles: true }))

    expect(judged).toHaveBeenCalledTimes(1)
    expect(banner()).toBeNull()
  })

  it('says so for a password field only once the warning is on screen', async () => {
    let drawn: Element | null = null
    const judged = vi.fn(() => {
      drawn = banner()
    })
    watch({ judged })
    field().dispatchEvent(new Event('focusin', { bubbles: true }))

    expect(judged).not.toHaveBeenCalled()
    await settle()
    expect(judged).toHaveBeenCalledTimes(1)
    expect(drawn, 'judged fired before the warning was drawn').not.toBeNull()
  })

  it('says so after deciding to stay silent', async () => {
    const judged = vi.fn()
    watch({
      judged,
      facts: async () => ({
        trusted: true,
        firstSeen: null,
        secure: true,
        postsTo: null,
        resembles: null,
      }),
    })
    field().dispatchEvent(new Event('focusin', { bubbles: true }))
    await settle()

    expect(judged).toHaveBeenCalledTimes(1)
    expect(banner()).toBeNull()
  })

  it('says so after a frame has handed the facts on', async () => {
    const report = vi.fn()
    const judged = vi.fn(() => expect(report).toHaveBeenCalledTimes(1))
    watch({ report, judged })
    field().dispatchEvent(new Event('focusin', { bubbles: true }))
    await settle()

    expect(judged).toHaveBeenCalledTimes(1)
  })

  it('says so for a password field focused again, which is not asked twice', async () => {
    const judged = vi.fn()
    watch({ judged })
    const input = field()
    input.dispatchEvent(new Event('focusin', { bubbles: true }))
    await settle()
    input.dispatchEvent(new Event('focusin', { bubbles: true }))
    await settle()

    expect(judged).toHaveBeenCalledTimes(2)
  })

  it('answers a second focus only once the first one has been decided', async () => {
    let release: () => void = () => undefined
    const facts = new Promise<void>((resolve) => {
      release = resolve
    })
    const judged = vi.fn()
    watch({
      judged,
      facts: async () => {
        await facts
        return { trusted: false, firstSeen: null, secure: true, postsTo: null, resembles: null }
      },
    })
    const input = field()
    input.dispatchEvent(new Event('focusin', { bubbles: true }))
    input.dispatchEvent(new Event('focusin', { bubbles: true }))
    await settle()
    expect(judged, 'a focus was called judged while the first decision was pending').not.toHaveBeenCalled()

    release()
    await settle()
    expect(judged).toHaveBeenCalledTimes(2)
    expect(banner()).not.toBeNull()
  })

  it('says so in a frame only after the embedding page has the report', async () => {
    let delivered: () => void = () => undefined
    const report = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          delivered = resolve
        }),
    )
    const judged = vi.fn()
    watch({ report, judged })
    field().dispatchEvent(new Event('focusin', { bubbles: true }))
    await settle()
    expect(report).toHaveBeenCalledTimes(1)
    expect(judged, 'judged before the report arrived').not.toHaveBeenCalled()

    delivered()
    await settle()
    expect(judged).toHaveBeenCalledTimes(1)
  })

  it('stays quiet when the facts could not be read, because nothing was judged', async () => {
    const judged = vi.fn()
    watch({
      judged,
      facts: async () => {
        throw new Error('worker asleep')
      },
    })
    field().dispatchEvent(new Event('focusin', { bubbles: true }))
    await settle()

    expect(judged).not.toHaveBeenCalled()
  })
})
