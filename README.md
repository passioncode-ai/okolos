# Okolos

**Browser security for the age of AI agents.** Okolos finds instructions
hidden on a web page for your AI assistant, strips them before the assistant
reads them, checks the links and files you open, watches your extensions for
permission changes, and tells you when your passwords leak — with everything
computed on your device.

> Status: **pre-alpha, in active construction.** No release yet. The design,
> UX chain and evidence base are complete and public; code is being built
> module by module. Follow [docs/superpowers/module-map.md](docs/superpowers/module-map.md).

## Why this exists

Every consumer security extension that protects your browsing also *watches*
your browsing — the incumbents render a server-side history of the pages you
visited into a web dashboard. Okolos is built the other way round: verdicts
are computed locally, only anonymous hash prefixes ever leave the device, and
the extension keeps a log of every outbound request it made, which you can
read and export.

That claim is enforced by a test, not by a promise: any outbound request that
does not pass through the single network choke point and land in the audit log
fails the build.

## What it does

| Layer | Capability |
|---|---|
| **AI Shield** | Detects text present in the DOM but invisible to a human and phrased as an instruction — the "XSS of the agent era". Three local stages: DOM-vs-render diff → rules and signatures → a compact ONNX classifier that never blocks on its own |
| **Sanitizer & agent gate** | Removes hidden instructions before an assistant reads the page (reversibly), and requires a human decision before an agent acts on a page where an injection was found |
| **Link & page guard** | Known-phishing blocking, punycode/homoglyph/typosquat lookalikes, open-redirect unwrapping, ClickFix "paste-and-run" fake CAPTCHAs, tech-support lock traps, credential-entry warnings |
| **Download guard** | Reputation of the final URL, type/MIME mismatch, known-bad hashes — and an honest statement of which checks did *not* run |
| **Credentials** | Password leak checks against a local corpus (zero network requests on a hit), k-anonymity with padding otherwise, reuse detection, breach and infostealer monitoring |
| **Extension guard** | Continuous watch: permission deltas between versions, publisher changes, silent updates, static package analysis. One-time vetting is not enough — 34% of extensions gained permissions in a year |
| **Assistant** | Every verdict explained in plain language with at most three next steps, at least one executable in place. Never more than three items in the queue |

Full vector coverage: [docs/coverage-matrix.md](docs/coverage-matrix.md).

## Principles

1. Local-first — browsing history never leaves the device.
2. Anonymous primitives only — hash prefixes, never URLs or addresses.
3. No stored third-party breach dumps — hashes and metadata only.
4. Self-audit — the product shows you what it sent.
5. Action over alarm — a queue you can finish, not a counter that grows.
6. Explainable and disputable verdicts — one click to overrule, and it is remembered.
7. No telemetry, no analytics, no gamification, no paywall.

## Documentation

| Document | Content |
|---|---|
| [docs/product-vision.md](docs/product-vision.md) | Positioning, segments, six core functions, roadmap, metrics, risks |
| [docs/coverage-matrix.md](docs/coverage-matrix.md) | Every scam vector → detection method → local or network → release |
| [docs/data-sources.md](docs/data-sources.md) | Feed and API registry: limits, cost, privacy, licensing |
| [docs/evidence/](docs/evidence/) | Every number in these documents with its source and confidence grade |
| [docs/ux/](docs/ux/) | The UX chain: personas → jobs → journeys → stories → flows → screens → scenarios |
| [docs/competitors.md](docs/competitors.md) | What people buy competitors for, praise, and complain about |

## Building

Not yet buildable — the skeleton lands with module M0. Toolchain: pnpm
workspaces, TypeScript, Vitest, Playwright, Wrangler.

## Data sources and attribution

Breach data from [Have I Been Pwned](https://haveibeenpwned.com) is used under
CC BY 4.0. URL intelligence comes from OpenPhish, PhishTank, URLhaus and
Phishing Army. Infostealer intelligence from Hudson Rock's community API.

## Licence

Free for anyone — yourself or your whole organisation; no subscription, no paid
tier. Two licences, split by purpose ([LICENSING.md](LICENSING.md), ADR-0014):

- **The engine** — `packages/contracts` and every `packages/core-*` — is
  **Apache-2.0**, so it can be embedded in a mail client, an agent or your own
  product.
- **The product** is [AGPL-3.0](LICENSE) — the extension, including the
  Cloudflare Worker, and the local agent. A hosted service built on this code
  must publish its source. For a product whose central claim is "you can verify
  this", closed forks would defeat the point.
