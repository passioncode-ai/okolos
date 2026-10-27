import { SEVERITY_ORDER, type Severity } from '@okolos/contracts'
import { mountBanner, type BannerHandle, type BannerHandlers, type BannerProps } from '@okolos/ui'

import { keepSurfaceMounted, type WatchHandle } from './keep-surface.js'

/**
 * One in-page warning panel at a time, and one place that decides which.
 *
 * **Why a slot rather than a variable per module.** Six modules mount banners —
 * injection and password from the content entry, plus `credential.ts`, `traps.ts`,
 * `download.ts` and `lookalike.ts` — and each kept its own `banner` handle. On a
 * fixture that was both a lookalike and poisoned, two of them mounted: same
 * `position: fixed`, same `inset-block-end`/`inset-inline-end`, so one panel was drawn
 * exactly on top of the other and the lower one could not be read at all. Found by a
 * test asking for one banner and getting two (B-69).
 *
 * SCN-031 had already written the rule down for the frame case — "a finding inside a
 * frame stays in the journal rather than becoming a second overlay, because two
 * warnings on one page is how a warning stops being read". That rule is about the
 * **surface**, not about the source, and it had been applied to one source out of
 * three.
 *
 * **The rule, and why replacement is by severity.** The panel holds the worst thing
 * known about the page. A worse finding takes the slot, because a person looking at
 * "this site resembles another" should not keep reading that while something
 * `critical` is also true. A finding that is not worse does not get drawn — it gets a
 * line in the panel that is already up, so the fact is on screen without a second
 * overlay, and it remains in the popup and the journal like every other finding.
 *
 * **The slot also owns the watch.** `keepSurfaceMounted` was wired into two of the six
 * mount sites when it was written, which is exactly the shape this file exists to
 * remove: a rule about the surface, applied per source.
 *
 * **And so it owns the close.** Every module closed its own panel with
 * `handle.destroy()`, which only takes the host out of the document. Nothing told the
 * slot, so its watch read a person's "This is wrong" as the page deleting the warning
 * and drew it again a quarter-second later: the ClickFix, tech-support and
 * outside-link warnings could not be disputed at all from 16bcaa5 (2026-08-20) until
 * round 1 of the B-165 certification measured it. The handle `claim` hands out now
 * releases the slot itself, watch first, when its panel is still the one held; a
 * handle given out on a refusal, or one whose panel was displaced, closes nothing but
 * its own "also here" line.
 */

export interface SlotEnvironment {
  readonly doc: Document
  /** Journalled when a second finding is refused the panel — a silent drop is a lost finding. */
  readonly noteRefused: (kind: string, severity: Severity) => void
  /** Escalation for a page that deletes the surface; see `keep-surface.ts`. */
  readonly escalate: (removals: number) => Promise<void>
  /** How the "also here" line is worded — the slot decides when, not what. */
  readonly alsoLine: (kinds: readonly string[]) => string
  readonly wait: (ms: number) => Promise<void>
  /**
   * Called the first time a panel goes up, so the wait a person actually experiences
   * can be measured in one place.
   *
   * Here rather than at each mount site for the reason the slot exists at all: six
   * sources mounted their own banner, and a measurement taken at one of them is a
   * measurement of that one.
   */
  readonly mounted?: () => void
}

export interface SlotClaim {
  /** What kind of finding this is — `injection`, `lookalike`, `download`, … */
  readonly kind: string
  readonly severity: Severity
  readonly props: BannerProps
  readonly handlers: BannerHandlers
}

interface Held {
  readonly kind: string
  readonly severity: Severity
  /** What `mountBanner` returned: the slot's own, never handed out. */
  readonly handle: BannerHandle
  /** What the claimant was given: the same panel, with a close that tells the slot. */
  readonly given: BannerHandle
  watch: WatchHandle | null
}

