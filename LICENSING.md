# Licensing

Okolos is **open source under the GNU Affero General Public License v3.0 only**, or available
under a **commercial licence** from PassionCode.ai — the same terms as every PassionCode.ai
repository. Free, with no subscription and no licence key.

The whole repository is under one expression, apart from the third-party material below:

`AGPL-3.0-only OR LicenseRef-PassionCode-Commercial`

The AGPL text is [LICENSE](LICENSE); the commercial offer is
[COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md). The decision and its reasons are
[ADR-0016](docs/adr/0016-okolos-returns-to-agpl-with-a-commercial-licence.md), which carries out
Fabric ADR-0092 for this repository; `tools/licensing.test.ts` fails the build when a manifest or
a document stops saying this.

## What you may do

| You want to | Without asking | Under which licence |
|---|---|---|
| Use Okolos yourself, study it, change it | yes | AGPL-3.0 |
| Install it across your company, or run its Worker for your own team | yes | AGPL-3.0 |
| Share your changed version, or run a changed Worker as a service for others | yes, if you publish your changes' source under the AGPL | AGPL-3.0 |
| Build it — or its code, the engine included — into a closed-source product, or run a changed hosted service without publishing its source | **no — ask first** | a commercial licence: **contact@passioncode.ai** |

The summary is not the licence; the texts in [LICENSE](LICENSE) and
[COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md) govern.

## Earlier versions

Nothing has been released yet; the terms below are those of the commits. Commits up to and
including `5a8e490` (2026-09-29) were released under AGPL-3.0-only, and in the last of them the
engine packages (`packages/contracts`, `packages/core-*`) and `corpora/` under Apache-2.0. Commits
after `5a8e490` up to and including `0557023` (2026-09-29 to 2026-10-01) were released under
`PolyForm-Noncommercial-1.0.0 OR LicenseRef-PolyForm-Internal-Use-1.0.0` (ADR-0015). Those commits
remain available under those licences; everything after them is under the terms above.

## Third-party material

| What | Terms |
|---|---|
| `packages/core-lookalike/src/suffixes.json` — a selection of Public Suffix List rules | MPL-2.0, see that package's [NOTICE](packages/core-lookalike/NOTICE); its manifest says `(AGPL-3.0-only OR LicenseRef-PassionCode-Commercial) AND MPL-2.0` |
| `feeds/phishing.json` — hosts from the OpenPhish community feed | its source's terms; Okolos does not relicense data it did not create |
| Have I Been Pwned breach data shown in the extension | CC BY 4.0, credited on the screens that show it |
| npm dependencies | their own licences, all permissive — checked by `tools/licensing.test.ts` |

The name "Okolos" and its logo are not licensed by either licence.

## Contributing

Contributions are accepted under [CLA.md](CLA.md), the agreement every PassionCode.ai repository
uses: you keep your copyright and let the maintainer offer your contribution under these and
commercial terms. Tick the box in the pull request template.

Copyright (c) 2026 Siarhei Sheleh. Commercial licences and questions: contact@passioncode.ai.
