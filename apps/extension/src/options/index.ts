import {
  analysePackage,
  type InventoryChange,
  type PackageReport,
  type StandingFinding,
} from '@okolos/core-extensions'
import { changePasswordUrl } from '@okolos/core-credential'
import { buildChecklist, type StepProgress } from '@okolos/core-recovery'
import { diffSince } from '@okolos/core-queue'
import { t, useResolver } from '@okolos/i18n'
import { detectPlatform } from '@okolos/platform'
import { buildQueue } from '@okolos/core-queue'
import { EXPORT_WORDS } from './export-words.js'
import { toQueueItems } from '../popup/state.js'
import {
  renderDataControls,
  renderExtensions,
  renderIncidentPicker,
  renderJournal,
  renderLeaks,
  renderOverview,
  renderQueue,
  renderRecovery,
  renderSelfAudit,
  type AuditWindow,
  renderStorageProblem,
  renderTrusted,
  shortDate,
  shortTime,
  type AreaId,
  type AreaRow,
  type AttentionItem,
  type ExtensionsState,
  type LeakKeyPanel,
  type LeaksState,
  type OverviewHandlers,
  type PanelState,
  type TrustedDomain,
} from '@okolos/ui'
import {
  DATA_KIND_KEY,
  DB_VERSION,
  RETENTION_DAYS,
  StorageUnavailable,
  exportAll,
  openDb,
  resetStorage,
  type JournalRecord,
  wipeAll,
} from '@okolos/storage'

import { mapJournal } from '../popup/state.js'
import { answered } from './answered.js'
import { keepingFocus, markFocus } from './keep-focus.js'
import { hasLeakKey, removeLeakKey, saveLeakKey } from './leak-key.js'
import { showFailure } from './failure.js'
import { whilePending } from './pending.js'
import {
  hashFor,
  loadingRows,
  optionsPageFor,
  recoveryHref,
  routeFor,
  type Route,
} from './views.js'
import '../pages.css'

/**
 * The options page is, first of all, the self-audit panel: the product's
 * central claim in a form the user can read and export. Beneath it sit the
 * journal — what changed since the last check, not an ever-growing red list —
 * and the data controls, so "you own what this stores" is something a person
 * can act on rather than a sentence in a README.
 */

const platform = detectPlatform()

/**
 * Before anything paints.
 *
 * This page's own strings are still literals — the catalogue reaches it through
 * `@okolos/ui`, whose overlays are localised. Installing the resolver here is
 * one line and makes the invariant true now rather than at the moment someone
 * translates this screen and cannot see why it renders `[key]`.
 */
useResolver((key, substitutions) => platform.message(key, substitutions))

const root = document.getElementById('root')

/**
 * The leak check is user-initiated, always. Nothing is looked up in the
 * background: the address the user types is theirs, and sending it anywhere is
 * a decision they make each time by pressing the button.
 */
let leaks: LeaksState = { kind: 'idle' }
let address = ''

/**
 * The address field is built once and moved between repaints, never rebuilt.
 *
 * This page repaints wholesale — `root.replaceChildren` — and the sections
 * above it each await a database read, so a repaint takes real time while the
 * page is live. Rebuilding the input meant that anything typed during that
 * window was thrown away with the old node: the value, the caret, the focus,
 * and any composition an IME had in progress. Appending an element that is
 * already in the document moves it, so the live node and everything attached
 * to it survive the swap.
 *
 * It is also the difference between a working leak check and a button that
 * does nothing, which is how this was found: a check clicked while the page
 * was still settling read an empty address and returned in silence.
 */
const addressField = (() => {
  const field = document.createElement('input')
  field.type = 'email'
  field.setAttribute('data-role', 'address')
  field.placeholder = 'you@example.com'
  field.addEventListener('input', () => {
    address = field.value
  })
  return field
})()

function leaksSection(): HTMLElement {
  const container = document.createElement('div')
  // Named so the stylesheet can treat the field and the panel as one block.
  // Without it the address input floats between two cards, which is what the
  // first screenshot of the styled build showed.
  container.setAttribute('data-role', 'leaks-section')

  // The slot now lives inside the panel, where the field belongs: under the
  // description and above the button that reads it. The panel names the place;
  // this page fills it in `renderPanel`, synchronously after the swap, because
  // moving the live input into a tree that has not been swapped in yet takes it
  // out of the document for as long as the remaining sections take to load.
  container.append(
    renderLeaks(document, leaks, {
      onCheck: () => {
        void (async () => {
          // Silence was the old answer here, and it is the worst one: the
          // page looks exactly as it did before the press, so the user cannot
          // tell a refusal from a broken button — and neither could a test,
          // which is how a real defect stayed hidden behind a 15-second
          // timeout.
          if (!address.includes('@')) {
            leaks = {
              kind: 'idle',
              needs:
                address.trim() === ''
                  ? t('leaksPromptAddress')
                  : t('leaksNotAnAddress'),
            }
            await paintCurrent()
            return
          }
          leaks = { kind: 'checking' }
          await paintCurrent()
          try {
            const result = await platform.runtime.send('leaks/check', { address })
            leaks = result
              ? {
                  kind: 'ready',
                  inventory: { ...result, leaks: result.leaks },
                  now: new Date().toISOString(),
                }
              : { kind: 'error', message: t('errCheckEmpty') }
          } catch (cause) {
            leaks = { kind: 'error', message: String(cause) }
          }
          await paintCurrent()
        })()
      },
      onChangePassword: (leak) => {
        // The address is composed by `changePasswordUrl` rather than here: it was
        // concatenated in two places, and a host is a string from somewhere — one
        // containing `@` puts the user on a different site than the one named.
        const url = leak.domain ? changePasswordUrl(leak.domain) : null
        if (url !== null) void platform.tabs.create(url)
      },
      // The key line's link: a source unchecked for want of a key points at the field.
      keyHref: optionsPageFor('data'),
      onResolve: (name) => {
        void (async () => {
          const db = await openDb()
          const now = new Date().toISOString()
          await db.put('journal', {
            id: `leak-resolved:${name}:${now}`,
            createdAt: now,
            kind: 'action',
            detail: { explain: t('leaksMarkedDealtWith', name), reason: 'user-allowed' },
          })
          await reload()
        })()
      },
    }),
  )
  return container
}

