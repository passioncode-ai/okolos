import { renderFirstRun, type CheckRow } from '@okolos/ui'
import { t, useResolver } from '@okolos/i18n'
import { detectPlatform } from '@okolos/platform'
import { openDb } from '@okolos/storage'
import '../pages.css'
import { optionsPageFor } from '../options/views.js'
import { firstRunResult } from './result.js'
import { repaintOnReturn } from './return.js'
import { countUncaughtErrors } from '../ui-errors.js'

/**
 * What the first run can honestly check.
 *
 * Every row reports the state of a real capability on this device: a check that
 * cannot run says so and why, rather than being omitted. A first impression
 * built on an overstatement is the failure mode this product exists against, and
 * the row that says "not on this browser" is worth more than the one that
 * quietly disappears.
 */

const platform = detectPlatform()
countUncaughtErrors(window, () => platform.runtime.send('usage/uiError', {}))

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

async function checks(): Promise<{ rows: CheckRow[]; findings: number }> {
  const rows: CheckRow[] = [
    {
      id: 'detector',
      label: t('firstRunCheckInjection'),
      state: 'ok',
      note: t('firstRunCheckInjectionNote'),
    },
  ]

  let findings = 0
  try {
    const db = await openDb()
    const open = (await db.getAll('findings')).filter((f) => f.resolvedAt === null)
    findings = open.length
    rows.push({ id: 'storage', label: t('firstRunCheckStorage'), state: 'ok', note: t('firstRunCheckStorageNote') })
  } catch (cause) {
    rows.push({ id: 'storage', label: t('firstRunCheckStorage'), state: 'failed', note: String(cause) })
  }

  rows.push(
    platform.extensions.available()
      ? {
          id: 'extensions',
          label: t('firstRunCheckExtensions'),
          state: 'ok',
          note: t('firstRunCheckExtensionsNote'),
        }
      : {
          id: 'extensions',
          label: t('firstRunCheckExtensions'),
          state: 'unavailable',
          note: t('firstRunCheckExtensionsNone'),
        },
    {
      id: 'passwords',
      label: t('firstRunCheckPassword'),
      state: 'ok',
      note: t('firstRunCheckPasswordNote'),
    },
    platform.downloads.available()
      ? { id: 'downloads', label: t('firstRunCheckDownloads'), state: 'ok', note: t('firstRunCheckDownloadsNote') }
      : {
          id: 'downloads',
          label: t('firstRunCheckDownloads'),
          state: 'unavailable',
          note: t('firstRunCheckDownloadsNone'),
        },
  )

  return { rows, findings }
}

/**
 * What the worker says about usage and error data.
 *
 * Asked again rather than read as off (B-209): a worker that did not answer the first time hid
 * the notice in a build where collection was on, and the first run is the one moment the notice
 * is owed. Three tries a second apart; after them the notice is shown, because saying too much
 * about sending is the side a first run can afford, and a build that sends nothing answers at
 * once with `not-sent`.
 */
async function usageState(): Promise<'on' | 'off' | 'unsupported' | 'not-sent'> {
  for (let attempt = 0; attempt < USAGE_STATE_TRIES; attempt += 1) {
    try {
      return (await platform.runtime.send('usage/state', {})).state
    } catch {
      if (attempt < USAGE_STATE_TRIES - 1) await new Promise((resolve) => setTimeout(resolve, USAGE_STATE_RETRY_MS))
    }
  }
  return 'on'
}

const USAGE_STATE_TRIES = 3
const USAGE_STATE_RETRY_MS = 1_000

let counted = false

async function paint(): Promise<void> {
  if (!root) return
  const [{ rows, findings }, usage] = await Promise.all([checks(), usageState()])
  if (!counted) {
    counted = true
    // The worker counts it once per install; a page cannot send events itself (ADR-0021).
    void platform.runtime.send('usage/firstRun', { result: firstRunResult(rows, findings) }).catch(() => {})
  }
  root.replaceChildren(
    renderFirstRun(document, { checks: rows, findings, usage }, {
      onUsageSettings: () => void platform.tabs.create(platform.runtime.getUrl(optionsPageFor('data'))),
      // Straight to the queue: the first interaction should end with something
      // to do, not a page to read.
      onContinue: () => void platform.tabs.create(platform.runtime.getUrl(optionsPageFor('queue'))),
      onSkip: () => window.close(),
      // `openOptionsPage()` carries no address, so it lands wherever the page
      // opens by default — which used to be the self-audit panel by accident of
      // ordering, and is now the overview. This link names the audit, so it
      // must ask for the audit.
      onOpenAudit: () => void platform.tabs.create(platform.runtime.getUrl(optionsPageFor('audit'))),
    }),
  )
}

void paint()
repaintOnReturn(document, () => void paint())
