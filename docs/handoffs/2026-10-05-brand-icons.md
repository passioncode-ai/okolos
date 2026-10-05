# Brand icons handoff (2026-10-05)

## Objective

Move the Okolos mark onto the PassionCode.ai product tile, the same tile Switchboard, Fabric
Dashboards, Fabric Inbox and Observatory use on passioncode.ai: a gold glyph `#ffd21a` on the dark
tile `#0a070d`, viewBox 256, tile 8..248, corner radius 58, 2-unit hairline `#342b3a`. Draw it
from the generator, as [ADR-0007](../adr/0007-generate-what-would-drift.md) requires, and make
the generator able to draw Okolos Bridge too.

## Completed

- `tools/icons.mjs` describes the mark once, in `GEOMETRY`: a closed ring and a dot, for two
  variants (`okolos`, `bridge`) at four sizes. 128 is the master and the SVG is written from it.
  At 16, 32 and 48 the ring is heavier and its edges sit on whole pixels. Bridge has the same
  ring and dot, moved up and left, plus a short bar at the lower right. A second dot was not
  used, because ring + dot + satellite dot is Observatory's mark.
- Outputs: `apps/extension/icons/{16,32,48,128}.png`, `docs/brand/marks/okolos-mark.svg`,
  `docs/brand/marks/okolos-bridge-mark.svg`, `docs/brand/marks/okolos-bridge-{16,32,48,128}.png`
  and `docs/brand/marks/okolos-promo-440x280.png` (Chrome Web Store small promo tile, with no
  wordmark).
- `tools/icons.test.ts` checks:
  - every brand file equals what the generator draws;
  - the ring centre line is gold at all 360 degrees for both variants at every size;
  - the space between ring and dot stays dark;
  - the dot exists;
  - the contrast rule, with its numbers updated.

  A planted gap was caught by 13 tests.
- Docs updated: `docs/brand/facts.md` (Знак), ADR-0007 (the table, plus an amendment),
  `docs/runbooks/development.md`, `docs/ux/screens.md` and `CHANGELOG.md`.

## Open

- **The Okolos mark and the Observatory mark are close relatives.** Both are a gold ring around a
  dot. Okolos is centred and has a larger dot. Observatory is off-centre and has a satellite.
  Whether two products may share the ring is a brand decision for the operator.
- **Okolos Bridge has no app yet.** Its ADR ("agents get their own extension") is on the unmerged
  branch `docs/agent-browser-bridge`, and it says only "a new app beside `apps/extension`". The
  Bridge PNGs are therefore in `docs/brand/marks/`. When the app exists, add its icon directory
  to `outputs()` in `tools/icons.mjs` and its manifest check to the Bridge ADR's table.
- **The promo tile has no wordmark.** The generator has no font. Adding a name to the tile needs
  an outlined wordmark SVG in the brand typeface.
- passioncode.ai can reuse `docs/brand/marks/okolos-mark.svg` as `assets/okolos-mark.svg`. That
  belongs to the site's repository, under its own rules.

## Checks run

`node tools/icons.mjs`; `pnpm gates`. The exit codes are in the PR description.

## Next task

Review and merge the PR. Then the operator decides on the Observatory resemblance.