/**
 * The same queue the popup shows, in the place the first run sends people. One
 * implementation, because the promise is that whatever the user faces is at
 * most three things and always the same three.
 */
let queueExpanded = false

/** The last package the user asked about. Nothing is kept across a reload. */
let lastAnalysis: PackageReport | null = null

/**
 * Why the last package could not be read, when that is what happened.
 *
 * A file that would not open used to become a report with no findings and a note beside
 * it — and a panel showing "nothing of note" about a file nobody managed to read says
 * the opposite of what happened. The report stays absent; the reason takes the slot the
 * panel already had for it.
 */
let lastAnalysisFailure: string | null = null

/** The exception behind `lastAnalysisFailure`, drawn under it rather than inside it (B-117). */
let lastAnalysisDiagnostic: string | undefined

/**
 * A standing fact about an extension, before it is narrowed.
 *
 * Dropped rather than defaulted when the kind is unknown: a note whose sentence this page
 * cannot write would render as an empty line under an extension's name, which reads as
 * "something is wrong and we will not say what".
 */
function narrowStanding(finding: {
  kind: string
  id: string
  name: string
  severity: string
  installType?: string
  pair?: string[]
  everywhere?: boolean
}): StandingFinding | null {
  const severity = finding.severity === 'critical' ? 'critical' : 'major'
  const base = { id: finding.id, name: finding.name, severity } as const
  if (finding.kind === 'not-from-store') {
    return finding.installType === 'sideload' || finding.installType === 'development'
      ? { ...base, kind: 'not-from-store', installType: finding.installType }
      : null
  }
  if (finding.kind === 'reads-everything-and-more') {
    const [one, two] = finding.pair ?? []
    return one !== undefined && two !== undefined
      ? { ...base, kind: 'reads-everything-and-more', pair: [one, two], everywhere: finding.everywhere === true }
      : null
  }
  return null
}

/** What the worker sent about one changed extension, before it is narrowed. */
type WireChange = {
  kind: string
  id: string
  name: string
  severity: string
  publisher?: string | null
  previousPublisher?: string | null
  permissions?: string[]
  hosts?: string[]
}

/**
 * The wire shape is loose — strings, not unions — so a newer worker cannot break an
 * older page. This is the one place it is narrowed, and a row it cannot narrow is
 * dropped rather than forced.
 *
 * Dropped, not defaulted: a `permission-added` row that arrived without its permissions
 * would render as "now asks for" and then nothing, which reads as an extension asking
 * for something unnameable. A row missing is visible in the count; a sentence with a
 * hole in it is read as a fact.
 */
function narrowChange(change: WireChange): InventoryChange | null {
  const severity = change.severity
  const base = { id: change.id, name: change.name }
  const major = severity === 'critical' || severity === 'major' ? severity : null

  switch (change.kind) {
    case 'newly-installed':
      return { ...base, kind: 'newly-installed', severity: 'minor' }
    case 'removed':
      return { ...base, kind: 'removed', severity: 'minor' }
    case 'publisher-changed':
      return {
        ...base,
        kind: 'publisher-changed',
        severity: 'critical',
        publisher: change.publisher ?? null,
        previousPublisher: change.previousPublisher ?? null,
      }
    case 'permission-added':
      return change.permissions && change.permissions.length > 0 && major
        ? { ...base, kind: 'permission-added', severity: major, permissions: change.permissions }
        : null
    case 'host-access-widened':
      return change.hosts && change.hosts.length > 0 && major
        ? { ...base, kind: 'host-access-widened', severity: major, hosts: change.hosts }
        : null
    default:
      // A kind this page has never heard of. A newer worker is allowed to have one.
      return null
  }
}

