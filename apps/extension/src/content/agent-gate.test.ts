/** @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GateChoice, GateDecision, UnresolvedFinding } from '@okolos/core-gate'

import { AgentGate, type GateEnvironment } from './agent-gate.js'

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fromCatalogue, useResolver, type Catalogue } from '@okolos/i18n'

/** The shipped Russian catalogue: `default_locale` is `ru`, and a fake would let a missing key pass. */
const CATALOGUE = JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, '../../_locales/ru/messages.json'), 'utf8'),
) as Catalogue

useResolver(fromCatalogue(CATALOGUE))

const FINDING: UnresolvedFinding = { id: 'f1', summary: 'Hidden instruction on this page' }

interface Harness {
  readonly gate: AgentGate
  readonly ask: ReturnType<typeof vi.fn>
  readonly journal: GateDecision[]
}

const installed: AgentGate[] = []

function install(overrides: Partial<GateEnvironment> = {}): Harness {
  const journal: GateDecision[] = []
  const ask = vi.fn(async (): Promise<GateChoice> => 'block')
  let n = 0
  const env: GateEnvironment = {
    doc: document,
    unresolved: () => [FINDING],
    ask: ask as unknown as GateEnvironment['ask'],
    expiry: () => new Promise<void>(() => {}),
    journal: (decision) => journal.push(decision),
    newId: () => `a${(n += 1)}`,
    // The ordinary browser by default; the driven one is stated per test.
    automated: () => false,
    ...overrides,
  }
  const gate = new AgentGate(env)
  gate.install()
  installed.push(gate)
  return { gate, ask, journal }
}

/**
 * A synthetic event, which is what an agent acting through page script
 * produces: `isTrusted` is false. It is *not* what a browser agent driving
 * Chrome produces — measured 2026-08-08, automation input is trusted, which is
 * why the gate also reads whether the browser is being driven.
 */
function scripted(type: string): Event {
  return new Event(type, { bubbles: true, cancelable: true })
}

function human(type: string): Event {
  const event = scripted(type)
  Object.defineProperty(event, 'isTrusted', { value: true })
  return event
}

function form(html = '<input name="q"><button type="submit">Go</button>'): HTMLFormElement {
  document.body.innerHTML = `<form action="https://bank.test/transfer?amount=900" aria-label="Transfer">${html}</form>`
  return document.querySelector('form') as HTMLFormElement
}

