# docs/ux — UX chain (super-ux, ux-contract v4)

Chain: **Personas → Jobs (JTBD) → Journeys → Stories → Flows → Screens →
Scenarios → Audits → Plans.** Every layer traces to the one above it.

| File | Layer | Content |
|---|---|---|
| [foundation.md](foundation.md) | WHY | personas, jobs, journeys, user stories, design tooling, product mechanics |
| [flows.md](flows.md) | HOW | user flows (mermaid), task analysis, screens traversed |
| [screens.md](screens.md) | UI MAP | every screen and state: elements, Figma frames, coverage, resources |
| [scenarios.md](scenarios.md) | WHAT | use-case scenarios — source of truth for user-facing behavior |
| [audits/](audits/) | EVIDENCE | one report per audit run |
| [plans/](plans/) | ACTION | UX fix plans (target UI + CREATE/MODIFY/DELETE) |

Product context lives one level up: [../product-vision.md](../product-vision.md),
[../coverage-matrix.md](../coverage-matrix.md), [../evidence/](../evidence/).

**Before calling any UX work done:**

```bash
pnpm ux:lint
```

It runs `docs/ux/lint.py` through `tools/python.mjs`, which finds Python 3 under
`python3`, `python` or `py -3`, so the same command works on Windows.

Entry point for all UX work: `/ux`.
