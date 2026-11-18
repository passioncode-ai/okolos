import type { AuditEntry, Purpose } from '@okolos/contracts'

import { allowedDestination, DESTINATIONS } from './destinations.js'
import { findForbiddenContent, type Carries, type RedactionFinding } from './redactor.js'
import { transport as defaultTransport, type TransportSpec } from './transport.js'

/** Closed set: the audit panel has human wording for each of these and no others. */
const PURPOSES: ReadonlySet<string> = new Set<Purpose>([
  'feed-update',
  'model-update',
  'password-range',
  'leak-lookup',
  'file-hash',
  'domain-status',
  'usage-data',
])

export interface RequestSpec {
  readonly url: string
  readonly method: 'GET' | 'POST'
  readonly purpose: Purpose
  /** How the payload is described to a human, e.g. 'hash-prefix:5BAA6'. */
  readonly payloadShape: string
  /** What caused this: 'alarm:feeds', 'user:password-check'. */
  readonly triggeredBy: string
  readonly body?: string
  readonly headers?: Readonly<Record<string, string>>
  /**
   * Sensitive content this request must carry, declared up front.
   *
   * Undeclared, an address is refused by the redactor. Declared, it is
   * permitted *and recorded*: the audit entry says so, which is what makes the
   * exception something the user can see rather than something only the code
   * knows.
   */
  readonly carries?: Carries
}

export interface RequestDeps {
  readonly writeAudit: (entry: AuditEntry) => Promise<void>
  readonly transport?: (spec: TransportSpec) => Promise<Response>
  readonly now: () => string
  readonly newId: () => string
}

export class RedactionError extends Error {
  constructor(readonly finding: RedactionFinding) {
    // i18n-exempt: the redaction refusal is thrown to the caller and the audit entry is what the user reads; this string names the finding for a developer
    super(`Refused to send: ${finding.reason} found in the ${finding.where}`)
    this.name = 'RedactionError'
  }
}

export class DestinationError extends Error {
  constructor(
    readonly purpose: string,
    readonly destination: string,
  ) {
    const allowed = DESTINATIONS[purpose as Purpose]
    super(
      // i18n-exempt: thrown to the caller and never shown as itself — the user reads the audit
      // entry, and a caller that journals a failure now writes this text as `diagnostic`
      // beside a catalogue sentence rather than inside one (B-115)
      `Refused to send: '${purpose}' may not reach ${destination}. ` +
        (allowed && allowed.length > 0
          // i18n-exempt: the second half of the same developer-facing sentence; the sweep is a
          // line rule, so each fragment carries its own reason
          ? `It may reach ${allowed.join(', ')}.`
          // i18n-exempt: names a source file, which is the audience: nobody but a developer can act on a purpose with no destinations
          : `It has no destinations at all — see packages/net/src/destinations.ts for why.`),
    )
    this.name = 'DestinationError'
  }
}

export class AuditWriteError extends Error {
  constructor(cause: unknown) {
    // i18n-exempt: thrown when the audit write failed, so the surface that would show this sentence is the one that is broken
    super('Refused to send: the audit entry could not be written')
    this.name = 'AuditWriteError'
    this.cause = cause
  }
}

/**
 * The single egress point.
 *
 * Order is the whole design: the audit entry is written first, and a failure
 * to write it cancels the request. Written afterwards, the log would describe
 * what already happened; written first, it is the thing that permits it.
 */
export async function request(spec: RequestSpec, deps: RequestDeps): Promise<Response> {
  if (!PURPOSES.has(spec.purpose)) {
    // i18n-exempt: a purpose outside the union is a programming mistake, and the audience of
    // the throw is whoever wrote it
    throw new Error(`Refused to send: unknown purpose '${spec.purpose}'`)
  }

  // A malformed URL must be a refusal, not a crash: throwing out of `new URL`
  // here would skip the audit entry entirely, and an unlogged attempt is the
  // one thing this module exists to make impossible.
  let destination: string
  try {
    destination = new URL(spec.url).hostname
  } catch {
    // i18n-exempt: names the malformed URL for whoever built it; the user's record of the
    // attempt is the audit entry, which is written before this line can be reached
    throw new Error(`Refused to send: '${spec.url}' is not a valid URL`)
  }
  const entry = (outcome: AuditEntry['outcome']): AuditEntry => ({
    id: deps.newId(),
    createdAt: deps.now(),
    destination,
    purpose: spec.purpose,
    payloadShape: spec.payloadShape,
    triggeredBy: spec.triggeredBy,
    outcome,
  })

  const forbidden = findForbiddenContent(spec.url, spec.body, spec.carries)
  if (forbidden) {
    await deps.writeAudit(entry('blocked-by-redactor'))
    throw new RedactionError(forbidden)
  }

  /**
   * Is this purpose allowed to reach this host.
   *
   * After the redactor and before anything leaves. The order between the two
   * refusals is a choice: when both are true, the leak is the more urgent fact,
   * because it names the user's own data and the destination does not. Either way
   * the attempt is recorded — both write the audit entry before throwing, which is
   * what makes "the product tried to send somewhere it may not" a line somebody
   * can read.
   *
   * The destination used to be computed for the journal and for nothing else, so
   * any URL with a valid purpose and a clean payload went to any host.
   */
  if (!allowedDestination(spec.purpose, destination)) {
    await deps.writeAudit(entry('blocked-by-redactor'))
    throw new DestinationError(spec.purpose, destination)
  }

  try {
    await deps.writeAudit(entry('sent'))
  } catch (cause) {
    throw new AuditWriteError(cause)
  }

  const send = deps.transport ?? defaultTransport
  const transportSpec: TransportSpec = {
    url: spec.url,
    method: spec.method,
    ...(spec.body !== undefined ? { body: spec.body } : {}),
    ...(spec.headers !== undefined ? { headers: spec.headers } : {}),
  }

  try {
    return await send(transportSpec)
  } catch (cause) {
    await deps.writeAudit(entry('failed'))
    throw cause
  }
}