/** Lets the promise chain inside the interceptor settle. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  document.body.innerHTML = ''
})

afterEach(() => {
  // Listeners live on the document, not on the markup. A gate left installed
  // would intercept the next test's events before its own gate ever saw them.
  while (installed.length > 0) installed.pop()?.uninstall()
})

describe('when the page has nothing unresolved', () => {
  it('does not touch a scripted submit', async () => {
    const { ask } = install({ unresolved: () => [] })
    const event = scripted('submit')
    form().dispatchEvent(event)
    await settle()

    expect(event.defaultPrevented).toBe(false)
    expect(ask).not.toHaveBeenCalled()
  })
})

describe('when the page carries an unresolved finding', () => {
  it('holds a scripted submit before it leaves the page', async () => {
    const { ask } = install()
    const event = scripted('submit')
    form().dispatchEvent(event)
    await settle()

    expect(event.defaultPrevented).toBe(true)
    expect(ask).toHaveBeenCalledTimes(1)
  })

  it('does not hold a submit the person made themselves', async () => {
    const { ask } = install()
    const event = human('submit')
    form().dispatchEvent(event)
    await settle()

    expect(event.defaultPrevented).toBe(false)
    expect(ask).not.toHaveBeenCalled()
  })

  it('holds a trusted submit when the browser says it is being driven', async () => {
    // The wiring, not the rule. `assessAction` weighs `automated`; whether this
    // file ever asks for it is a separate question, and the answer was no until
    // now — which is how a browser agent's trusted clicks passed as the user's.
    const { ask } = install({ automated: () => true })
    const event = human('submit')
    form().dispatchEvent(event)
    await settle()

    expect(event.defaultPrevented).toBe(true)
    expect(ask).toHaveBeenCalledTimes(1)
  })

  it('keeps the page from seeing the held event', async () => {
    install()
    const seen = vi.fn()
    const f = form()
    f.addEventListener('submit', seen)
    f.dispatchEvent(scripted('submit'))
    await settle()

    expect(seen).not.toHaveBeenCalled()
  })

  it('tells the user which form, and where it was going', async () => {
    const { ask } = install()
    form().dispatchEvent(scripted('submit'))
    await settle()

    const action = ask.mock.calls[0]?.[0]
    expect(action.description).toContain('Transfer')
    expect(action.target).toBe('https://bank.test/transfer')
    // The query string is where the amount lives. It never reaches the surface.
    expect(action.target).not.toContain('900')
  })
})

describe('what happens after the decision', () => {
  it('does not resubmit when the user blocks', async () => {
    install({ ask: async () => 'block' })
    const f = form()
    const resubmit = vi.spyOn(f, 'requestSubmit').mockImplementation(() => {})
    f.dispatchEvent(scripted('submit'))
    await settle()

    expect(resubmit).not.toHaveBeenCalled()
  })

  it('performs the action when the user allows it once', async () => {
    install({ ask: async () => 'allow-once' })
    const f = form()
    const resubmit = vi.spyOn(f, 'requestSubmit').mockImplementation(() => {})
    f.dispatchEvent(scripted('submit'))
    await settle()

    expect(resubmit).toHaveBeenCalledTimes(1)
  })

  it('does not gate the action it was just told to allow', async () => {
    // Without this the allowed action is caught by the same listener and the
    // user is asked forever.
    const ask = vi.fn(async (): Promise<GateChoice> => 'allow-once')
    install({ ask })
    const f = form()
    vi.spyOn(f, 'requestSubmit').mockImplementation(() => {
      f.dispatchEvent(scripted('submit'))
    })
    f.dispatchEvent(scripted('submit'))
    await settle()

    expect(ask).toHaveBeenCalledTimes(1)
  })

  it('journals every held action, blocked or allowed', async () => {
    const { journal } = install({ ask: async () => 'allow-once' })
    form().dispatchEvent(scripted('submit'))
    await settle()

    expect(journal).toHaveLength(1)
    expect(journal[0]).toMatchObject({ outcome: 'allowed-once', findingIds: ['f1'] })
  })

  it('does not journal pages where nothing was held', async () => {
    const { journal } = install({ unresolved: () => [] })
    form().dispatchEvent(scripted('submit'))
    await settle()

    expect(journal).toEqual([])
  })

  it('blocks and journals when the surface cannot be shown', async () => {
    const { journal } = install({
      ask: async () => {
        throw new Error('no room to draw')
      },
    })
    const f = form()
    const resubmit = vi.spyOn(f, 'requestSubmit').mockImplementation(() => {})
    f.dispatchEvent(scripted('submit'))
    await settle()

    expect(resubmit).not.toHaveBeenCalled()
    expect(journal[0]).toMatchObject({ outcome: 'blocked', reason: 'unavailable' })
  })

  it('blocks when nobody answers', async () => {
    const { journal } = install({
      ask: () => new Promise<GateChoice>(() => {}),
      expiry: async () => undefined,
    })
    form().dispatchEvent(scripted('submit'))
    await settle()

    expect(journal[0]).toMatchObject({ outcome: 'blocked', reason: 'timeout' })
  })
})

describe('clicks', () => {
  it('holds a scripted click that would navigate away', async () => {
    const { ask } = install()
    document.body.innerHTML = '<a href="https://elsewhere.test/pay">Pay</a>'
    const link = document.querySelector('a') as HTMLAnchorElement
    const event = scripted('click')
    link.dispatchEvent(event)
    await settle()

    expect(event.defaultPrevented).toBe(true)
    expect(ask.mock.calls[0]?.[0].kind).toBe('navigation')
  })

  it('holds a scripted click on a submit button', async () => {
    const { ask } = install()
    const f = form()
    ;(f.querySelector('button') as HTMLButtonElement).dispatchEvent(scripted('click'))
    await settle()

    expect(ask.mock.calls[0]?.[0].kind).toBe('form-submit')
  })

  it('recognises a download for what it is', async () => {
    const { ask } = install()
    document.body.innerHTML = '<a href="https://files.test/setup.exe" download>Get it</a>'
    ;(document.querySelector('a') as HTMLAnchorElement).dispatchEvent(scripted('click'))
    await settle()

    expect(ask.mock.calls[0]?.[0].kind).toBe('download')
  })

  it('ignores scripted clicks that go nowhere', async () => {
    // Pages click their own tabs, menus and cards constantly. Holding those
    // would make the extension the thing that broke the web.
    const { ask } = install()
    document.body.innerHTML = '<div id="tab">Details</div>'
    const event = scripted('click')
    ;(document.querySelector('#tab') as HTMLElement).dispatchEvent(event)
    await settle()

    expect(event.defaultPrevented).toBe(false)
    expect(ask).not.toHaveBeenCalled()
  })
})

describe('the boundary, stated so it is a decision and not an oversight', () => {
  it('does not hold a scripted click on a button that belongs to no form', async () => {
    /**
     * This is the gap, pinned deliberately. `#describe` returns null for a
     * control outside a form, on the reasoning that it is "not an action
     * leaving the page" — true of a tab or a card, and false of the button
     * every modern application uses to move money, which fires `fetch` and
     * navigates nowhere.
     *
     * The premise held when actions were navigations. It does not hold for a
     * single-page application, and SCN-010's "no action proceeds without an
     * explicit human decision" is wider than what this gate delivers. The
     * scenario now says so in its Known limit; this test is the other half, so
     * that a change here has to be a change to a stated decision.
     *
     * Closing it properly means intercepting fetch and XHR that no human
     * gesture started — a bigger change, with the noise risk the code comment
     * beside `#describe` warns about. Tracked, not forgotten.
     */
    const { ask } = install()
    document.body.innerHTML = '<button id="pay" type="button">Transfer</button>'
    const event = scripted('click')
    ;(document.querySelector('#pay') as HTMLElement).dispatchEvent(event)
    await settle()

    expect(event.defaultPrevented, 'the action is not held today').toBe(false)
    expect(ask, 'and the user is not asked').not.toHaveBeenCalled()
  })

  it('still holds the same button once it is inside a form', async () => {
    // The difference is the form, and nothing else. Stated here so the shape
    // of the gap is unmistakable to whoever closes it.
    const { ask } = install()
    document.body.innerHTML =
      '<form action="/transfer" aria-label="Transfer"><button id="pay">Transfer</button></form>'
    const event = scripted('click')
    ;(document.querySelector('#pay') as HTMLElement).dispatchEvent(event)
    await settle()

    expect(event.defaultPrevented).toBe(true)
    expect(ask).toHaveBeenCalled()
  })
})

