/**
 * The agents' windows: Chrome stable on its own profile, one window per task (K4, REQ-61).
 *
 * The browser starts without a window of its own (`--no-startup-window`) and
 * never with `--enable-automation`, so the person sees no "controlled by
 * automated software" bar (measured: frame 87 px against 143 px with the flag,
 * `docs/superpowers/evidence/2026-10-06-b0-agent-window-run2.json`). A task's
 * window is opened in the background (`newWindow`, `background`): the person's
 * app stays in front. The browser is started on the first window and ended,
 * with its whole process group, by `shutdown` or when its pipe breaks.
 *
 * Two profiles (spec §3, `taskProfileAgent`, `taskProfileDisposable`): `agent`
 * is the profile directory, kept between runs; `disposable` is a browser
 * context of its own inside the same browser, which keeps nothing on disk and
 * is disposed with its window.
 */
import { CdpError, CdpPipe } from '@okolos/cdp-pipe'
import type { CdpTransport, ExitInfo, LaunchOptions } from '@okolos/cdp-pipe'

import { sweepOrphans, systemProbe, type OrphanProbe } from './chrome.js'

/** The browser's own flags; launch adds `--remote-debugging-pipe` and `--user-data-dir`. */
export const AGENT_BROWSER_ARGS: readonly string[] = [
  '--no-startup-window',
  '--no-first-run',
  '--no-default-browser-check',
  '--use-mock-keychain',
  '--password-store=basic',
]

/**
 * Flags a caller may never add: the automation bar, a debugging port any local
 * process could reach (audit #21), and the two launch sets itself.
 */
const REFUSED_FLAGS = ['--enable-automation', '--remote-debugging-port', '--remote-debugging-pipe', '--user-data-dir']

/**
 * The one grace close() gets: ask, SIGTERM, SIGKILL, 2 s each. A constant,
 * because close(NaN) in cdp-pipe would never reach its deadline.
 */
export const CLOSE_GRACE_MS = 2000

export type WindowProfile = 'agent' | 'disposable'

export interface OpenedWindow {
  /** The page target: the task's `windowId`. */
  readonly targetId: string
  /** The flat CDP session on that page; stays in the daemon, never sent to an agent. */
  readonly cdpSessionId: string
}

export interface AgentWindowsOptions {
  readonly binary: string
  readonly profileDir: string
  readonly launch?: (options: LaunchOptions) => Promise<CdpTransport>
  /** For tests (`--host-resolver-rules`); a refused flag throws in the constructor. */
  readonly extraArgs?: readonly string[]
  /** Hears close() giving up with a process left (the daemon records it and marks `window` degraded). */
  readonly onCloseIncomplete?: (pid: number) => void
  /** Hears the browser end, and whether the daemon asked for it. */
  readonly onExit?: (info: ExitInfo, closedWindows: readonly string[]) => void
  readonly probe?: OrphanProbe
}

interface Window {
  readonly cdpSessionId: string
  readonly browserContextId: string | undefined
}

export class AgentWindows {
  private readonly options: AgentWindowsOptions
  private readonly args: readonly string[]
  private browser: Promise<CdpTransport> | undefined
  private readonly windows = new Map<string, Window>()
  private closeIncomplete = false

  constructor(options: AgentWindowsOptions) {
    for (const flag of options.extraArgs ?? []) {
      const name = flag.split('=')[0] ?? flag
      if (REFUSED_FLAGS.includes(name)) {
        throw new TypeError(`agent window: ${name} is never passed to the agents' browser`)
      }
    }
    this.options = options
    this.args = [...AGENT_BROWSER_ARGS, ...(options.extraArgs ?? [])]
  }

  /** The windows open now, by target id. */
  openWindows(): readonly string[] {
    return [...this.windows.keys()]
  }

