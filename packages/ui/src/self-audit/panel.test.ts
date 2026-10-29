/** @vitest-environment happy-dom */
import { describe, expect, it, vi } from 'vitest'
import { HIBP_KEY_HEADER_SHAPE } from '@okolos/core-leaks'
import type { AuditEntry } from '@okolos/contracts'

import { renderSelfAudit } from './panel.js'

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fromCatalogue, useResolver, type Catalogue } from '@okolos/i18n'

/** The shipped Russian catalogue: `default_locale` is `ru`, and a fake would let a missing key pass. */
const CATALOGUE = JSON.parse(
  readFileSync(
    path.resolve(import.meta.dirname, '../../../../apps/extension/_locales/ru/messages.json'),
    'utf8',
  ),
) as Catalogue

useResolver(fromCatalogue(CATALOGUE))

/** The entry, or a failure that names the key rather than comparing to undefined. */
function message(key: string): string {
  const entry = CATALOGUE[key]
  if (!entry) throw new Error(`the shipped catalogue has no key "${key}"`)
  return entry.message
}

const handlers = { onExport: vi.fn(), onRepair: vi.fn(), onWindow: vi.fn() }

function entry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    id: 'a1',
    createdAt: '2026-08-04T09:00:00.000Z',
    destination: 'api.pwnedpasswords.com',
    purpose: 'password-range',
    payloadShape: 'hash-prefix:5BAA6',
    triggeredBy: 'user:password-check',
    outcome: 'sent',
    ...overrides,
  }
}

describe('an empty log is a sentence, not an empty table', () => {
  it('says plainly that nothing was sent', () => {
    const el = renderSelfAudit(document, { kind: 'empty' }, handlers)
    expect(el.querySelector('[data-role=empty]')?.textContent).toBe(message('auditEmpty'))
    expect(el.querySelector('[data-role=entries]')).toBeNull()
  })
})

describe('a failure never looks like silence', () => {
  const el = renderSelfAudit(document, { kind: 'error', message: 'database locked' }, handlers)

  it('names the failure', () => {
    expect(el.querySelector('[data-role=error]')?.textContent).toContain('database locked')
  })

  it('says explicitly that this is not a claim that nothing was sent', () => {
    // Showing an empty list on a read error would be the one lie this panel
    // cannot afford: the reader would conclude the product sent nothing.
    expect(el.querySelector('[data-role=error-note]')?.textContent).toBe(
      message('auditUnreadNote'),
    )
    expect(el.querySelector('[data-role=entries]')).toBeNull()
  })

  it('offers a way out rather than a dead end', () => {
    expect(el.querySelector('[data-role=repair]')).not.toBeNull()
  })
})

describe('the log itself', () => {
  const entries = [
    entry(),
    entry({ id: 'a2', purpose: 'feed-update', payloadShape: 'chunk-ids:17,18', outcome: 'failed' }),
    entry({ id: 'a3', outcome: 'blocked-by-redactor', payloadShape: 'refused: email in url' }),
  ]
  const el = renderSelfAudit(
    document,
    { kind: 'ready', window: 'week' as const, entries, since: 'Monday', windowStartIso: '2026-08-01T00:00:00.000Z' },
    handlers,
  )

  it('summarises what was sent, what failed and what was refused', () => {
    const summary = el.querySelector('[data-role=summary]')?.textContent ?? ''
    expect(summary).toContain(message('auditSummarySent').split('$')[0]?.trim())
    // The counts, and that each category is named at all. The wording of the
    // three phrases is the catalogue's business; that none of them is silently
    // dropped is this test's.
    expect(summary).toContain(message('auditSummaryFailed').split('$')[0]?.trim())
    expect(summary).toContain(message('auditSummaryBlocked').split('$')[0]?.trim())
    expect(summary).toMatch(/1[^\d]*1[^\d]*1/)
  })

  it('states the absence as well as the presence', () => {
    expect(el.querySelector('[data-role=summary]')?.textContent).toContain(
      message('auditSummaryNoContent'),
    )
  })

  it('lists every entry with its destination, purpose and payload shape', () => {
    const rows = el.querySelectorAll('[data-role=entry]')
    expect(rows).toHaveLength(3)
    // Labelled since 2026-08-21: the line is "куда: <host>", so the value is asserted
    // inside the sentence the reader actually sees rather than instead of it.
    expect(rows[0]?.querySelector('[data-role=entry-destination]')?.textContent).toContain(
      'api.pwnedpasswords.com',
    )
    expect(rows[0]?.querySelector('[data-role=entry-payload]')?.textContent).toContain(
      'hash-prefix:5BAA6',
    )
  })

  it('explains the purpose in the reader’s words, not in ours', () => {
    expect(el.querySelector('[data-role=entry-purpose]')?.textContent).toContain(
      message('auditPurposePasswordRange'),
    )
  })

  it('offers the export that makes the claim checkable against a network trace', () => {
    expect(el.querySelector('[data-role=export]')).not.toBeNull()
  })
})