describe('actions nobody can name', () => {
  it('blocks a link whose destination will not parse, without asking', async () => {
    const { ask, journal } = install()
    document.body.innerHTML = '<a href="javascript:transfer()">Continue</a>'
    const event = scripted('click')
    ;(document.querySelector('a') as HTMLAnchorElement).dispatchEvent(event)
    await settle()

    expect(event.defaultPrevented).toBe(true)
    expect(ask).not.toHaveBeenCalled()
    expect(journal[0]).toMatchObject({ outcome: 'blocked', reason: 'unidentified' })
  })

  it('blocks a link that hands its address to a Windows program, and journals no address', async () => {
    // B-165 read `safeUrl` dropping every scheme but http(s) as a silent drop. On a
    // page with a finding it is not silent: the click is blocked outright, because
    // nothing honest can be asked about an address the gate will not print. On a
    // page without one the trap watcher holds the same click (`traps.ts`), so both
    // roads are covered, and the address never reaches the journal from here.
    for (const href of [
      'search-ms:query=x&crumb=location:%5C%5Cfiles.attacker.test%5Cs',
      'ms-msdt:/id PCWDiagnostic',
      'file://fileserver.attacker.test/share/a.lnk',
    ]) {
      const { ask, journal } = install()
      document.body.innerHTML = '<a>Open</a>'
      ;(document.querySelector('a') as HTMLAnchorElement).setAttribute('href', href)
      const event = scripted('click')
      ;(document.querySelector('a') as HTMLAnchorElement).dispatchEvent(event)
      await settle()

      expect(event.defaultPrevented, href).toBe(true)
      expect(ask, href).not.toHaveBeenCalled()
      expect(journal[0], href).toMatchObject({ outcome: 'blocked', reason: 'unidentified' })
      expect(JSON.stringify(journal[0]), href).not.toContain('attacker')
      installed.pop()?.uninstall()
    }
  })

  it('blocks a submit event fired at something that is not a form', async () => {
    const { journal } = install()
    document.body.innerHTML = '<div id="fake"></div>'
    ;(document.querySelector('#fake') as HTMLElement).dispatchEvent(scripted('submit'))
    await settle()

    expect(journal[0]).toMatchObject({ reason: 'unidentified' })
  })
})

