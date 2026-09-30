# ADR-0016. Okolos returns to the AGPL, with a commercial licence

**Дата:** 2026-09-30
**Статус:** accepted — it carries out the organisation's decision of 2026-09-30, Fabric
[ADR-0092](https://github.com/passioncode-ai/fabric/blob/main/docs/adr/0092-every-repository-is-agpl-3-0-or-commercial.md)
("every repository is AGPL-3.0 or commercial"), for this repository.
**Заменяет:** [ADR-0015](0015-okolos-takes-the-organisations-licence.md) (PolyForm
Noncommercial or Internal Use).

## Контекст

ADR-0015 put Okolos under the organisation's terms of 2026-09-29, PolyForm Noncommercial or
Internal Use, because every public PassionCode.ai tool used them. On 2026-09-30 the organisation
changed those terms for every repository: open source under `AGPL-3.0-only`, or a commercial
licence from PassionCode.ai — `AGPL-3.0-only OR LicenseRef-PassionCode-Commercial`
(fabric-workspace `knowledge/licensing.md`). ADR-0015's own premise — "the same terms as every
public PassionCode.ai tool" — now points at the new terms.

The licence can change without anyone else's consent for the reason ADR-0014 recorded: the code
has no author other than the maintainer, and contributions come in under [CLA.md](../../CLA.md),
which allows sublicensing under any terms.

## Решение

**The whole repository is under `AGPL-3.0-only OR LicenseRef-PassionCode-Commercial`.**
`LICENSE` is the unmodified AGPL-3.0 text (the knowledge-base template, SHA-256
`0d96a4ff68ad6d4b6f1f30f713b18d5184912ba8dd389f86aa7710db079abcb0`),
[COMMERCIAL-LICENSE.md](../../COMMERCIAL-LICENSE.md) is the commercial offer, and every
`package.json` carries the expression.

- **History is kept.** Commits up to and including `5a8e490` stay under AGPL-3.0-only (Apache-2.0
  for the engine and `corpora/` in the last of them); commits after it up to and including
  `a43ef65` stay under PolyForm Noncommercial or Internal Use. [LICENSING.md](../../LICENSING.md)
  says so.
- **Third-party material keeps its own terms**, unchanged from ADR-0015: the Public Suffix List
  selection under MPL-2.0 (`packages/core-lookalike` declares
  `(AGPL-3.0-only OR LicenseRef-PassionCode-Commercial) AND MPL-2.0`), OpenPhish data under its
  source's terms, HIBP data under CC BY 4.0 with on-screen credit.
- **Dependencies stay permissive.** A permissive licence is compatible with the AGPL; a
  copyleft dependency under different terms could make the combined work undistributable.

## Цена

- The AGPL allows anyone to sell or host a product built on the code, provided they publish
  their changes under the AGPL. The goal ADR-0015 served — commercial use is agreed first — now
  holds only for use outside the AGPL's terms (a closed-source product, a modified hosted service
  without its source). That is the organisation's choice in ADR-0092, not a side effect.
- The words change on every surface: Okolos may now be called open source, and "source-available"
  or PolyForm must not be presented as its current terms.

## Чем держится

| Part | Mechanism |
|---|---|
| `LICENSE` is the AGPL text byte for byte; `COMMERCIAL-LICENSE.md` names the expression and the address | `tools/licensing.test.ts` — "ships the AGPL text and the commercial offer" |
| Every `package.json` carries the expression | `tools/licensing.test.ts` — "declares the expression in every manifest" |
| No surface presents PolyForm or "source-available" as the current terms | `tools/licensing.test.ts` — "never presents the old terms as current…" |
| Dependencies are permissive | `tools/licensing.test.ts` — "every shipped dependency carries a permissive licence" |
| The Worker's landing page names the same terms | `apps/proxy/src/landing.test.ts` |
| The organisation's standard (LICENSE, COMMERCIAL-LICENSE.md, CLA.md, SECURITY.md, manifests) | org-index `scripts/check_format.py` |