describe('loading', () => {
  it('says it is reading rather than showing an empty list', () => {
    const el = renderSelfAudit(document, { kind: 'loading' }, handlers)
    expect(el.querySelector('[data-role=status]')?.textContent).toContain(message('auditReading'))
    expect(el.querySelector('[data-role=entries]')).toBeNull()
  })
})

describe('the window the sentence names is the window the panel shows', () => {
  // The panel used to be handed everything `outbound_log` holds — retention is
  // ninety days — under a sentence that said "the last seven". The number and
  // the claim beside it described different sets, on the one screen whose whole
  // purpose is to be checkable against a browser network trace.
  const entries = [
    entry({ id: 'in', createdAt: '2026-08-04T09:00:00.000Z' }),
    entry({ id: 'out', createdAt: '2026-07-02T09:00:00.000Z' }),
  ]
  const el = renderSelfAudit(
    document,
    { kind: 'ready', window: 'week' as const, entries, since: 'x', windowStartIso: '2026-08-01T00:00:00.000Z' },
    handlers,
  )

  it('leaves out what the window leaves out', () => {
    const rows = el.querySelectorAll('[data-role=entry]')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.getAttribute('data-entry')).toBe('in')
  })

  it('counts what it shows, not what it was handed', () => {
    expect(el.querySelector('[data-role=summary]')?.textContent).toMatch(/:\s*1/)
  })

  it('lists the newest first, as the screen record says it does', () => {
    const three = renderSelfAudit(
      document,
      {
        kind: 'ready', window: 'week' as const,
        since: 'x',
        windowStartIso: '2026-08-01T00:00:00.000Z',
        entries: [
          entry({ id: 'mid', createdAt: '2026-08-04T09:00:00.000Z' }),
          entry({ id: 'new', createdAt: '2026-08-06T09:00:00.000Z' }),
          entry({ id: 'old', createdAt: '2026-08-02T09:00:00.000Z' }),
        ],
      },
      handlers,
    )
    const ids = [...three.querySelectorAll('[data-role=entry]')].map((r) =>
      r.getAttribute('data-entry'),
    )
    expect(ids).toEqual(['new', 'mid', 'old'])
  })
})