describe('the page survives us', () => {
  it('does not throw when the form vanishes between the hold and the allow', async () => {
    install({ ask: async () => 'allow-once' })
    const f = form()
    f.dispatchEvent(scripted('submit'))
    f.remove()
    document.body.innerHTML = ''

    await expect(settle()).resolves.toBeUndefined()
  })
})

describe('describing an action may not be a way of letting it happen', () => {
  /**
   * `#describe` runs before `preventDefault`, so anything it throws leaves the
   * interceptor — and **a listener that throws does not cancel its event.** The
   * action proceeded, ungated, with an exception in the console.
   *
   * Not hypothetical: `newId` was `crypto.randomUUID()`, which is
   * `[SecureContext]`, and the manifest matches plain-HTTP pages. On any of them
   * the description's first line threw `TypeError`, so the gate was a no-op on
   * exactly the pages a poisoned document is cheapest to serve from.
   */
  it('holds the action when the id cannot be made, which is the http case', async () => {
    const { journal } = install({
      newId: () => {
        throw new TypeError('crypto.randomUUID is not a function')
      },
      automated: () => false,
    })
    const event = scripted('submit')
    form().dispatchEvent(event)
    await settle()

    expect(event.defaultPrevented, 'the gate let a scripted submit through').toBe(true)
    expect(journal.map((d) => d.outcome)).toEqual(['blocked'])
  })

  it('blocks rather than asking, because a modal that says nothing invites a reflexive allow', async () => {
    /**
     * The fallback action is `kind: 'unknown'`, and `assessAction` already had a
     * considered answer for that: block, do not ask, and journal the reason. That
     * is stronger than what this test first asserted — I expected a modal, and the
     * decision logic was right and I was not.
     */
    const { ask, journal } = install({
      newId: () => {
        throw new TypeError('no randomUUID here')
      },
    })
    form().dispatchEvent(scripted('submit'))
    await settle()

    expect(ask).not.toHaveBeenCalled()
    expect(journal[0]).toMatchObject({ outcome: 'blocked', reason: 'unidentified' })
    // And the id is the fallback's own, so the record is about this event.
    expect(journal[0]?.actionId).toMatch(/^fallback-\d+$/)
  })

  it('holds even when telling a person from a driver is what failed', async () => {
    /**
     * The recovery path may not depend on anything that could have broken. The
     * first version of it called `env.newId()` again — and `newId` was what threw
     * — so the fallback threw too and the action went through; my own test caught
     * that, which is the argument for writing the test that supplies a failure.
     *
     * `automated` failing is the sharper case: if we cannot tell whether the
     * browser is being driven, then guessing "a human did this" is the guess that
     * lets the action out. It assumes driven.
     */
    const { journal } = install({
      newId: () => {
        throw new TypeError('nothing works')
      },
      automated: () => {
        throw new TypeError('nothing works')
      },
    })
    const event = human('submit')
    form().dispatchEvent(event)
    await settle()

    expect(event.defaultPrevented, 'a trusted event with no way to check for a driver').toBe(true)
    expect(journal.map((d) => d.outcome)).toEqual(['blocked'])
  })

  it('gives each invented description its own id', async () => {
    // Two actions journalled under one id are one action in the record.
    const { journal } = install({
      newId: () => {
        throw new TypeError('no randomUUID here')
      },
    })
    form().dispatchEvent(scripted('submit'))
    await settle()
    form().dispatchEvent(scripted('submit'))
    await settle()

    const ids = journal.map((d) => d.actionId)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.length).toBe(2)
  })

  it('does not let a throw escape into the page', async () => {
    // An exception out of a capture-phase listener lands in the page's console
    // and, on a page that installed its own handler, in the page's code.
    const errors: unknown[] = []
    const onError = (event: ErrorEvent) => errors.push(event.error)
    window.addEventListener('error', onError)
    install({
      newId: () => {
        throw new TypeError('no randomUUID here')
      },
    })
    form().dispatchEvent(scripted('submit'))
    await settle()
    window.removeEventListener('error', onError)

    expect(errors).toEqual([])
  })
})

