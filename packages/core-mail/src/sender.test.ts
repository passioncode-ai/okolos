import { describe, expect, it } from 'vitest'

import { checkLookalike, DEFAULT_WATCHLIST } from '@okolos/core-lookalike'

import { parseMessage } from './parse.js'
import { checkReplyPath, checkSenderAuth, checkSenderIdentity } from './sender.js'
import type { CheckOutcome, MailSignal } from './verdict.js'
import type { MailMessage } from './types.js'

const deps = {
  lookalike: (host: string) => checkLookalike(host, DEFAULT_WATCHLIST),
  watchlist: DEFAULT_WATCHLIST,
}

function message(headers: readonly string[]): MailMessage {
  const outcome = parseMessage([...headers, '', 'body', ''].join('\r\n'))
  if (!outcome.ok) throw new Error(`fixture did not parse: ${outcome.reason.code}`)
  return outcome.message
}

function signals(outcome: CheckOutcome): readonly MailSignal[] {
  if (!outcome.ran) throw new Error(`expected the check to run, it skipped: ${outcome.why}`)
  return outcome.signals
}

function skipped(outcome: CheckOutcome): string {
  if (outcome.ran) throw new Error('expected the check to skip, it ran')
  return outcome.why
}

const codes = (outcome: CheckOutcome): string[] => signals(outcome).map((s) => s.code)

describe('what the receiving server already worked out', () => {
  /**
   * Standing instruction 3, in the place it matters most on this surface. A
   * message nobody authenticated and a message that authenticated cleanly must
   * not print the same thing — and "no header" is by far the commoner of the
   * two, so folding it into a pass would make the check useless exactly where
   * it is needed.
   */
  it('skips rather than passes when no authentication header exists at all', () => {
    const outcome = checkSenderAuth(message(['From: a@b.test', 'Subject: s']))
    expect(skipped(outcome)).toBe('mailSkipNoAuthResult')
  })

  it('says nothing when every mechanism passed', () => {
    const outcome = checkSenderAuth(
      message([
        'From: a@b.test',
        'Authentication-Results: mx.test; spf=pass smtp.mailfrom=b.test; dkim=pass header.d=b.test; dmarc=pass',
      ]),
    )
    expect(codes(outcome)).toEqual([])
  })

  it('names a DMARC failure, which is the one that means the domain disowns it', () => {
    const outcome = checkSenderAuth(
      message(['From: a@b.test', 'Authentication-Results: mx.test; dmarc=fail; spf=pass']),
    )
    expect(codes(outcome)).toContain('mailSenderDmarcFail')
    expect(signals(outcome)[0]?.severity).toBe('critical')
  })

  it('names SPF and DKIM failures separately, because the remedies differ', () => {
    const outcome = checkSenderAuth(
      message(['From: a@b.test', 'Authentication-Results: mx.test; spf=fail; dkim=fail']),
    )
    expect(codes(outcome).sort()).toEqual(['mailSenderDkimFail', 'mailSenderSpfFail'])
  })

  it('reads the older Received-SPF header when that is all there is', () => {
    const outcome = checkSenderAuth(message(['From: a@b.test', 'Received-SPF: fail (domain of b.test)']))
    expect(codes(outcome)).toContain('mailSenderSpfFail')
  })

  /**
   * A signature that validates for a domain nobody claimed to be writing from
   * is how a message passes DKIM and still lies: the mechanics are sound and
   * the identity is somebody else's.
   */
  it('notices a DKIM signature aligned to a different domain than From', () => {
    const outcome = checkSenderAuth(
      message([
        'From: a@bank.test',
        'Authentication-Results: mx.test; dkim=pass header.d=mailer.example',
      ]),
    )
    expect(codes(outcome)).toContain('mailSenderNotAligned')
  })

  it('accepts alignment on the registrable domain, not only on an exact match', () => {
    const outcome = checkSenderAuth(
      message([
        'From: a@mail.bank.test',
        'Authentication-Results: mx.test; dkim=pass header.d=bank.test; dmarc=pass',
      ]),
    )
    expect(codes(outcome)).toEqual([])
  })

  it('carries the two domains as facts, on rows of their own', () => {
    const outcome = checkSenderAuth(
      message(['From: a@bank.test', 'Authentication-Results: mx.test; dkim=pass header.d=other.test']),
    )
    const facts = signals(outcome)[0]?.facts ?? []
    expect(facts.map((f) => f.value)).toEqual(['bank.test', 'other.test'])
  })
})