describe('a row the store wrote incompletely', () => {
  // Read straight out of IndexedDB, where a row written by an older build, or a
  // row a migration half-finished, does not have to match the type. The screen
  // printed "источник: undefined" and left three lines blank — on the surface
  // that carries the product's central claim.
  const broken = { id: 'b1', createdAt: '2026-08-04T09:00:00.000Z' } as unknown as AuditEntry
  const el = renderSelfAudit(
    document,
    { kind: 'ready', window: 'week' as const, entries: [broken], since: 'x', windowStartIso: '2026-08-01T00:00:00.000Z' },
    handlers,
  )

  it('never prints a value that is not there', () => {
    expect(el.textContent ?? '').not.toContain('undefined')
    expect(el.textContent ?? '').not.toContain('null')
  })

  it('names each missing field rather than leaving a blank line', () => {
    for (const role of ['entry-destination', 'entry-purpose', 'entry-payload'] as const) {
      const line = el.querySelector(`[data-role=${role}]`)?.textContent ?? ''
      expect(line, role).not.toBe('')
      expect(line, role).toContain(message('auditFieldUnknown'))
    }
    expect(el.querySelector('[data-role=entry-trigger]')?.textContent).toContain(
      message('auditFieldUnknown'),
    )
  })

  it('keeps the row rather than hiding it, because hiding is the dangerous direction', () => {
    expect(el.querySelectorAll('[data-role=entry]')).toHaveLength(1)
  })

  it('counts it, and says its outcome was not recorded', () => {
    const summary = el.querySelector('[data-role=summary]')?.textContent ?? ''
    expect(summary).toContain(message('auditSummaryUnknownOutcome').split('$')[0]?.trim())
  })

  it('refuses to vouch for a request whose purpose it cannot read', () => {
    const summary = el.querySelector('[data-role=summary]')?.textContent ?? ''
    expect(summary).toContain(message('auditSummaryUnknownPurpose').split('$')[0]?.trim())
    expect(summary).not.toContain(message('auditSummaryNoContent'))
  })
})

describe('an entry with no time at all is still an entry', () => {
  const el = renderSelfAudit(
    document,
    {
      kind: 'ready', window: 'week' as const,
      since: 'x',
      windowStartIso: '2026-08-01T00:00:00.000Z',
      entries: [{ ...entry(), createdAt: '' }],
      },
    handlers,
  )

  it('is listed, because a row the window cannot place is not a row to drop', () => {
    expect(el.querySelectorAll('[data-role=entry]')).toHaveLength(1)
  })

  it('says the time is not recorded instead of printing an empty line', () => {
    // The label carries the field name and the body says the value is missing: one
    // sentence in both cases, which is the point of labelling them.
    expect(el.querySelector('[data-role=entry-time]')?.textContent).toBe(
      `${message('auditWhen').split('$')[0]}${message('auditFieldUnknown')}`,
    )
  })
})

describe('the absence the summary claims is only the absence it can prove', () => {
  // `docs/brand/facts.md` says in its own table that `leak-lookup` sends the
  // email address and `domain-status` sends the domain. The summary asserted
  // that no request carried an email — under a list containing exactly such a
  // request. A false privacy claim on the verification screen is worse than no
  // screen at all.
  it('names the address it sent instead of denying it sent one', () => {
    const el = renderSelfAudit(
      document,
      {
        kind: 'ready', window: 'week' as const,
        since: 'x',
        windowStartIso: '2026-08-01T00:00:00.000Z',
        entries: [entry({ purpose: 'leak-lookup', payloadShape: 'email:s@example.test' })],
      },
      handlers,
    )
    const summary = el.querySelector('[data-role=summary]')?.textContent ?? ''
    expect(summary).toContain(message('auditSummaryCarriedAddress').split('$')[0]?.trim())
    expect(summary).toContain(message('auditSummaryNoContent'))
  })

  it('names the domain a status check carried', () => {
    const el = renderSelfAudit(
      document,
      {
        kind: 'ready', window: 'week' as const,
        since: 'x',
        windowStartIso: '2026-08-01T00:00:00.000Z',
        entries: [entry({ purpose: 'domain-status', payloadShape: 'domain:example.test' })],
      },
      handlers,
    )
    expect(el.querySelector('[data-role=summary]')?.textContent).toContain(
      message('auditSummaryCarriedDomain').split('$')[0]?.trim(),
    )
  })

  it('still says what never leaves, because that is the claim the choke point keeps', () => {
    const el = renderSelfAudit(
      document,
      {
        kind: 'ready', window: 'week' as const,
        since: 'x',
        windowStartIso: '2026-08-01T00:00:00.000Z',
        entries: [entry({ purpose: 'feed-update', payloadShape: 'none' })],
      },
      handlers,
    )
    const summary = el.querySelector('[data-role=summary]')?.textContent ?? ''
    expect(summary).toContain(message('auditSummaryNoContent'))
    expect(summary).not.toContain(message('auditSummaryCarriedAddress').split('$')[0]?.trim())
  })
})