describe('before the page has been read at all', () => {
  /**
   * `[]` and "not asked yet" were the same value, and the gate read the second as
   * the first: between `document_idle` and the verdict returning it answered
   * "nothing unresolved here, nothing to weigh". That is an unrun check reported
   * as a passed one — what ADR-0004 exists to forbid — and nothing was written
   * down either. The window is short and it is the window a page controls: it can
   * fire its scripted click on the first line of its own body.
   */
  it('records that an action went through, rather than passing in silence', async () => {
    const notes: Array<{ description: string }> = []
    const { ask } = install({
      unresolved: () => null,
      noteUnread: (action) => notes.push(action),
    })
    const event = scripted('submit')
    form().dispatchEvent(event)
    await settle()

    // Not held: holding every click on every page for the length of a scan is how
    // an extension becomes the thing that broke the web.
    expect(event.defaultPrevented).toBe(false)
    expect(ask).not.toHaveBeenCalled()
    expect(notes, 'the action passed with nothing written down').toHaveLength(1)
    expect(notes[0]?.description).toContain('Transfer')
  })

  it('says nothing at all once the page has been read and found clean', async () => {
    // The distinction is the whole point: an empty list is an answer, and `null`
    // is the absence of one. A note for every click on every clean page would be
    // noise that teaches the reader to skip the journal.
    const notes: unknown[] = []
    install({ unresolved: () => [], noteUnread: () => notes.push(1) })
    form().dispatchEvent(scripted('submit'))
    await settle()
    expect(notes).toEqual([])
  })

  it('works without a recorder, because the note is not what makes it safe', async () => {
    // `noteUnread` is optional in the interface. A caller that does not supply it
    // must not turn an unread page into a thrown exception inside a listener.
    const errors: unknown[] = []
    const onError = (event: ErrorEvent) => errors.push(event.error)
    window.addEventListener('error', onError)
    install({ unresolved: () => null })
    form().dispatchEvent(scripted('submit'))
    await settle()
    window.removeEventListener('error', onError)
    expect(errors).toEqual([])
  })

  it('gates normally once the verdict has arrived', async () => {
    // The window closes. This is the assertion that the fix is a window and not
    // a permanent hole.
    let read = false
    const { ask } = install({ unresolved: () => (read ? [FINDING] : null) })
    form().dispatchEvent(scripted('submit'))
    await settle()
    expect(ask).not.toHaveBeenCalled()

    read = true
    const second = scripted('submit')
    form().dispatchEvent(second)
    await settle()
    expect(second.defaultPrevented).toBe(true)
    expect(ask).toHaveBeenCalledTimes(1)
  })
})
