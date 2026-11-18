# suffixes.json: why these lists

The prose that used to sit inside `suffixes.json` as `note`, `whyNotTheWholeList` and
`beyondThePublicSuffixListNote`. It moved here on 2026-11-18 (B-225): a bundler that keeps
every field of an imported JSON object (Vite 8, rolldown) shipped these paragraphs inside
`content.js`, where nothing reads them. The data stays in `suffixes.json`; its `readme` field
points here.

## One list, two readers (`note`)

One list, two readers: packages/core-lookalike/src/suffix.ts imports it and tools/ingest.mjs reads it. It was a TypeScript constant and a hand-written array of forty-eight exact matches in the ingest tool: two lists, and the ingest one was missing every platform the source actually emits hosts under. A list with two copies agrees with itself and with nothing else.

## Why not the whole Public Suffix List (`whyNotTheWholeList`)

Measured 2026-08-20 against the real Public Suffix List (10 248 rules: 6 949 ICANN, 3 299 private). Vendoring all of it costs 171 KB of JSON on a 61.5 KB content script, 3.7x, on every page load. The private section alone costs 69 KB, 2.1x, and both leave 283 wildcard and 8 exception rules unimplemented, so even after paying the table would be incomplete in a new way. What it buys, measured against the 248 hosts of the shipped feed: three sat under a private suffix this list lacked, and ZERO were themselves an unknown private apex, which is the case that would have blocked a whole platform. Those three families were added instead (jdevcloud.com, the replit.dev regions, the s3.*.amazonaws.com regions). B-66 is closed as this trade, and tools/suffix-gap.mjs re-measures it on demand rather than leaving it a claim.

## The entries that are not in the real list (`beyondThePublicSuffixListNote`)

These 32 are NOT in the real list, in either section, and that is deliberate: do not 'sync with the PSL' and delete them. Two kinds. The ICANN-shaped ones (com.it, sch.uk) keep a registry-like ending out of the registrant's label. The rest are hosting platforms the phishing source has been observed to emit hosts under: the PSL carries myshopify.com and netlify.app, the source uses shopify.com and netlify.com. A missing entry here does not lose a finding, it emits a ||host^ rule over somebody else's platform, which is why this side is added to on observation rather than waiting for the list.
