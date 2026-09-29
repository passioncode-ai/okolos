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

Source-available under PolyForm Noncommercial or Internal Use; commercial licence on request.
Individuals and noncommercial organisations may use, change and share it for noncommercial
purposes; any company may use and change it — including the Cloudflare Worker — for its own
internal operations. Distributing it commercially, or building it into a product or service
provided to others, needs a separate commercial licence from <contact@passioncode.ai>. The
terms are in [LICENSE](LICENSE), what they mean in practice in [LICENSING.md](LICENSING.md);
contributions are accepted under the [CLA](CLA.md). Commits up to and including `5a8e490`
were released under AGPL-3.0 (the engine, in the last of them, under Apache-2.0), and those
commits remain available under those licences.