async function queueSection(): Promise<HTMLElement> {
  const container = document.createElement('section')
  container.setAttribute('data-role', 'queue-section')

  const heading = document.createElement('h1')
  heading.textContent = t('optionsQueueHeading')
  container.append(heading)

  try {
    const db = await openDb()
    const items = toQueueItems(await db.getAll('findings'))
    container.append(
      renderQueue(document, buildQueue(items, queueExpanded ? Math.max(items.length, 3) : 3), {
        onAct: (id) => {
          void (async () => {
            const finding = await (await openDb()).get('findings', id)
            const url = finding?.verdict?.subject.ref
            if (url) await platform.tabs.create(url)
          })()
        },
        onShowAll: () => {
          queueExpanded = true
          void reload()
        },
        onResolve: (id: string) => {
          void act(async () => {
            await platform.runtime.send('finding/resolve', { id })
          })
        },
        onDefer: (id: string) => {
          void act(async () => {
            const until = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
            await platform.runtime.send('finding/defer', { id, until })
          })
        },
      }),
    )
  } catch (cause) {
    // Never an empty queue in place of a failure: "nothing needs you" is the
    // most damaging sentence in this product to say wrongly.
    const failed = document.createElement('p')
    failed.setAttribute('data-role', 'queue-error')
    container.append(withDiagnostic(failed, t('optionsQueueUnread'), cause))
  }

  return container
}

/**
 * SCR-09. The review runs when the screen opens: this is the moment the user
 * wants the current answer, not the one from last night's alarm.
 */
async function extensionsSection(): Promise<HTMLElement> {
  let state: ExtensionsState
  try {
    const result = await platform.runtime.send('extensions/state', {})
    if (!result) {
      state = { kind: 'error', message: t('errNoAnswer') }
    } else if (!result.supported) {
      state = {
        kind: 'unsupported',
        why: t('extensionsNotVisible'),
      }
    } else {
      state = {
        kind: 'ready',
        // The wire shape is deliberately loose (strings, not unions) so a newer
        // background cannot break an older page; it is narrowed here, once.
        changes: result.changes.flatMap((change) => narrowChange(change) ?? []),
        // Narrowed here, once, like `changes` above: the wire is loose so a newer worker
        // cannot break an older page, and a standing finding whose kind this page does not
        // know is dropped rather than rendered as an unlabelled note.
        installed: result.installed.map((entry) => ({
          id: entry.id,
          name: entry.name,
          version: entry.version,
          permissions: entry.permissions,
          enabled: entry.enabled,
          standing: (entry.standing ?? []).flatMap((finding) => narrowStanding(finding) ?? []),
        })),
        analysis: lastAnalysis,
        analysisNote: lastAnalysisFailure ?? t('extensionsInspectNote'),
        ...(lastAnalysisDiagnostic === undefined ? {} : { analysisDiagnostic: lastAnalysisDiagnostic }),
      }
    }
  } catch (cause) {
    state = { kind: 'error', message: String(cause) }
  }

  return renderExtensions(document, state, {
      onDisable: (id: string) => {
        void (async () => {
          const result = await platform.runtime.send('extensions/disable', { id })
          // On the page, not in a browser dialog: `failure.ts` says why, and every other
          // failure in this product is a slot on the screen.
          failure = result && !result.ok ? t('extensionsDisableFailed', result.why ?? t('extensionsUnknownReason')) : null
          await reload()
        })()
      },
      onTrust: (id: string) => {
        void act(async () => {
          await platform.runtime.send('extensions/trust', { id })
        })
      },
      onInspect: (file: File) => {
        void (async () => {
          try {
            // Read here, in the page, and analysed here. The file never reaches
            // the background, let alone the network.
            lastAnalysis = analysePackage(await file.text(), file.name)
            lastAnalysisFailure = null
            lastAnalysisDiagnostic = undefined
          } catch (cause) {
            // No report at all, rather than an empty one: see `lastAnalysisFailure`.
            lastAnalysis = null
            lastAnalysisFailure = t('extensionsFileUnread')
            lastAnalysisDiagnostic = String(cause)
          }
          await reload()
        })()
      },
  })
}

/**
 * SCR-12's trusted list. Trust is granted from a page in one click; this is the
 * only place it can be taken back, and the comparison view promises in those
 * words that it can be.
 */
async function trustedSection(): Promise<HTMLElement> {
  let entries: TrustedDomain[] = []
  try {
    // Not `?? []`: silence is not an empty list, and the comment three lines
    // below has always said so.
    const result = answered(await platform.runtime.send('trust/list', {}), t('errTrustedList'))
    entries = result.entries.map((entry) => ({
      domain: entry.domain,
      grantedAt: entry.grantedAt,
      ...(entry.reason ? { reason: entry.reason } : {}),
    }))
  } catch (cause) {
    // Through the renderer, not beside it: the sentence is the same one, and now it is
    // reachable by a test of `renderTrusted` and by the axe sweep that walks its markup
    // (B-59). It used to be built here, so SCR-16's record named a file its error state
    // did not live in.
    return renderTrusted(
      document,
      { kind: 'error', message: t('optionsTrustedUnread'), diagnostic: String(cause) },
      // Nothing to revoke on a screen that could not read the list.
      { onRevoke: () => undefined },
    )
  }

  return renderTrusted(document, { kind: 'ready', domains: entries }, {
    onRevoke: (domain: string) => {
      void act(async () => {
        await platform.runtime.send('trust/revoke', { domain })
      })
    },
  })
}

