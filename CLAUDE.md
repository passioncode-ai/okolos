@AGENTS.md

# Okolos

Браузерное расширение для безопасности в эпоху AI-агентов. Документация —
в [docs/README.md](docs/README.md); вижен — [docs/product-vision.md](docs/product-vision.md).

## Текст, который увидит пользователь — через бренд-пак

- `docs/brand/` — источник для всех строк интерфейса, текстов магазина, писем и
  публичных страниц: [voice.md](docs/brand/voice.md) (голос и пять правил),
  [terminology.md](docs/brand/terminology.md) (одно понятие — один термин на
  каждом языке), [facts.md](docs/brand/facts.md) (что можно утверждать, и чем
  это проверяется).
- **Термин из `terminology.md` обязателен**: если понятие там есть, в коде и в
  тексте стоит именно оно. Разошлось — верен бренд-пак, а строку чинят.
- **Число из `facts.md` берётся командой в момент правки**, а не переносится из
  прошлой версии. Это держит `tools/docs.test.ts`: пакеты, приложения, спеки,
  срок хранения, назначения сети и разрешения манифеста сверяются с деревом.
- Граница: коммиты, комментарии в коде и внутренние доки — мимо бренд-пака.

## UX scenarios — hard rule (super-ux)

- `docs/ux/scenarios.md` is the source of truth for all user-facing
  behavior; `docs/ux/foundation.md` (personas, JTBD, journeys, stories) and
  `docs/ux/flows.md` (user flows) are the WHY and HOW layers scenarios
  trace to.
- Any change that touches user-facing behavior or interface MUST update, in
  the same change: `docs/ux/scenarios.md`; affected flows; the affected
  screens in `docs/ux/screens.md` (the UI map — states, elements,
  coverage); and, when Figma is enabled, the Figma frame(s) plus their
  links in `screens.md`. A screen whose code diverges from its record, or a
  stale Figma link, is drift — the exact thing this system prevents.
- Any new feature or project STARTS with the chain: which job does it
  serve, which journey stage, which story — then flows and scenarios,
  validated against the existing base, approved.
- **Do NOT write interface code until the UX workflow is done first:** the
  foundation → flows → screens → scenarios chain is designed and approved,
  and — when Figma is enabled (default) — the UI is mocked up in Figma with
  every screen linked to its frame. Building UI before this is the exact
  mistake super-ux exists to prevent.
- Visual identity is ONE locked style pack, recorded in `docs/ux/screens.md`
  → Design system and obeyed by every Figma frame and every built screen —
  picked with the **sheleg-design** companion skill when the project has no
  design system of its own (recommended, not required). Inventing a palette,
  type pairing, or motion per screen is visual drift.
- After any UX change and before calling the work done, run the linter
  `python3 docs/ux/lint.py` — it must pass (errors are drift/broken
  structure; wire it into CI/pre-commit).
- Use `/ux` as the entry point; skills: `ux-foundation`, `ux-flows`
  (flows + Figma mockups), `ux-scenarios` for maintenance, `ux-audit` for
  evidence-backed verification. Full map: the plugin's system-map reference.