describe('who the sender says they are', () => {
  it('skips when there is no From address to judge', () => {
    expect(skipped(checkSenderIdentity(message(['Subject: s']), deps))).toBe('mailSkipNoSender')
  })

  it('says nothing about an ordinary sender', () => {
    expect(codes(checkSenderIdentity(message(['From: "Ann" <ann@example.test>']), deps))).toEqual([])
  })

  it('names a domain that is a lookalike of a watched one', () => {
    const outcome = checkSenderIdentity(message(['From: no-reply@paypa1.com']), deps)
    expect(codes(outcome)).toContain('mailSenderLookalikeDomain')
  })

  /**
   * The display name is the one field an attacker controls completely, and the
   * one most clients show instead of the address.
   */
  it('names a watched brand in the display name whose domain is not that brand', () => {
    const outcome = checkSenderIdentity(
      message(['From: "PayPal Service" <billing@secure-notice.test>']),
      deps,
    )
    expect(codes(outcome)).toContain('mailSenderBrandMismatch')
    expect(signals(outcome)[0]?.severity).toBe('critical')
  })

  it('leaves the real brand alone, including its subdomains', () => {
    expect(
      codes(checkSenderIdentity(message(['From: "PayPal" <service@paypal.com>']), deps)),
    ).toEqual([])
    expect(
      codes(checkSenderIdentity(message(['From: "PayPal" <s@mail.paypal.com>']), deps)),
    ).toEqual([])
  })

  /**
   * A brand name inside a longer word is not that brand: "paypalatable" and a
   * sentence about "the microsoft-free stack" would both fire on a naive
   * substring, and a check that cries wolf is how a person learns to dismiss it.
   */
  it('does not fire on a brand name embedded inside another word', () => {
    expect(
      codes(checkSenderIdentity(message(['From: "Applesauce Recipes" <hi@food.test>']), deps)),
    ).toEqual([])
  })

  it('carries both halves as facts, so the reader can compare them', () => {
    const outcome = checkSenderIdentity(
      message(['From: "PayPal Service" <billing@secure-notice.test>']),
      deps,
    )
    const facts = signals(outcome)[0]?.facts ?? []
    expect(facts.map((f) => f.value)).toEqual(['PayPal Service', 'secure-notice.test'])
  })
})

describe('where a reply would actually go', () => {
  it('says nothing when there is no Reply-To, because absence is ordinary here', () => {
    expect(codes(checkReplyPath(message(['From: a@b.test'])))).toEqual([])
  })

  it('says nothing when Reply-To shares the registrable domain', () => {
    expect(
      codes(checkReplyPath(message(['From: a@mail.b.test', 'Reply-To: support@b.test']))),
    ).toEqual([])
  })

  /** The shape of business-email compromise: looks like them, answers to them. */
  it('names a Reply-To that leads somewhere else entirely', () => {
    const outcome = checkReplyPath(message(['From: a@bank.test', 'Reply-To: collect@mail.ru']))
    expect(codes(outcome)).toContain('mailSenderReplyElsewhere')
    expect(signals(outcome)[0]?.facts.map((f) => f.value)).toEqual(['bank.test', 'mail.ru'])
  })

  it('skips when there is no From to compare against', () => {
    expect(skipped(checkReplyPath(message(['Reply-To: x@y.test'])))).toBe('mailSkipNoSender')
  })
})
