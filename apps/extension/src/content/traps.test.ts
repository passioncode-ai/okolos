/** @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { BannerHandle, BannerHandlers, BannerProps } from '@okolos/ui'

import { watchForTraps, type TrapDeps, type TrapWatcher } from './traps.js'

const CLICKFIX_TEXT =
  'Verify you are human: press Win + R, then Ctrl + V, then press Enter.'
const SCARE_TEXT =
  'SECURITY ALERT: your computer has been locked. Windows Defender found a trojan. Call technical support immediately on +1 (888) 555-0142.'

let watcher: TrapWatcher | null = null

type Watched = TrapDeps & {
  exitFullscreen: ReturnType<typeof vi.fn>
  warned: ReturnType<typeof vi.fn>
}

function watch(overrides: Partial<TrapDeps> = {}): Watched {
  const deps = {
    doc: document,
    text: () => document.body.textContent ?? '',
    leave: vi.fn(),
    recover: vi.fn(),
    exitFullscreen: vi.fn(),
    warned: vi.fn(),
    ...overrides,
  } as Watched
  watcher = watchForTraps(deps)
  return deps
}

/** Waits past the watcher's debounce. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 600))

const banner = () => document.querySelector('okolos-banner')

beforeEach(() => {
  document.body.innerHTML = ''
})

afterEach(() => {
  watcher?.stop()
  watcher = null
})

describe('a page that copies a command for you', () => {
  it('interrupts, because the next action is a paste into a run box', async () => {
    document.body.textContent = CLICKFIX_TEXT
    watch()
    document.dispatchEvent(new Event('copy', { bubbles: true }))
    await settle()

    expect(banner()).not.toBeNull()
  })

  it('says the copied text could not be read rather than showing an empty box', async () => {
    document.body.textContent = CLICKFIX_TEXT
    watch()
    document.dispatchEvent(new Event('copy', { bubbles: true }))
    await settle()

    expect(document.body.innerHTML).toBeTruthy()
    expect(banner()).not.toBeNull()
  })

  it('does not claim the page copied it when the user did', async () => {
    // The banner says "this page copied a command for you". On a page the user
    // copied from themselves that sentence is simply untrue, and the signal
    // list is where the claim comes from.
    document.body.textContent = CLICKFIX_TEXT
    const deps = watch()
    const trusted = new Event('copy', { bubbles: true })
    Object.defineProperty(trusted, 'isTrusted', { value: true })
    document.dispatchEvent(trusted)
    await settle()

    expect(deps.warned).toHaveBeenCalled()
    const signals = deps.warned.mock.calls[0]?.[1] as string[]
    expect(signals).not.toContain('copy-not-made-by-you')
  })

  it('leaves a documentation page alone, copy button and all', async () => {
    // The false positive that matters: "copy this, paste it in your terminal,
    // press Enter" with an execCommand copy button behind it is every install
    // page on every developer site.
    document.body.textContent =
      'Install the CLI: copy the command below, paste it into your terminal and press Enter.'
    watch()
    document.dispatchEvent(new Event('copy', { bubbles: true }))
    await settle()

    expect(banner()).toBeNull()
  })
})

describe('a page that takes over the screen', () => {
  it('leaves fullscreen nobody asked for', async () => {
    document.body.textContent = SCARE_TEXT
    const deps = watch()
    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      value: document.body,
    })
    document.dispatchEvent(new Event('fullscreenchange', { bubbles: true }))
    await settle()

    expect(deps.exitFullscreen).toHaveBeenCalled()
    expect(banner()).not.toBeNull()
  })

  it('leaves alone a fullscreen the user just asked for', async () => {
    document.body.textContent = 'Now playing'
    const deps = watch()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', bubbles: true }))
    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      value: document.body,
    })
    document.dispatchEvent(new Event('fullscreenchange', { bubbles: true }))
    await settle()

    expect(deps.exitFullscreen).not.toHaveBeenCalled()
  })
})

describe('an ordinary page', () => {
  it('is left entirely alone', async () => {
    document.body.textContent = 'Welcome to our shop. Free delivery this week.'
    watch()
    await settle()
    expect(banner()).toBeNull()
  })
})

describe('stopping', () => {
  it('removes the warning and stops listening', async () => {
    document.body.textContent = SCARE_TEXT
    watch()
    await settle()
    expect(banner()).not.toBeNull()

    watcher?.stop()
    expect(banner()).toBeNull()
  })
})

describe('what the banner claims', () => {
  it('does not say the page copied anything before it has', async () => {
    // The medium case is the most useful moment to warn — and the moment when
    // "this page copied a command for you" would be a false statement.
    document.body.textContent = CLICKFIX_TEXT
    const deps = watch()
    await settle()

    expect(deps.warned).toHaveBeenCalled()
    const signals = deps.warned.mock.calls[0]?.[1] as string[]
    expect(signals).not.toContain('copy-not-made-by-you')
  })
})

describe('a link that opens a program or a shared folder (B-165)', () => {
  /**
   * The address is read on the click and nowhere else: a page that merely carries a
   * `search-ms:` link has done nothing yet, and a warning on arrival would fire on
   * pages nobody was going to click through. The click is where the browser hands the
   * address to Windows, so it is held there.
   */
  type Mounted = { props: BannerProps; handlers: BannerHandlers }

  function mounted(): {
    mounts: Mounted[]
    mountWarning: (props: BannerProps, handlers: BannerHandlers) => BannerHandle
  } {
    const mounts: Mounted[] = []
    const mountWarning = (props: BannerProps, handlers: BannerHandlers): BannerHandle => {
      mounts.push({ props, handlers })
      const host = document.createElement('div')
      return {
        host,
        root: host.attachShadow({ mode: 'open' }),
        showError: () => undefined,
        alsoHere: () => undefined,
        destroy: () => undefined,
      }
    }
    return { mounts, mountWarning }
  }

  function link(href: string): HTMLAnchorElement {
    const anchor = document.createElement('a')
    anchor.setAttribute('href', href)
    anchor.textContent = 'Open the invoice'
    document.body.append(anchor)
    return anchor
  }

  function click(target: Element, type: 'click' | 'auxclick' = 'click'): MouseEvent {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: type === 'auxclick' ? 1 : 0 })
    target.dispatchEvent(event)
    return event
  }

  it('stops the click and says a program would open', () => {
    const { mounts, mountWarning } = mounted()
    const deps = watch({ mountWarning })
    const event = click(link('search-ms:query=invoice&crumb=location:%5C%5Cfiles.attacker.test%5Cshare'))

    expect(event.defaultPrevented).toBe(true)
    expect(mounts).toHaveLength(1)
    expect(mounts[0]?.props).toMatchObject({ variant: 'clickfix', severity: 'critical' })
    expect(mounts[0]?.props.headline).toBe('[warnOutsideLinkHeadline]')
    expect(mounts[0]?.props.detail).toContain('[warnOutsideLinkProgram]')
    expect(mounts[0]?.props.detail).toContain('[warnOutsideLinkWhere]')
    expect(mounts[0]?.props.detail).toContain('[warnOutsideLinkStopped]')
    expect(deps.warned).toHaveBeenCalledWith('outside-link', ['search-ms', 'opens-a-program'])
  })

  it('leaves a file address with a host to the browser, which refuses it from a page', () => {
    // Chromium and Firefox refuse a `file:` navigation from an http(s) page on their
    // own; a warning that a shared folder opens would describe what cannot happen.
    const { mounts, mountWarning } = mounted()
    const deps = watch({ mountWarning })
    const event = click(link('file://fileserver.attacker.test/share/invoice.lnk'))

    expect(event.defaultPrevented).toBe(false)
    expect(mounts).toHaveLength(0)
    expect(deps.warned).not.toHaveBeenCalled()
  })

  it('stops a click a script made, the way an agent or a page would click', () => {
    // `HTMLElement.click()` dispatches an untrusted click with the same default
    // action; the gate holds it only on a page with a finding, this holds it anywhere.
    const { mounts, mountWarning } = mounted()
    watch({ mountWarning })
    const anchor = link('ms-msdt:/id PCWDiagnostic /skip force')
    let reached = false
    anchor.addEventListener('click', (event) => {
      reached = event.defaultPrevented
    })
    anchor.click()

    expect(reached).toBe(true)
    expect(mounts).toHaveLength(1)
  })

  it('stops the middle click too, which opens the address in a new tab', () => {
    const { mounts, mountWarning } = mounted()
    watch({ mountWarning })
    expect(click(link('ms-appinstaller:?source=https://cdn.attacker.test/a.msix'), 'auxclick').defaultPrevented).toBe(
      true,
    )
    expect(mounts).toHaveLength(1)
  })

  it('reads the link the click landed inside, not only the anchor itself', () => {
    const { mounts, mountWarning } = mounted()
    watch({ mountWarning })
    const anchor = link('search-ms:query=x')
    const inner = document.createElement('span')
    anchor.append(inner)
    expect(click(inner).defaultPrevented).toBe(true)
    expect(mounts).toHaveLength(1)
  })

  it('lets the person through after "This is wrong", for that link on this page', () => {
    const { mounts, mountWarning } = mounted()
    watch({ mountWarning })
    const anchor = link('search-ms:query=x')
    click(anchor)
    mounts[0]?.handlers.onDispute()

    expect(click(anchor).defaultPrevented).toBe(false)
    // A different link is a different decision.
    expect(click(link('ms-msdt:/id x')).defaultPrevented).toBe(true)
  })

  it('leaves when the person chooses to', () => {
    const { mounts, mountWarning } = mounted()
    const deps = watch({ mountWarning })
    click(link('search-ms:query=x'))
    mounts[0]?.handlers.onPrimary()
    expect(deps.leave).toHaveBeenCalled()
  })

  it('leaves ordinary links and the "open in the desktop app" link alone', () => {
    const { mounts, mountWarning } = mounted()
    watch({ mountWarning })
    for (const href of [
      'https://example.test/a',
      'mailto:a@example.test',
      'ms-word:ofe|u|https://contoso.sharepoint.com/a.docx',
      'file:///C:/Users/me/a.pdf',
    ]) {
      expect(click(link(href)).defaultPrevented, href).toBe(false)
    }
    expect(mounts).toHaveLength(0)
  })

  it('stops listening when the watcher stops', () => {
    const { mounts, mountWarning } = mounted()
    watch({ mountWarning })
    watcher?.stop()
    watcher = null
    expect(click(link('search-ms:query=x')).defaultPrevented).toBe(false)
    expect(mounts).toHaveLength(0)
  })
})
