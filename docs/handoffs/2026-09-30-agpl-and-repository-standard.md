# Handoff 2026-09-30 — AGPL-3.0 or commercial, and the repository standard

**Objective.** Bring Okolos onto the PassionCode.ai repository standard (fabric-workspace
`knowledge/repository-standard.md`, rules F1–F11) and the licence of Fabric ADR-0092:
`AGPL-3.0-only OR LicenseRef-PassionCode-Commercial`. No behaviour change: only the licence, its
statements and the checks that hold them.

**Base.** `origin/main` at `0557023` — the last commit released under PolyForm (the branch was
written on `a43ef65` and rebased on 2026-10-01, see below). Branch `agent/standard-agpl`.

## Done

| What | Where |
|---|---|
| `LICENSE` is the unmodified AGPL-3.0 text (the knowledge-base template, SHA-256 `0d96a4ff…abcb0`); `COMMERCIAL-LICENSE.md` is the template; `CLA.md` already was | root |
| The decision for this repository, superseding ADR-0015 | [ADR-0016](../adr/0016-okolos-returns-to-agpl-with-a-commercial-licence.md); ADR-0015's status line and the ADR index |
| History kept: AGPL-3.0-only (Apache-2.0 for the engine and `corpora/` in the last of them) up to `5a8e490`; PolyForm after it up to `0557023` | [LICENSING.md](../../LICENSING.md) → Earlier versions, `README.md` → License |
| Third-party terms unchanged: Public Suffix List selection (MPL-2.0, `packages/core-lookalike/NOTICE`), OpenPhish, HIBP (CC BY 4.0) | `LICENSING.md` → Third-party material |
| 24 `package.json` files carry the expression (`core-lookalike`: `(…) AND MPL-2.0`) | `tools/licensing.test.ts` |
| `tools/licensing.test.ts` rewritten: LICENSE hashed against the AGPL text, the commercial offer, both histories, no surface presenting PolyForm/"source-available" as current or denying "open source" | same file |
| The Worker landing page's `license` is the AGPL URL and its sentence names the AGPL | `apps/proxy/src/router.ts`, `landing.test.ts` |
| `SECURITY.md`: the sentence "Код проекта открыт, … денег проект не зарабатывает" contradicted the commercial licence; it now says there is no bug bounty, the code is open under the AGPL and a commercial licence exists | `SECURITY.md` → «Награды нет» |
| Living docs reworded to the new terms: brand facts, store listing (ru, en), vision Q2, open questions Q2, project overview, UX foundation, `docs/README.md`, `docs/licences.md`, `CHANGELOG.md` | those files; dated records untouched |
| `README.md` `## License` in the knowledge-base wording; MCP line says none is planned yet; `AGENTS.md` in the template's shape with the org-index link | root |

## Checks run (exit codes read directly)

| Check | Result |
|---|---|
| `pnpm gates` (lint, typecheck, build, test, ux:lint, brand:lint, i18n:sweep, package:check) | 0 — 174 test files, 2653 tests passed, 1 skipped |
| first run of `pnpm gates` | 1 — `tools/adr.test.ts` needs the headings `## Цена` and `## Чем держится`; ADR-0016 now uses this repository's headings |
| org-index `check_format.py --offline --repo okolos` | 6 findings before → 0 after |
| org-index `check_names.py --offline` | 0 findings |

Planted defects, each watched failing and then reverted (control: 29 of 29 pass):

1. one clause of `LICENSE` edited → "ships the AGPL text and the commercial offer" fails;
2. "Source-available under PolyForm." appended to the store listing → "never presents the old terms…" fails;
3. "This is not open source." appended to `SECURITY.md` → the same test fails;
4. `packages/ui/package.json` back to PolyForm → "declares the expression in every manifest" fails;
5. the landing `license` URL back to PolyForm → the landing test and the surfaces test fail;
6. the PolyForm history removed from `LICENSING.md` → "keeps the history" fails.

## Finished 2026-10-01 — rebase and the red check

- **Rebased** onto `origin/main` at `0557023`, over #4 (private data removed from the tree) and #5;
  no conflict. Two commits landed under PolyForm after `a43ef65`, so the last PolyForm commit named
  in `LICENSING.md`, `README.md`, ADR-0016 and `tools/licensing.test.ts` moved to `0557023`.
- **The one red check, `e2e (chromium)`, was not this change:** `e2e/budget.spec.ts` asserted a
  20 ms wall-clock ceiling and read 30.6 ms on the runner (run `36765955109`). It was backlog
  B-124 and had failed on `main` before; fixed on its own in #5 (the test now holds the node
  budget and the 500 ms hang guard; the planted `maxNodes: 100` is caught).
- org-index `check_format.py --offline --repo okolos` → only F12 (agent-sync, installed by a
  separate change); `check_private.py` → the same seven findings `main` already has, none added.

## Open

- The org-index row for Okolos still says "Source-available under the organisation's PolyForm
  terms (okolos ADR-0015)"; org-index was out of scope for this run. It needs its `role` updated
  to the AGPL-or-commercial wording and ADR-0016.
- The store listing is not published; when it is, its licence sentence is the one in
  `docs/store/listing.md`.

## Next task

Unchanged from the [2026-09-29 handoff](2026-09-29-org-move-and-ecosystem-strategy.md).