  /** Opens a task's window in the background, starting the browser if it is not running. */
  async openWindow(profile: WindowProfile = 'agent'): Promise<OpenedWindow> {
    const browser = await this.start()
    let browserContextId: string | undefined
    if (profile === 'disposable') {
      ;({ browserContextId } = await this.send<{ browserContextId: string }>(browser, 'Target.createBrowserContext', {
        disposeOnDetach: true,
      }))
    }
    const { targetId } = await this.send<{ targetId: string }>(browser, 'Target.createTarget', {
      url: 'about:blank',
      newWindow: true,
      background: true,
      ...(browserContextId === undefined ? {} : { browserContextId }),
    })
    const { sessionId } = await this.send<{ sessionId: string }>(browser, 'Target.attachToTarget', { targetId, flatten: true })
    this.windows.set(targetId, { cdpSessionId: sessionId, browserContextId })
    return { targetId, cdpSessionId: sessionId }
  }

  /** The CDP session of an open window, or `undefined` when it is not open. */
  sessionOf(targetId: string): string | undefined {
    return this.windows.get(targetId)?.cdpSessionId
  }

  /** The browser of the open windows, for the verbs' own commands. */
  async transport(): Promise<CdpTransport> {
    return this.start()
  }

  /** Closes a task's window; a disposable profile goes with it. */
  async closeWindow(targetId: string): Promise<void> {
    const window = this.windows.get(targetId)
    if (window === undefined || this.browser === undefined) return
    const browser = await this.browser
    await this.send(browser, 'Target.closeTarget', { targetId })
    if (window.browserContextId !== undefined) {
      await this.send(browser, 'Target.disposeBrowserContext', { browserContextId: window.browserContextId })
    }
    this.windows.delete(targetId)
  }

  /**
   * Ends the browser and its group. Answers whether it ended whole: when close()
   * gave up with a process left, the windows are not counted closed.
   */
  async shutdown(): Promise<{ readonly complete: boolean }> {
    const starting = this.browser
    if (starting === undefined) return { complete: true }
    this.closeIncomplete = false
    let browser: CdpTransport
    try {
      browser = await starting
    } catch {
      this.browser = undefined
      return { complete: true }
    }
    await browser.close(CLOSE_GRACE_MS)
    this.browser = undefined
    if (this.closeIncomplete) return { complete: false }
    this.windows.clear()
    return { complete: true }
  }

  private start(): Promise<CdpTransport> {
    this.browser ??= this.launch()
    return this.browser
  }

  private async launch(): Promise<CdpTransport> {
    const probe = this.options.probe ?? systemProbe
    await sweepOrphans(this.options.profileDir, probe)
    const launch = this.options.launch ?? ((options: LaunchOptions) => CdpPipe.launch(options))
    const browser = await launch({
      binary: this.options.binary,
      args: this.args,
      userDataDir: this.options.profileDir,
      onCloseIncomplete: (pid) => {
        this.closeIncomplete = true
        this.options.onCloseIncomplete?.(pid)
      },
    }).catch((error: unknown) => {
      this.browser = undefined
      throw error
    })
    browser.onExit((info) => {
      // A browser that left on its own takes every task window with it.
      const closed = [...this.windows.keys()]
      if (!info.requested) {
        this.windows.clear()
        this.browser = undefined
        // Its helpers (crashpad, renderers) may outlive it: close() sweeps the group.
        void browser.close(CLOSE_GRACE_MS)
      }
      this.options.onExit?.(info, info.requested ? [] : closed)
    })
    return browser
  }

  /**
   * One command to the browser. A pipe that refuses as closed or exited means
   * the browser is gone or going: its group is ended and the next window starts
   * a new one.
   */
  private async send<T>(browser: CdpTransport, method: string, params: object): Promise<T> {
    try {
      return await browser.send<T>(method, params)
    } catch (error) {
      if (error instanceof CdpError && (error.kind === 'closed' || error.kind === 'exited')) {
        if (this.browser !== undefined) {
          this.browser = undefined
          this.windows.clear()
          await browser.close(CLOSE_GRACE_MS)
        }
      }
      throw error
    }
  }
}
