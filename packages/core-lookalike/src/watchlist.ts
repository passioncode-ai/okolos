/**
 * The names worth impersonating.
 *
 * Shipped with the extension rather than fetched, because a lookalike check
 * that needs the network is a lookalike check that does not run on the page
 * where it matters. It is deliberately short: every entry costs a comparison on
 * every navigation, and a list of ten thousand brands would both slow the page
 * down and start flagging genuine sites that happen to be one letter apart.
 *
 * These are the targets that appear in phishing corpora year after year. A
 * user's own frequently-visited sites are added on top at runtime; that list is
 * theirs and never leaves the device.
 *
 * **The list is a coverage claim, and it has a market.** Until 2026-08-08 all
 * 29 entries were Western — no bank, no state services portal, no marketplace
 * from the market this product is built for — while the product's own published
 * feed listed `sberbank-online-vhod.test` and `gosuslugi-podtverzhdenie.test`.
 * A lookalike check protects the names it knows; that one protected PayPal and
 * DHL for an audience being phished for Sberbank.
 */
export const DEFAULT_WATCHLIST: readonly string[] = [
  'google.com',
  'youtube.com',
  'facebook.com',
  'instagram.com',
  'whatsapp.com',
  'apple.com',
  'icloud.com',
  'microsoft.com',
  'outlook.com',
  'office.com',
  'amazon.com',
  'netflix.com',
  'paypal.com',
  'stripe.com',
  'coinbase.com',
  'binance.com',
  'metamask.io',
  'github.com',
  'gitlab.com',
  'linkedin.com',
  'dropbox.com',
  'adobe.com',
  'steamcommunity.com',
  'discord.com',
  'telegram.org',
  'booking.com',
  'dhl.com',
  'fedex.com',
  'ups.com',

  // Banks and payments. A Cyrillic а inside a Latin name renders identically,
  // which is the attack these entries exist for.
  'sberbank.ru',
  'tinkoff.ru',
  'alfabank.ru',
  'vtb.ru',
  'gazprombank.ru',
  'raiffeisen.ru',
  'psbank.ru',
  'mkb.ru',
  'sovcombank.ru',

  // The state, where an account is worth more than a card.
  'gosuslugi.ru',
  'nalog.gov.ru',
  'mos.ru',

  // Marketplaces and delivery, where a fake order page collects a card.
  'ozon.ru',
  'wildberries.ru',
  'avito.ru',
  'dns-shop.ru',
  'cdek.ru',

  // Mail and identity, the account that resets all the others.
  'yandex.ru',
  'mail.ru',
  'vk.com',

  // Investment and giveaway scams: a fund, a carmaker and a rocket company promising returns,
  // and the network where the giveaway is posted. Asked for by Fabric Inbox on 2026-11-17 after
  // a forged enquiry whose sender's site, registered that April, named Tesla in its title.
  'tesla.com',
  'spacex.com',
  'x.com',
  'nvidia.com',
  'blackrock.com',
]