describe('the instant is rendered the way every other screen renders one', () => {
  it('uses the shared rendering rather than the stored string', () => {
    const el = renderSelfAudit(
      document,
      {
        kind: 'ready', window: 'week' as const,
        since: 'x',
        windowStartIso: '2026-08-01T00:00:00.000Z',
        entries: [entry({ createdAt: '2026-08-04T09:00:00.000Z' })],
      },
      handlers,
    )
    // The raw stored form reached this screen while four others were converted:
    // the sweep that consolidated the formatters looked for copies of the
    // function and could not see a screen that called none.
    expect(el.querySelector('[data-role=entry-time]')?.textContent).toContain(
      '2026-08-04 09:00:00 UTC',
    )
  })
})

describe('every line says which field it is', () => {
  // Five bare lines meant a reader had to know the order to know what they were reading —
  // and a row missing two fields read as the same shape with parts silently absent. Found
  // 2026-08-21 by rendering the area and looking at it.
  const el = renderSelfAudit(
    document,
    {
      kind: 'ready', window: 'week' as const,
      since: 'x',
      windowStartIso: '2026-08-01T00:00:00.000Z',
      entries: [entry()],
    },
    handlers,
  )

  it('labels the time, the destination, the purpose and the payload', () => {
    for (const [role, key] of [
      ['entry-time', 'auditWhen'],
      ['entry-destination', 'auditWhere'],
      ['entry-purpose', 'auditWhy'],
      ['entry-payload', 'auditWhat'],
    ] as const) {
      const label = message(key).split('$')[0] as string
      expect(el.querySelector(`[data-role=${role}]`)?.textContent, role).toContain(label.trim())
    }
  })

  it('reads as one sentence whether the value is there or not', () => {
    const broken = { id: 'b', createdAt: '2026-08-04T09:00:00.000Z' } as unknown as AuditEntry
    const missing = renderSelfAudit(
      document,
      { kind: 'ready', window: 'week' as const, since: 'x', windowStartIso: '2026-08-01T00:00:00.000Z', entries: [broken] },
      handlers,
    )
    const line = missing.querySelector('[data-role=entry-destination]')?.textContent ?? ''
    expect(line).toContain(message('auditWhere').split('$')[0]?.trim() as string)
    expect(line).toContain(message('auditFieldUnknown'))
  })
})