export function createSurfaceSlot(env: SlotEnvironment) {
  let held: Held | null = null
  /** Kinds that asked for the panel and did not get it, newest last, no duplicates. */
  const alsoHere: string[] = []

  function watchOver(handle: BannerHandle): WatchHandle {
    return keepSurfaceMounted({
      present: () => handle.host.isConnected,
      remount: () => {
        try {
          env.doc.body.append(handle.host)
          return handle.host.isConnected
        } catch {
          return false
        }
      },
      onChange: (react) => {
        const observer = new MutationObserver(react)
        observer.observe(env.doc.documentElement, { childList: true, subtree: true })
        return () => observer.disconnect()
      },
      wait: env.wait,
      escalate: env.escalate,
    })
  }

  function paintAlso(): void {
    held?.handle.alsoHere(alsoHere.length === 0 ? null : env.alsoLine(alsoHere))
  }

  /** Takes the panel down, watch first; see `release`. */
  function releaseHeld(): void {
    if (held === null) return
    held.watch?.stop()
    held.handle.destroy()
    held = null
    alsoHere.length = 0
  }

  /** Drops one kind's "also here" line, leaving the panel up. */
  function dropLine(kind: string): void {
    const at = alsoHere.indexOf(kind)
    if (at !== -1) alsoHere.splice(at, 1)
    paintAlso()
  }

  /** Mounts a claim's panel and holds it, with the handle its claimant is given. */
  function hold(request: SlotClaim): BannerHandle {
    const handle = mountBanner(env.doc, request.props, request.handlers)
    const given: BannerHandle = {
      host: handle.host,
      root: handle.root,
      showError: (message) => handle.showError(message),
      alsoHere: (message) => handle.alsoHere(message),
      destroy: () => {
        // Only while this panel is the one held: a displaced panel is already gone.
        if (held !== null && held.handle === handle) releaseHeld()
      },
    }
    held = { kind: request.kind, severity: request.severity, handle, given, watch: null }
    held.watch = watchOver(handle)
    return given
  }

  /**
   * What a refused claimant is given: the panel that is up, so its `showError` still
   * lands on something a person can see, and a close that removes only its own line.
   */
  function refusedHandle(kind: string, shown: Held): BannerHandle {
    return {
      host: shown.handle.host,
      root: shown.handle.root,
      showError: (message) => shown.handle.showError(message),
      alsoHere: (message) => shown.handle.alsoHere(message),
      destroy: () => {
        if (held !== null && held.kind !== kind) dropLine(kind)
      },
    }
  }

  /**
   * Asks for the panel. Returns the handle that is actually on screen — which is
   * the existing one when this claim was not worse, so a caller's `showError` still
   * lands on something a person can see.
   */
  function claim(request: SlotClaim): BannerHandle {
    if (held === null) {
      const given = hold(request)
      env.mounted?.()
      paintAlso()
      return given
    }

    if (SEVERITY_ORDER[request.severity] <= SEVERITY_ORDER[held.severity]) {
      // Not worse: the fact goes on the panel that is up, not under it.
      if (request.kind !== held.kind && !alsoHere.includes(request.kind)) {
        alsoHere.push(request.kind)
      }
      env.noteRefused(request.kind, request.severity)
      paintAlso()
      return refusedHandle(request.kind, held)
    }

    // Worse. The displaced finding becomes an "also" line rather than vanishing.
    const displaced = held.kind
    held.watch?.stop()
    held.handle.destroy()
    if (!alsoHere.includes(displaced)) alsoHere.push(displaced)

    const given = hold(request)
    // The new holder cannot also be listed as standing behind itself.
    const self = alsoHere.indexOf(request.kind)
    if (self !== -1) alsoHere.splice(self, 1)
    paintAlso()
    return given
  }

  return {
    claim,

    /**
     * The mount for a module that must know whether it holds the panel.
     *
     * `claim` hands a refused claimant the panel that is up, which is right for a
     * caller that only wants its `showError` seen. The trap watcher keeps a panel as
     * its own and decides from it what else may be raised; holding another module's
     * panel as its own left every later outside link stopped with no explanation and
     * silenced ClickFix for the rest of the page (round 1 of the B-165
     * certification). So this returns null on a refusal: the fact is still a line on
     * the panel that is up, and the module holds nothing.
     */
    mountFor(kind: string, severity: Severity) {
      return (props: BannerProps, handlers: BannerHandlers): BannerHandle | null => {
        const given = claim({ kind, severity, props, handlers })
        return held !== null && held.given === given ? given : null
      }
    },

    /**
     * Takes the panel down, watch first.
     *
     * The order matters: the user closing the banner also removes the host from the
     * document, and a watch still running would read that as the page attacking it
     * (`keep-surface.ts`).
     */
    release(kind?: string): void {
      if (held === null) return
      if (kind !== undefined && kind !== held.kind) {
        // A module tidying up a finding that is not the one on screen. Its line goes,
        // the panel stays.
        dropLine(kind)
        return
      }
      releaseHeld()
    },

    /** What is on screen, for the callers that used to keep their own handle. */
    current(): BannerHandle | null {
      return held?.given ?? null
    },

    /** Which kinds are standing behind the panel — read by tests, not by callers. */
    waiting(): readonly string[] {
      return [...alsoHere]
    },
  }
}

export type SurfaceSlot = ReturnType<typeof createSurfaceSlot>
