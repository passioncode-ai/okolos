import { describe, expect, it } from 'vitest'

import { checkLookalike } from './check.js'
import { DEFAULT_WATCHLIST } from './watchlist.js'

/**
 * Hosts that are the real thing, measured against the shipped watchlist.
 *
 * The module's own docstring says what it must never do: "flag the real thing …
 * a warning on `accounts.google.com` would teach the user to dismiss the next
 * one without reading it." Measured 2026-08-20, it flagged **twenty-one of these
 * thirty-four** — including every Russian government site, because `pfr.gov.ru`
 * and `nalog.gov.ru` share the label `gov` once you take the second-to-last one
 * as the registrant's; three of the largest mail providers, because `mail.ru`
 * put the word `mail` on the watchlist; and nine companies visited on their own
 * country domain.
 *
 * There was no test like this file. Every case in `check.test.ts` was written
 * from the attack outward, and the innocent population was represented by four
 * hosts. A detector's false-positive rate is a claim about the population it
 * will actually meet, and this is the closest thing to that population the
 * repository can hold offline.
 */

const REAL: ReadonlyArray<readonly [string, string]> = [
  ['amazon.co.uk', 'a brand on its own country domain, under a two-label suffix'],
  ['google.co.uk', 'the same, for a watched name'],
  ['paypal.co.uk', 'the same, for the most-phished name on the list'],
  ['booking.co.il', 'the same, in a market the watchlist serves'],
  ['amazon.com.br', 'the run `amazon.com` sits in front of a registry label, not a registrant'],
  ['microsoft.com.au', 'the same shape, different registry'],
  ['apple.co.jp', 'the same shape again'],
  ['google.de', 'a brand’s country domain, single-label suffix'],
  ['yandex.com', 'a Russian brand’s international domain'],
  ['sberbank.com', 'the same, for a bank'],
  ['github.io', 'a brand’s second domain, which the whole industry uses'],
  ['stripe.dev', 'a brand under a gTLD it owns'],
  ['discord.gg', 'a brand’s short link domain'],
  ['telegram.me', 'the same, and it is on the watchlist under .org'],
  ['vk.ru', 'a brand on both .com and .ru'],
  ['ozon.by', 'a marketplace in a neighbouring market'],
  ['mail.yahoo.com', 'a mail service whose subdomain is the word on the watchlist'],
  ['mail.proton.me', 'the same'],
  ['mail.qq.com', 'the same'],
  ['pfr.gov.ru', 'a government site that is not the tax service'],
  ['mvd.gov.ru', 'another one'],
  ['accounts.google.com', 'a subdomain of a watched host'],
  ['www.amazon.com', 'the plainest case there is'],
  ['docs.github.com', 'a subdomain of a watched host'],
  ['lk.gosuslugi.ru', 'a subdomain of a watched host, in Cyrillic-speaking service'],
  ['my.mail.ru', 'a subdomain of a watched host whose label is generic'],
  ['e.mail.ru', 'the same, one letter long'],
  ['mailchimp.com', 'a brand that contains a watched word'],
  ['gmail.com', 'a name that contains a watched word'],
  ['protonmail.com', 'the same, at the end'],
  ['office.com', 'a watched host itself'],
  ['ups.com', 'a watched host itself, three letters'],
  ['mos.ru', 'a watched host itself, three letters, ccTLD'],
  ['web.telegram.org', 'a subdomain of a watched host'],
  // Investment and giveaway scams impersonate these (Fabric Inbox, 2026-11-17).
  ['tesla.com', 'a watched host itself'],
  ['shop.tesla.com', 'a subdomain of a watched host'],
  ['x.com', 'a watched host itself, one letter'],
  ['x.ai', 'a brand of the same owner on another ending, more than one edit away'],
  ['x.example.com', 'a one-letter subdomain the whole web uses, which is not the brand standing alone'],
  ['cdn.x.com', 'a subdomain of a watched host whose label is one letter'],
  ['developer.nvidia.com', 'a subdomain of a watched host'],
  ['blackrock.com', 'a watched host itself'],
]

const ATTACKS: ReadonlyArray<readonly [string, string, string]> = [
  ['paypal.com.evil.test', 'brand-subdomain', 'the commonest phishing shape there is'],
  ['paypal.evil.test', 'brand-subdomain', 'the brand alone in front of somebody else’s domain'],
  ['sberbank.ru.secure-login.test', 'brand-subdomain', 'the same, with a ccTLD in the run'],
  ['gosuslugi.rf.test', 'brand-subdomain', 'the state portal, in front of a stranger'],
  ['paypal.co', 'tld-swap', 'one edit from .com'],
  ['paypal.cm', 'tld-swap', 'one edit from .com, the other way'],
  ['amazon.co', 'tld-swap', 'the same, for a different brand'],
  ['xn--pypal-4ve.com', 'mixed-script', 'a Cyrillic letter inside a Latin name'],
  ['g00gle.com', 'homograph', 'digits standing in for letters'],
  ['gooogle.com', 'typo', 'one letter too many'],
  ['wildberies.ru', 'typo', 'one letter too few, in the market this list serves'],
  ['tesla.com.invest-bonus.test', 'brand-subdomain', 'the investment scam shape (Fabric Inbox, 2026-11-17)'],
  ['tesla.evil.test', 'brand-subdomain', 'the brand alone in front of a stranger'],
  ['spacex.giveaway.test', 'brand-subdomain', 'the crypto giveaway shape'],
  ['x.com.giveaway.test', 'brand-subdomain', 'the full one-letter name as a run is still caught'],
  ['nvidla.com', 'typo', 'l for i: one edit, which the skeleton does not fold'],
  ['blackrocks.com', 'typo', 'one letter too many, for a fund'],
  /**
   * Recovered in B-67: the brand's own name under an ending that is itself a word
   * about accounts. These three were named in SCN-006 as passing silently, and the
   * rule that used to catch them flagged nine of the real hosts above.
   */
  ['paypal.security', 'brand-under-login-word', 'the ending is the phishing instruction'],
  ['paypal.support', 'brand-under-login-word', 'the same, in the word a victim is looking for'],
  ['paypal.login', 'brand-under-login-word', 'the same, said plainly'],
  ['sberbank.verify', 'brand-under-login-word', 'a bank, in the market this list serves'],
  ['gosuslugi.account', 'brand-under-login-word', 'the state portal'],
  ['ozon.payment', 'brand-under-login-word', 'a marketplace, and the word is about money'],
]

describe('what it must never do: flag the real thing', () => {
  for (const [host, why] of REAL) {
    it(`stays quiet on ${host} — ${why}`, () => {
      expect(checkLookalike(host, DEFAULT_WATCHLIST)).toBeNull()
    })
  }

  it('is quiet on the whole sample, so a rule cannot be fixed by moving the failure', () => {
    const flagged = REAL.map(([host]) => host)
      .map((host) => ({ host, verdict: checkLookalike(host, DEFAULT_WATCHLIST) }))
      .filter((r) => r.verdict !== null)
      .map((r) => `${r.host} ~ ${r.verdict?.kind}`)
    expect(flagged).toEqual([])
  })
})

describe('and it still catches what it is for', () => {
  for (const [host, kind, why] of ATTACKS) {
    it(`names ${host} as ${kind} — ${why}`, () => {
      expect(checkLookalike(host, DEFAULT_WATCHLIST)?.kind).toBe(kind)
    })
  }
})