describe('a row opens, and what is behind it is what the log holds', () => {
  /**
   * SCR-10 promised "per-row detail with the exact bytes sent and redaction applied" for two
   * weeks while rows were flat and unopenable (B-101). The exact bytes are deliberately not
   * stored — a leak lookup writes `email:s***@example.test`, redacted where it is written,
   * because this log is exportable and wipeable and a log full of plaintext addresses would
   * be a secret store of its own. So the detail answers the question instead: what left, and
   * what was held back.
   */
  const opened = (e: AuditEntry): HTMLElement =>
    renderSelfAudit(
      document,
      { kind: 'ready', window: 'week' as const, entries: [e], since: 'x', windowStartIso: '2026-08-01T00:00:00.000Z' },
      handlers,
    )

  it('is a native disclosure, so a keyboard reaches it', () => {
    const el = opened(entry())
    expect(el.querySelector('details[data-role=entry-detail]')).not.toBeNull()
    expect(el.querySelector('summary[data-role=entry-summary]')).not.toBeNull()
  })

  it('says what that purpose sends and what it does not', () => {
    expect(
      opened(entry({ purpose: 'password-range' })).querySelector('[data-role=entry-kept]')
        ?.textContent,
    ).toBe(message('auditKeptPasswordRange'))
    expect(
      opened(entry({ purpose: 'leak-lookup' })).querySelector('[data-role=entry-kept]')
        ?.textContent,
    ).toBe(message('auditKeptLeakLookup'))
  })

  it('refuses to describe a purpose it cannot read', () => {
    const odd = { ...entry(), purpose: 'something-new' } as unknown as AuditEntry
    expect(opened(odd).querySelector('[data-role=entry-kept]')?.textContent).toBe(
      message('auditKeptUnknown'),
    )
  })

  it('names the outcome in words, and says when there is none', () => {
    expect(opened(entry({ outcome: 'blocked-by-redactor' })).querySelector('[data-role=entry-outcome]')?.textContent).toContain(
      message('auditOutcomeBlocked'),
    )
    const noOutcome = { ...entry(), outcome: undefined } as unknown as AuditEntry
    expect(opened(noOutcome).querySelector('[data-role=entry-outcome]')?.textContent).toContain(
      message('auditFieldUnknown'),
    )
  })
})

describe('the period is a control, not a fixed sentence', () => {
  // Retention is ninety days and the default view is seven, so without this the other
  // eighty-three were reachable only by exporting the file.
  const el = renderSelfAudit(
    document,
    { kind: 'ready', window: 'week' as const, entries: [entry()], since: 'x', windowStartIso: '2026-08-01T00:00:00.000Z' },
    handlers,
  )

  it('offers both periods and marks the one in force', () => {
    expect(el.querySelector('[data-role=window-week]')?.getAttribute('aria-pressed')).toBe('true')
    expect(el.querySelector('[data-role=window-all]')?.getAttribute('aria-pressed')).toBe('false')
  })

  it('asks the caller for the other one rather than filtering behind its back', () => {
    const onWindow = vi.fn()
    const own = renderSelfAudit(
      document,
      { kind: 'ready', window: 'week' as const, entries: [entry()], since: 'x', windowStartIso: '2026-08-01T00:00:00.000Z' },
      { ...handlers, onWindow },
    )
    own.querySelector<HTMLButtonElement>('[data-role=window-all]')?.click()
    expect(onWindow).toHaveBeenCalledWith('all')
  })
})

/**
 * B-125: with a key saved, a leak lookup to Have I Been Pwned carries the person's key in a
 * header. The summary counted the address and said nothing of the key.
 */
describe('the summary counts the key when it left', () => {
  const lookup = (id: string, payloadShape: string): AuditEntry =>
    entry({
      id,
      destination: id === 'hibp' ? 'haveibeenpwned.com' : 'cavalier.hudsonrock.com',
      purpose: 'leak-lookup',
      payloadShape,
      triggeredBy: 'user:leak-check',
    })
  const render = (entries: AuditEntry[]): string =>
    renderSelfAudit(
      document,
      { kind: 'ready', window: 'week' as const, entries, since: 'x', windowStartIso: '2026-08-01T00:00:00.000Z' },
      handlers,
    ).querySelector('[data-role=summary]')?.textContent ?? ''
  const lead = (key: string): string => message(key).split('$')[0]?.trim() ?? ''

  it('names the key, counted, beside the address', () => {
    const summary = render([
      lookup('hibp', `email:s***@example.test, ${HIBP_KEY_HEADER_SHAPE}`),
      lookup('cavalier', 'email:s***@example.test'),
    ])
    expect(summary).toContain(lead('auditSummaryCarriedAddress'))
    expect(summary).toContain(`${lead('auditSummaryCarriedKey')} 1`)
  })

  it('says nothing about a key when none left', () => {
    expect(render([lookup('cavalier', 'email:s***@example.test')])).not.toContain(
      lead('auditSummaryCarriedKey'),
    )
  })
})