/**
 * Repaint whatever area is open, without changing which one it is.
 *
 * The leak check drives this: it moves through idle → checking → ready inside
 * one area, and each step has to reach the screen.
 */
async function paintCurrent(): Promise<void> {
  await reload()
}

/**
 * The window the panel's own sentence names.
 *
 * Retention is ninety days, and the panel used to be handed all of it under the words "the
 * last seven". The clock lives here — the renderer takes the boundary as an instant, so its
 * filter stays deterministic and its test needs no fake timer.
 */
const AUDIT_WINDOW_DAYS = 7

/**
 * Which period the audit panel is showing. A page-lifetime choice, like `fullHistory`
 * below: it is a question about the current reading, not a setting worth storing.
 */
let auditWindow: AuditWindow = 'week'

/**
 * The words for each period. A table, not a ternary inside `t(…)`: the locale gate reads
 * keys out of a call with a literal argument and out of tables named `*_KEY`, and a key hiding in a
 * conditional reads as translated-and-never-shown. This project has been caught by that
 * exact shape before.
 */
const AUDIT_SINCE_KEY: Record<AuditWindow, string> = {
  week: 'auditSinceSevenDays',
  all: 'auditWindowAll',
}

async function load(): Promise<PanelState> {
  try {
    const db = await openDb()
    const entries = await db.getAll('outbound_log')
    if (entries.length === 0) return { kind: 'empty' }
    /**
     * The epoch for "everything kept", not a ninety-day subtraction.
     *
     * Retention already guarantees nothing older than ninety days exists, so the widest
     * honest boundary is "no boundary" — and computing 90 days here would invent a second
     * place where the retention number lives.
     */
    const windowStartIso =
      auditWindow === 'all'
        ? new Date(0).toISOString()
        : new Date(Date.now() - AUDIT_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString()
    return {
      kind: 'ready',
      entries,
      since: t(AUDIT_SINCE_KEY[auditWindow]),
      windowStartIso,
      window: auditWindow,
    }
  } catch (cause) {
    return { kind: 'error', message: String(cause) }
  }
}

/**
 * The answer to the last action that failed, or `null`.
 *
 * Page-lifetime, like `fullHistory` below: a failure is news about what just happened, not
 * a setting. Drawn by the repaint — see `failure.ts` for why it is a slot on the screen
 * rather than a browser dialog.
 */
let failure: string | null = null

/** The exception behind `failure`, shown under it rather than inside it (B-117). */
let failureDiagnostic: string | undefined

/**
 * A failure sentence with the exception's own words under it.
 *
 * Two inline error elements on this page interpolated `String(cause)` into a catalogue
 * sentence, which is how a reader got a Russian line with an English middle (B-117). Written
 * once here because both do the same thing, and because a third will want it.
 */
function withDiagnostic(el: HTMLElement, sentence: string, cause: unknown): HTMLElement {
  el.textContent = sentence
  const detail = document.createElement('span')
  detail.setAttribute('data-role', 'read-diagnostic')
  detail.textContent = String(cause)
  el.append(detail)
  return el
}

/** Full history is a request, not the default view. */
let fullHistory = false

async function journalSection(): Promise<HTMLElement> {
  let records: { entries: JournalRecord[]; lastCheck: string | null }
  try {
    records = await readJournal()
  } catch (cause) {
    const failed = document.createElement('section')
    failed.setAttribute('data-role', 'journal-error')
    return withDiagnostic(failed, t('optionsJournalUnread'), cause)
  }

  const { entries, unreadable } = mapJournal(records.entries)
  const since = fullHistory ? null : records.lastCheck
  return renderJournal(
    document,
    diffSince(entries, since, { unreadable }),
    { retentionDays: RETENTION_DAYS.journal },
    {
      onToggleHistory: () => {
        fullHistory = !fullHistory
        void reload()
      },
      onOpenEntry: () => {
        // Each entry already carries its sentence; there is no second screen to
        // open yet, and a dead control would be worse than none.
      },
    },
  )
}

async function readJournal(): Promise<{
  entries: JournalRecord[]
  lastCheck: string | null
}> {
  const db = await openDb()
  const entries = await db.getAll('journal')
  const setting = await db.get('settings', 'popup:lastCheck')
  return { entries, lastCheck: typeof setting?.value === 'string' ? setting.value : null }
}

/**
 * The recovery checklist appears when something sent the user here — the hash
 * carries which incident. Progress is kept in storage so closing the tab in the
 * middle of a bad afternoon does not lose it.
 */
async function recoverySection(kind: string): Promise<HTMLElement> {
  /**
   * No incident named: the picker, which is what SCR-13's `empty` state has always said.
   *
   * This used to return an empty `div` and `routeFor` used to make sure nothing reached
   * it — a defensible pair while there was nothing to show, and a dead end for anyone who
   * realised after the fact that they had run the pasted command (B-59).
   */
  if (!kind) {
    return renderIncidentPicker(document, {
      onPick: (picked) => {
        // A navigation, so back works and the address names the incident — the same
        // address the ClickFix warning produces.
        location.hash = hashFor('recovery', picked)
      },
    })
  }

  let progress: StepProgress[] = []
  try {
    const db = await openDb()
    const stored = await db.get('settings', `recovery:${kind}`)
    progress = typeof stored?.value === 'string' ? (JSON.parse(stored.value) as StepProgress[]) : []
  } catch {
    // Progress is a convenience; the checklist itself is the point.
  }

  return (
    /**
     * `kind` arrives decoded. Decoding it again was two defects in one call.
     *
     * `routeFor` decodes once and **deliberately keeps a broken escape raw** — there
     * is a test for that — so a second `decodeURIComponent` on the raw value threw a
     * `URIError` out of here, `root.replaceChildren` was never reached, and
     * `options.html#recovery=%E0%A4%A` was a completely blank page with an unhandled
     * rejection in the console. Measured 2026-08-20.
     *
     * The quiet half: on a value that decodes cleanly, decoding twice answers about a
     * string the address never named — `%2520` becomes `%20` and then a space.
     */
    renderRecovery(document, buildChecklist(kind, progress), {
      onToggle: (stepId, done) => {
        void (async () => {
          const next = done
            ? [...progress.filter((entry) => entry.stepId !== stepId), { stepId, doneAt: new Date().toISOString() }]
            : progress.filter((entry) => entry.stepId !== stepId)
          try {
            const db = await openDb()
            await db.put('settings', { key: `recovery:${kind}`, value: JSON.stringify(next) })
          } catch {
            // Losing a tick is survivable; losing the checklist is not.
          }
          await reload()
        })()
      },
      onCopy: (portableText: string) => {
        // A real click, and the page shows exactly what went to the clipboard.
        // The write can be refused; the text stays on screen either way.
        void navigator.clipboard?.writeText(portableText).catch(() => undefined)
      },
      onArchive: () => {
        void (async () => {
          const db = await openDb()
          await db.delete('settings', `recovery:${kind}`)
          // The incident is gone, so its address no longer names anything.
          // Sending the page home is a navigation, and the hashchange listener
          // repaints on the way.
          location.hash = ''
        })()
      },
    })
  )
}

/**
 * The eight rows of the overview, each with a state it can answer cheaply.
 *
 * Cheap is the whole design: a count, not a section's data. Every one of them
 * is allowed to fail on its own and a failed one becomes `null` — which the
 * renderer draws as "состояние не прочиталось" and never as "пусто". Eight
 * reads that can each fail, all rendering into one reassuring word, is the
 * oldest failure in this codebase with eight new chances to happen.
 */
async function areaRows(): Promise<AreaRow[]> {
  const row = (id: AreaId, label: string, state: string | null, href?: string): AreaRow => ({
    id,
    label,
    href: href ?? optionsPageFor(id),
    state,
  })

  /**
   * The rule is `recoveryHref`'s; what is here is the read it needs.
   *
   * A failed read gives it an empty list, which lands on the overview — the same place a
   * row with nothing open goes, and the honest one when we cannot tell.
   */
  const openNow = await openIncidents().catch(() => ({ incidents: [], unreadable: 1 }))
  const recoveryLink = recoveryHref(openNow.incidents)

  const [findings, journal, extensions, trusted, recovery, audit] = await Promise.all([
    count(async () => {
      const items = toQueueItems(await (await openDb()).getAll('findings'))
      return items.length === 0 ? t('areaStateNothing') : t('areaStateWaiting', String(items.length))
    }),
    count(async () => {
      const { lastCheck } = await readJournal()
      // `shortTime`, not the stored value: this row said "Что изменилось с
      // 2026-08-20T23:23:22.936Z" until 2026-08-21. It is the same fact the popup shows
      // with the same rendering — a diff's baseline is a moment, not a day.
      return lastCheck === null
        ? t('areaStateJournalNever')
        : t('areaStateJournalSince', shortTime(lastCheck))
    }),
    count(async () => {
      const result = await platform.runtime.send('extensions/state', {})
      if (!result) throw new Error(t('errNoAnswer'))
      if (!result.supported) return t('extensionsNotVisible')
      return t('areaStateChanges', String(result.changes.length))
    }),
    count(async () => {
      const result = answered(await platform.runtime.send('trust/list', {}), t('errTrustedList'))
      return t('areaStateTrusted', String(result.entries.length))
    }),
    count(async () => {
      const { incidents, unreadable } = await openIncidents()
      // A row that cannot see every incident says so rather than naming a
      // number that is missing some of them.
      // i18n-exempt: a control-flow signal, not copy — `count()` catches this and
      // renders nothing, so no eye ever sees the string.
      if (unreadable > 0) throw new Error('recovery progress unreadable')
      return incidents.length === 0
        ? t('areaStateNoIncidents')
        : t('areaStateSteps', String(incidents.reduce((n, i) => n + i.open, 0)))
    }),
    count(async () => {
      const entries = await (await openDb()).getAll('outbound_log')
      return t('areaStateSent', String(entries.length))
    }),
  ])

  return [
    row('queue', t('optionsQueueHeading'), findings),
    row('journal', t('areaJournal'), journal),
    row('leaks', t('areaLeaks'), t('areaStateOnDemand')),
    row('extensions', t('areaExtensions'), extensions),
    row('trusted', t('areaTrusted'), trusted),
    row('recovery', t('areaRecovery'), recovery, recoveryLink),
    row('audit', t('areaAudit'), audit),
    row('data', t('dataHeading'), t('areaStateRetention', String(RETENTION_DAYS.journal))),
  ]
}

/**
 * A count that is allowed to fail without taking the page with it.
 *
 * `null` means "not read". It is deliberately not the empty string and not a
 * zero: both of those are answers, and this is the absence of one.
 */
async function count(read: () => Promise<string>): Promise<string | null> {
  try {
    return await read()
  } catch {
    return null
  }
}

/**
 * Recovery checklists with steps still unticked, and how many could not be read.
 *
 * A single unparseable entry used to throw out of here and — because this is
 * called from inside the attention band's own try — blank the **whole** band:
 * eight areas reported unreadable because one settings row was corrupt.
 */
async function openIncidents(): Promise<{
  incidents: Array<{ kind: string; open: number }>
  unreadable: number
}> {
  const db = await openDb()
  const settings = await db.getAll('settings')
  const incidents: Array<{ kind: string; open: number }> = []
  let unreadable = 0
  for (const entry of settings) {
    if (!entry.key.startsWith('recovery:')) continue
    const kind = entry.key.slice('recovery:'.length)
    let done: StepProgress[] = []
    try {
      done = typeof entry.value === 'string' ? (JSON.parse(entry.value) as StepProgress[]) : []
    } catch {
      // Skipped and counted. Skipping quietly would undercount the open steps,
      // and an undercount on this surface reads as calm.
      unreadable += 1
      continue
    }
    const open = buildChecklist(kind, done).remaining
    if (open > 0) incidents.push({ kind, open })
  }
  return { incidents, unreadable }
}

/**
 * What needs the user, ranked across areas — by the ranker the queue already
 * uses, not by a second one written here.
 *
 * Three areas can hold something outstanding: findings, extension changes, and
 * an unfinished recovery checklist. The rest cannot. Leaks are checked on
 * request and hold nothing between checks; the journal, the trusted list, the
 * outbound log and the data controls are records rather than work.
 *
 * Returns `null` when the whole read failed — which the overview shows as its
 * error state. An empty array means the product looked and found nothing, and
 * those two must never render the same way.
 */
async function attentionItems(): Promise<AttentionItem[] | null> {
  try {
    const items = toQueueItems(await (await openDb()).getAll('findings'))
    const ranked = buildQueue(items, Math.max(items.length, 1))
    // `summary` is the sentence the queue already shows; `where` is not on a
    // queue item and is not invented here — a made-up origin is worse than an
    // absent one, and the renderer draws the time alone when there is no place.
    const attention: AttentionItem[] = ranked.shown.map((item) => ({
      severity: item.severity,
      what: item.summary,
      where: null,
      // `shortDate`, not a slice: the same two lines open-coded for the eighth time, in
      // the file whose journal row was converted an hour earlier.
      when: shortDate(item.createdAt),
      area: 'queue' as AreaId,
      href: optionsPageFor('queue'),
    }))

    for (const incident of (await openIncidents()).incidents) {
      attention.push({
        severity: 'major',
        what: t('areaRecoveryOpen', String(incident.open)),
        where: null,
        when: t('areaStateOnDemand'),
        area: 'recovery',
        href: optionsPageFor('recovery', incident.kind),
      })
    }

    overviewFailure = null
    return attention
  } catch (cause) {
    overviewFailure = String(cause)
    return null
  }
}

/** When the product last looked, for the sentence beside an empty band. */
/** The stored instant as a person reads it, or null for "never". */
function worded(iso: string | null): string | null {
  return iso === null ? null : shortTime(iso)
}

async function lastCheckedAt(): Promise<string | null> {
  try {
    return (await readJournal()).lastCheck
  } catch {
    return null
  }
}

/**
 * Repaints run one at a time, and a burst collapses to the last state.
 *
 * Two started close together interleave: both build their tree, and whichever
 * finishes second wins the DOM, losing whatever the first was about to show.
 * With the live address field it was worse — appending it to the second
 * builder's container moves it out of the first's, and if the first is the one
 * that reaches `replaceChildren`, the field is swapped in inside a container
 * that no longer holds it and vanishes from the page.
 *
 * Serialising is the fix rather than a lock on the field, because the same
 * interleaving loses queue rows, journal entries and every other section for
 * the same reason; the field is only where it was noticed.
 */
let painting: Promise<void> = Promise.resolve()
let pendingRoute: Route | null = null

function paint(route: Route): Promise<void> {
  pendingRoute = route
  const run = async (): Promise<void> => {
    const next = pendingRoute
    pendingRoute = null
    // Superseded while queued: a later call carries the newer route, and
    // painting an older one on the way past is a visible flicker backwards.
    if (next !== null) await renderRoute(next)
  }
  // Both arms, not `.then(run)`. A chain built on the fulfilled arm alone stops
  // the moment one paint rejects — a single failed read would freeze the page
  // on whatever it last drew, for the rest of the session, with no error.
  painting = painting.then(run, run)
  return painting
}

/**
 * One area at a time.
 *
 * The page used to build all eight sections on every repaint — five of them
 * awaiting their own database read — and swap the lot in at the end. Ticking
 * one recovery step re-read the journal, the queue, the extension inventory and
 * the trusted list, twice, because `reload()` painted a loading state first.
 *
 * Now the address decides what is built, and nothing else is read.
 */
async function renderRoute(route: Route): Promise<void> {
  if (!root) return

  /**
   * Before any area: can the local store be opened at all.
   *
   * Every section below reads it and each catches its own failure, so a profile
   * written by a newer build used to render the browser's sentence about
   * requested and existing versions six times over, in a page that was otherwise
   * empty — and nothing said which of two different things had happened, or what
   * to do about either. One panel, and the two things a person can actually do.
   */
  /**
   * The shell first, synchronously, and only when arriving.
   *
   * Everything below is a read, and the page used to wait for all of them before painting
   * anything. On a repaint — after resolving a finding, after a hashchange back to the
   * overview — the shell is *not* repainted: flashing «Считаем…» over a page the user is
   * looking at trades a blank first paint for a flicker on every action.
   */
  if (route.view === 'overview' && (root.childElementCount === 0 || lastView !== 'overview')) {
    root.replaceChildren(
      renderOverview(document, { kind: 'loading', areas: loadingRows() }, overviewHandlers()),
    )
  }

  const problem = await storageProblem()
  if (problem) {
    keepingFocus(root, document, () => {
      root.replaceChildren(problem)
      showFailure(document, root, failure, failureDiagnostic)
    })
    return
  }

  const body =
    route.view === 'overview' ? await overviewSection(route) : await areaSection(route)

  const arriving = route.view !== 'overview' && route.view !== lastView
  lastView = route.view

  keepingFocus(root, document, () => {
    root.replaceChildren(...(route.view === 'overview' ? [] : [backLink()]), body)
    // Above the panel, after the children are in place: the slot is prepended, so it leads
    // the page whatever the area draws.
    showFailure(document, root, failure, failureDiagnostic)

    // Synchronously, with no await between: the field is out of the document
    // for one statement rather than for the length of a database read.
    root.querySelector('[data-role=address-slot]')?.replaceWith(addressField)
  })

  // Arriving at an area puts focus on it, not on the back link above it.
  //
  // The stacked page did this by scrolling `#queue` into view, and SCN-002
  // asserts it: the first run's primary action is "see what to do first", and
  // someone arriving by keyboard otherwise starts on the way back out. Only on
  // arrival — repainting after an action must leave focus where the user left
  // it, which is what `keepingFocus` above is for.
  if (arriving && markFocus(root, document) === null) {
    const area = root.lastElementChild
    if (area instanceof HTMLElement) {
      area.setAttribute('tabindex', '-1')
      area.focus({ preventScroll: true })
    }
  }
}

/** Which area was last painted, so arrival can be told from a repaint. */
let lastView: Route['view'] | null = null

async function areaSection(route: Route): Promise<HTMLElement> {
  switch (route.view) {
    case 'queue':
      return queueSection()
    case 'journal':
      return journalSection()
    case 'leaks':
      return leaksSection()
    case 'extensions':
      return extensionsSection()
    case 'trusted':
      return trustedSection()
    case 'recovery':
      return recoverySection(route.kind ?? '')
    case 'audit':
      return selfAuditSection()
    case 'data':
      return dataSection()
    default:
      return overviewSection(route)
  }
}

/**
 * Back to the overview, carrying how much is still waiting.
 *
 * The count is the whole reason this is not a bare arrow. The shape chosen for
 * this page shows the overview only when you are on it, so without the number
 * here a person acting inside one area has no idea whether anything else is
 * outstanding until they go and look.
 */
function backLink(): HTMLElement {
  const link = document.createElement('a')
  link.setAttribute('data-role', 'back')
  link.href = optionsPageFor('overview')
  link.textContent =
    outstanding === null || outstanding === 0
      ? t('dashboardBack')
      : t('dashboardBackWaiting', String(outstanding))
  return link
}

/** What the last overview count said. `null` until one has been taken. */
let outstanding: number | null = null

async function selfAuditSection(): Promise<HTMLElement> {
  // The panel itself, with no wrapper around it. Five of these areas returned a role-less
  // `div` holding exactly one child; the router focuses whatever it mounts, so the focus
  // ring was drawn around the wrapper and read on screen as a second card offset from the
  // first. Measured 2026-08-21 on five areas at once.
  return renderSelfAudit(document, await load(), {
    onExport: () => void download(),
    onRepair: () => void reload(),
    onWindow: (next) => {
      auditWindow = next
      void reload()
    },
  })
}

async function dataSection(): Promise<HTMLElement> {
  return renderDataControls(
    document,
    {
      onExport: download,
      onWipe: async () => {
        const db = await openDb()
        return wipeAll(db)
      },
      onWiped: () => void reload(),
    },
    // Every store, from the schema that owns the list — not a subset written here.
    // `DATA_KIND_KEY` is `Record<StoreName, string>`, so a store added later fails
    // the build until the confirmation has words for it.
    Object.values(DATA_KIND_KEY),
    await leakKeyPanel(),
  )
}

/**
 * The Have I Been Pwned key block (B-125), or none when whether a key is saved cannot be
 * read: a block saying "no key" over a key that is there would invite pasting a second
 * one, and the storage problem itself is SCR-20's to explain.
 *
 * Saving and removing go through `act`, so a failed write says so in the page's failure
 * slot and the repaint shows what is actually stored. The key goes from the field to the
 * store and nowhere else: not into this page's state, not into a message, not into a log.
 */
async function leakKeyPanel(): Promise<LeakKeyPanel | undefined> {
  let saved: boolean
  try {
    saved = await hasLeakKey(await openDb())
  } catch {
    return undefined
  }
  return {
    saved,
    onSave: (key) => void act(async () => saveLeakKey(await openDb(), key)),
    onRemove: () => void act(async () => removeLeakKey(await openDb())),
  }
}

/**
 * The overview: what needs you, and where each area stands.
 *
 * Every read here is a **count**, not a section's data. That is the difference
 * between a page that opens and a page that assembles eight panels before it
 * shows anything — and each count is allowed to fail on its own, because the
 * alternative is one failure blanking the lot.
 */
async function overviewSection(route: Route): Promise<HTMLElement> {
  const rows = await areaRows()
  const attention = await attentionItems()

  outstanding = attention === null ? null : attention.length

  if (attention === null) {
    return renderOverview(
      document,
      { kind: 'error', message: overviewFailure ?? t('errNoAnswer'), areas: rows },
      overviewHandlers(),
    )
  }

  return renderOverview(
    document,
    {
      kind: 'ready',
      attention,
      areas: rows,
      // Worded here, because that is what the field means (see `OverviewState`). It
      // used to pass the journal's stored instant and the screen showed it.
      lastChecked: worded(await lastCheckedAt()),
      ...(route.unrecognised === undefined ? {} : { unrecognised: route.unrecognised }),
    },
    overviewHandlers(),
  )
}

function overviewHandlers(): OverviewHandlers {
  return {
    onOpen: () => {
      // The row is a real link and the browser follows it; `hashchange` then
      // paints the area. Nothing to do here, and nothing to preventDefault:
      // taking the navigation away from the browser would take back and
      // forward with it.
    },
    onRepair: () => void reload(),
  }
}

/** Why the overview could not be built, when it could not. */
let overviewFailure: string | null = null

async function download(): Promise<void> {
  const db = await openDb()
  const json = await exportAll(db, EXPORT_WORDS)
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = url
  link.download = 'okolos-export.json'
  link.click()
  URL.revokeObjectURL(url)
}

/**
 * The storage panel, or `null` when there is nothing wrong.
 *
 * Only `StorageUnavailable` lands here. An ordinary read failure inside one
 * section stays that section's problem: replacing the whole page because the
 * journal could not be listed would hide seven working areas behind one.
 */
/** The browser's own message, when there is one. An absent key, not an empty string. */
function detailOf(cause: unknown): { detail?: string } {
  const message = cause instanceof Error ? cause.message : undefined
  return message === undefined || message === '' ? {} : { detail: message }
}

async function storageProblem(): Promise<HTMLElement | null> {
  try {
    await openDb()
    return null
  } catch (cause) {
    if (!(cause instanceof StorageUnavailable)) return null
    return renderStorageProblem(
      document,
      {
        kind: cause.problem,
        found: cause.found,
        expected: DB_VERSION,
        // The browser's words or nothing. `cause.message` is ours — see the field's note.
        // Spread rather than `detail: undefined`, which `exactOptionalPropertyTypes`
        // refuses and which would mean "present, and empty" rather than "absent".
        ...detailOf(cause.cause),
      },
      {
        onRetry: () => void reload(),
        onReset: () => {
          void (async () => {
            await resetStorage()
            await reload()
          })()
        },
      },
    )
  }
}

async function reload(): Promise<void> {
  await paint(routeFor(location.hash))
}

/**
 * An action, with the pressed control marked until its result lands.
 *
 * The repaint is here rather than in each handler so no action can forget it,
 * and the failure branch is here for the same reason: a write that fails must
 * give the control back and say what happened, not leave a dead button.
 */
async function act(work: () => Promise<void>): Promise<void> {
  if (!root) return
  try {
    await whilePending(document, root, work)
  } catch (cause) {
    // Reload anyway: the store may have changed before the failure, and a
    // screen showing pre-failure state is its own wrong answer. The message is
    // set *before* the repaint, because the repaint is what draws it.
    failure = t('actionFailed')
    failureDiagnostic = String(cause)
    await reload()
    return
  }
  // A write that worked clears the last failure: an answer to an action nobody
  // is waiting for any more is stale news at the top of the screen.
  failure = null
  failureDiagnostic = undefined
  await reload()
}

// Real links move the page; this is what turns that into a repaint. Back and
// forward come free with it, which a router would have had to reimplement.
window.addEventListener('hashchange', () => void reload())

void reload()
