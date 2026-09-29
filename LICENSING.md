# Licensing

Okolos is **source-available, not open source** — the same terms as every public
PassionCode.ai tool. The code is public: read it, run it, change it for
yourself. Free, with no subscription and no licence key.

The whole repository is under one expression, at your choice:

`PolyForm-Noncommercial-1.0.0 OR LicenseRef-PolyForm-Internal-Use-1.0.0`

The texts are in [LICENSE](LICENSE). The decision and its reasons are
[ADR-0015](docs/adr/0015-okolos-takes-the-organisations-licence.md);
`tools/licensing.test.ts` fails the build when a manifest or a document stops
saying this.

## What you may do

| You want to | Without asking | Under which licence |
|---|---|---|
| Use Okolos yourself — an individual, an indie developer, a hobby project | yes | Noncommercial |
| Change it for yourself and share your changes for noncommercial use | yes | Noncommercial |
| Use it in a school, charity, public body or other noncommercial organisation | yes | Noncommercial |
| Install it across your company, or run its Worker or agent for your own team | yes | Internal Use |
| Change it for your company's own internal operations | yes | Internal Use |
| Sell it, distribute it commercially, or build it — or its code, the engine included — into a product or service you provide to others | **no — ask first** | a separate commercial licence: **contact@passioncode.ai** |

The summary is not the licence; the texts in [LICENSE](LICENSE) govern.

## Earlier versions

Commits up to and including `5a8e490` (2026-09-29) were released under
AGPL-3.0-only, and in the last of them the engine packages and `corpora/` under
Apache-2.0. Those commits remain available under those licences; everything
after them is under the terms above.

## Third-party material

| What | Terms |
|---|---|
| `packages/core-lookalike/src/suffixes.json` — a selection of Public Suffix List rules | MPL-2.0, see that package's [NOTICE](packages/core-lookalike/NOTICE) |
| `feeds/phishing.json` — hosts from the OpenPhish community feed | its source's terms; Okolos does not relicense data it did not create |
| Have I Been Pwned breach data shown in the extension | CC BY 4.0, credited on the screens that show it |
| npm dependencies | their own licences, all permissive — checked by `tools/licensing.test.ts` |

The name "Okolos" and its logo are not licensed by either licence.

## Contributing

Contributions are accepted under [CLA.md](CLA.md), the agreement every
PassionCode.ai repository uses: you keep your copyright and let the maintainer
offer your contribution under these and commercial terms. Tick the box in the
pull request template.

Copyright (c) 2026 Siarhei Sheleh. Commercial licences and questions:
contact@passioncode.ai.
