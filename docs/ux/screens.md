<!-- Managed with super-ux (ux-contract v4). The design map: every screen and state with its Figma frame, wireframe, code coverage, and resources. Update in the same change as any interface change; when Figma is enabled, update the frame too. -->

# Screens — UI map

Figma is disabled by the 2026-08-04 decision (see
[foundation.md](foundation.md) → Design tooling), so the `Figma frame` column
holds `-` throughout and every wireframe in `wireframes/` is **generated from
the renderers** by `tools/wireframes.mjs` and held current by
`tools/wireframes.test.ts` — a screen that gains a control fails the build until
its wireframe is regenerated. That inverts the usual order: here the record of
intent is this file, and the wireframe is derived evidence rather than a mockup
drawn ahead of the code.

**All eighteen screens are `built`.** SCR-15, the dashboard overview, was
specified in [plans/2026-08-12-options-dashboard.md](plans/2026-08-12-options-dashboard.md)
and shipped in the same pass. (The paragraph here previously said most screens were
`designed` and exactly two were `built`; it was written before the build and
never updated, which is the same drift this file exists to catch.)

## Index

| ID | Screen | Used by | Figma | Status | Coverage |
|----|--------|---------|-------|--------|----------|
| SCR-01 | First-run check | FLW-01, FLW-14 | - | built | packages/ui/src/first-run/screen.ts:renderFirstRun |
| SCR-02 | Popup | FLW-17, FLW-11, FLW-13 | - | built | e2e/scn-020.spec.ts |
| SCR-03 | In-page warning banner | FLW-02, FLW-05, FLW-06, FLW-07, FLW-08, FLW-09, FLW-10 | - | built | packages/ui/src/banner/banner.ts:mountBanner |
| SCR-04 | Finding inspector | FLW-02, FLW-03 | - | built | packages/ui/src/inspector/inspector.ts:mountInspector |
| SCR-05 | Block interstitial | FLW-04 | - | built | e2e/scn-007.spec.ts |
| SCR-06 | Agent action gate | FLW-03 | - | built | e2e/scn-010.spec.ts |
| SCR-07 | Findings queue | FLW-01, FLW-17 | - | built | e2e/scn-020.spec.ts, e2e/scn-002.spec.ts |
| SCR-08 | Leaks and repair | FLW-10, FLW-11, FLW-16 | - | built | e2e/scn-015.spec.ts |
| SCR-09 | Extensions watch | FLW-12 | - | built | e2e/scn-017.spec.ts |
| SCR-10 | Self-audit | FLW-13, FLW-17 | - | built | packages/ui/src/self-audit/panel.ts:renderSelfAudit |
| SCR-11 | Journal and weekly diff | FLW-17 | - | built | e2e/scn-020.spec.ts |
| SCR-12 | Settings | FLW-05, FLW-14 | - | built | packages/ui/src/settings/data-controls.ts:renderDataControls |
| SCR-13 | Recovery checklist | FLW-06, FLW-07, FLW-16 | - | built | e2e/scn-025.spec.ts |
| SCR-14 | Public domain status | FLW-04, FLW-15 | - | built | apps/proxy/src/router.test.ts |
| SCR-15 | Dashboard overview | FLW-17 | - | built | packages/ui/src/dashboard/overview.ts:renderOverview, e2e/scn-027.spec.ts |
| SCR-16 | Trusted domains | FLW-05, FLW-14 | - | built | packages/ui/src/trusted/trusted.ts:renderTrusted, e2e/scn-024.spec.ts |
| SCR-17 | Product landing page | FLW-18 | - | built | apps/proxy/src/landing.test.ts |
| SCR-18 | Privacy page | FLW-18 | - | built | tools/privacy-page.mjs, tools/docs.test.ts |
| SCR-19 | Lookalike comparison | FLW-05 | - | built | packages/ui/src/comparison/comparison.ts:mountComparison, e2e/scn-006.spec.ts, e2e/a11y-overlays.spec.ts |
| SCR-20 | Local store unavailable | FLW-14 | - | built | packages/ui/src/storage/storage-problem.ts:renderStorageProblem |
| SCR-21 | Message verdict | FLW-19, FLW-20 | - | designed | none — Ф0 |
| SCR-22 | Message alert | FLW-20 | - | designed | none — Ф1 |

## Design system

- **Severity is a pair on every surface, and was not until 2026-08-21.** The claim below —
  colour as the third signal beside a word — held on the extension's own screens and was half
  true on the in-page ones: the banner wrote `Критично` and `Незначительно` in the same ink, so
  the two looked identical on the surface a person meets first (B-116). The panel carries
  `data-severity` now and its own stylesheet pairs the three token colours with it, grouped the
  way `pages.css` groups them. The strip sits inside the panel, against this product's own
  surface, so a host page's palette cannot swallow it — which is why "word only" was not the
  right answer here. Read as computed style by `e2e/a11y-overlays.spec.ts`, the one harness
  that can open the root
- **Style pack:** dense product UI, calm defaults, **no motion at all** — there
  is nothing here for `prefers-reduced-motion` to reduce, which is the strongest
  form of respecting it. Chosen 2026-08-08, after the line above said "not
  chosen yet" through fourteen screens and the first-run screen shipped
  unreadable: three spans with no rule between them render as
  "Local storage**done**ready".
- **Figma library:** none — the layer is CSS over the markup the renderers
  already emit, and not one renderer changed to receive it
- **Tokens in code:** `packages/ui/src/tokens.ts` → generated into
  `apps/extension/src/tokens.generated.css` by `tools/tokens.mjs`. A test
  asserts the generated file matches, that both colour schemes carry the same
  roles, and that **no stylesheet writes a colour or a length of its own**
- **Component source:** none — `data-role` selectors over existing markup
- **One panel per screen, by structure.** Whatever the router mounts is the page's card:
  `#root > *:not([data-role='back'])`. It was a list of fourteen roles, and membership was
  hand-work — measured 2026-08-21 by rendering all nine areas of `options.html`, which
  found the recovery *chooser* drawn with no card at all (its role had never been added),
  five areas returning a role-less wrapper the router then focused so the focus ring framed
  nothing, and one area heading at `h2` where the other eight were `h1`. An allow-list
  fails silent-by-default and the failure lands on whichever screen was built last.
  Enforced by `e2e/panel-shape.spec.ts`, which reads computed style on every surface: one
  panel, padding and border on it, focus on the card, no list markers, exactly one `h1`
- **A failure answers on the page, never in a browser dialog.** Two writes used a modal —
  the generic action wrapper every control on the options page goes through, and the
  extensions area's disable. A dialog blocks the page, cannot be styled so a sentence written
  through the brand pack arrives in a system box, is invisible to the accessibility sweep, and
  reads as *the browser* failing rather than as this product answering. `[data-role=page-failure]`
  is the slot: one slot, prepended by the repaint, replaced rather than appended, `role="alert"`
  because the reader is looking at the control they pressed. Enforced by
  `tools/no-modals.test.ts`
- **Every area fits a 320px window.** An options page opens in whatever window the person has,
  and one that scrolls sideways puts the end of every sentence behind a gesture. Nothing checked
  it: every screenshot and every look was 1280 wide, and this section had no floor. Measured
  2026-08-21 — everything held at 420; at 320 exactly one screen scrolled, and the cause was a
  native `<input type=file>` whose intrinsic 373px does not shrink. `e2e/narrow.spec.ts` holds
  the floor and names the element that breaks it. The **popup** is deliberately outside it: its
  body asks for `--ok-size-popup` and the browser opens a window that size, so measuring it in a
  320px viewport measures a case that does not occur
- **Nothing touches, and the check is about rendering rather than about names.** Three spans in
  a row with nothing between them ("Local storagedoneready") is the defect this stylesheet was
  written for, and it came back three times — the check rows, the dashboard's area rows (B-99),
  the attention band's item rows and the queue's buttons (B-119). Each time a role got no rule;
  each time it was found by looking. `e2e/no-flush-text.spec.ts` measures the thing itself: two
  element siblings carrying text, on one line, with no space between them. A rule about
  rendering cannot be defeated by adding a role, which is how three allow-lists of names failed
- **A row is a row, whatever it is made of.** Two rows in this product are `<button>`s — the
  journal's history line and the popup's "nothing new since…" line — and the stylesheet's
  chip rule gave them a rounded bordered box the width of their text, which reads as a
  disabled text field. The row group now undoes every chip property rather than being
  written as `button[data-role=entry]`, so a row that becomes clickable later needs no new
  rule. Checked by `e2e/panel-shape.spec.ts` on the property that is visible: a row spans
  its panel and a chip does not
- **A list here is a structure, never prose,** so markers are off by default rather than
  suppressed role by role — one of them was only suppressed by accident, a flex `li` having
  no marker box. No opt-in hook ships with the rule: there is no prose list on any of these
  screens, and vocabulary for a state the product cannot reach is what this project's gates
  refuse elsewhere
- **Assets:** `apps/extension/icons`, drawn by `tools/icons.mjs` — the gold shield and dot on the PassionCode.ai product tile; its SVG source is `docs/brand/marks/okolos-mark.svg`

## Web surfaces

- **Web surfaces:** yes

Three screens are public URLs served by the proxy worker: SCR-17 (`/`), SCR-18
(`/privacy`) and SCR-14 (`/status`). Each carries the five-field
`Web surface:` block below.

The answer was recorded 2026-08-12, after the code had already given it: the
landing page was designed for a human and a crawler at once in B-15 and is held
by eleven rules in `apps/proxy/src/landing.test.ts`, four of them verified by
planted defects. Recording it late is the drift this section exists to prevent —
SCR-17 and SCR-18 shipped with no screen entry at all, which the project's own
hard rule forbids.

**The custom domain changes every `Route` below at once.** `canonical` and the
`ld+json` block are derived from `url.origin` in
`apps/proxy/src/router.ts:landingPage`, so they follow the origin by themselves — but two hosts then serve the
same content with self-referencing canonicals. Adding the domain therefore
includes a redirect from `*.workers.dev`, not just a CNAME.

**Cross-screen rules (apply to every screen below):**

- Severity is never conveyed by colour alone — icon plus text carry it (WCAG
  2.2 AA, foundation → Product mechanics).
- Every verdict shows its source: which check fired, which feed or stage, and
  when the data was last updated.
- Every verdict is disputable in one click ("this is wrong"), and the
  disagreement is remembered.
- No counters of "threats blocked", no protection score, no streaks.
- In-page surfaces render inside a closed Shadow DOM so page CSS cannot
  restyle or hide them.

**The three public pages carry the product's own visual layer, and did not until 2026-08-21.**
All of them shipped with no stylesheet at all — Times New Roman, browser bullets, text edge to
edge across a wide window — while their markup, copy and metadata were right. That is exactly
why nothing caught it: every gate here reads structure, and none of them looks. The sheet is
generated from `packages/ui/src/tokens.ts` into `apps/proxy/src/style.generated.ts` and inlined,
because a worker has no CSS build and a hand-copied palette would be the second place a colour
lives. Two deliberate differences from `pages.css`: **lists keep their markers**, since these are
prose rather than the app's structures, and the text has **a measure** — these are documents, not
panels. Held by `apps/proxy/src/style.test.ts`: every page inlines it, the module matches the
generator, and the sheet declares no colour of its own.

## Screens

### SCR-01: First-run check
- **Used by:** FLW-01 (all steps), FLW-14 (post-wipe return)
- **Purpose:** deliver a real, local result within 30 seconds of install — the product's proof of value before any configuration
- **Elements:** one-line statement of what runs locally; per-check progress list (open tabs / installed extensions / password corpus readiness); findings summary; **primary action: "С чего начать"**; secondary "Пока пропустить"; link "Что отправляется" → SCR-10
- **States:**
  | State | Trigger | Figma frame | Behavior |
  |-------|---------|-------------|----------|
  | loading | install completed | - | per-check rows with live progress; no spinner without a label |
  | empty | checks ran, nothing found | - | plain "nothing found" plus the list of what was actually checked |
  | error | a check could not run | - | that row shows the reason and a retry; other checks continue |
  | success | findings exist | - | count by category, primary action into SCR-07 |
- **Wireframe:** wireframes/SCR-01.md
- **Coverage:** packages/ui/src/first-run/screen.ts:renderFirstRun, apps/extension/src/first-run/index.ts
- **Scenarios:** SCN-001, SCN-002
- **Resources:** local corpus loader, extension inventory adapter, tab scanner
- **Status:** built

### SCR-02: Popup
- **Used by:** FLW-17 (entry), FLW-11 and FLW-13 (entry points)
- **Purpose:** the 3-second answer — is this page fine, and is there anything new
- **Elements:** current page verdict with reason; a what-changed count that opens the diff; up to 3 queued actions; footer links to Self-audit, Journal, Settings; **primary action: the top queued item**
- **States:**
  | State | Trigger | Figma frame | Behavior |
  |-------|---------|-------------|----------|
  | loading | popup opened before verdict ready | - | skeleton with "checking this page" |
  | empty | page clean, nothing new | - | "Nothing new since <time>" and the current page verdict |
  | error | local storage unreadable | - | states the failure and offers repair; never silently blank |
  | success | verdict and/or queue present | - | verdict line + up to 3 actions |
- **Behavior notes — the "nothing new since…" line is a row, not a control-shaped box.** It
  is a `<button>` and inherited the chip look until 2026-08-21; the queue rows above it now
  lead with the severity in words and the day, so nothing on this screen carries meaning in
  colour alone
- **Wireframe:** wireframes/SCR-02.md
- **Coverage:** packages/ui/src/popup/popup.ts:renderPopup, apps/extension/src/popup/index.ts, e2e/scn-020.spec.ts
- **Scenarios:** SCN-020, SCN-021
- **Resources:** verdict store, queue selector
- **Status:** built

### SCR-03: In-page warning banner
- **Status note:** built for the injection variant only
- **Used by:** FLW-02, FLW-05, FLW-06, FLW-07, FLW-08, FLW-09, FLW-10
- **Purpose:** speak at the moment of the decision, inside the page, without stealing the page
- **Elements:** severity icon + label; one-sentence plain-language reason; **one primary action per variant**; secondary "Показать" → SCR-04 where applicable; "Это неверно"; dismiss. Variants: `injection`, `lookalike`, `clickfix` (blocking), `techsupport`, `download`, `credential`, `password`
- **States:**
  | State | Trigger | Figma frame | Behavior |
  |-------|---------|-------------|----------|
  | success | a finding is raised | - | banner appears in the corner; blocking variants (clickfix) overlay and require a deliberate dismiss |
  | error | detail view or action failed | - | inline failure text with retry; the warning itself never disappears on error |
  | removed by the page | the page deletes the host from the document | - | put back up to three times, a quarter-second apart; after that the extension's **icon** carries a badge and the journal records the count. The banner is not on the page any more, and the product says so rather than going quiet |
  | more than one kind of finding | a second detector finds something on the same page | - | **one panel, never two.** The worst finding holds it, a tie leaves it where it is, and the rest become a single line naming how many other kinds are here. Two panels at the same `inset` drew one warning on top of another until 2026-08-20 (B-69) |
  | the verdict outlived the page that asked for it | a form navigated away while the leak check was in flight (FLW-10, SCN-036) | - | drawn on the page the login landed on, naming the site the password was sent to — which keeps the sentence true on a page that is not the form. Shown once: the panel confirms it was drawn, and `pagehide` withholds that confirmation when the document is leaving |
  | the finding is in an embedded frame | a frame reports upward — an injection (FLW-02), a login form (FLW-09) or a leak verdict on a password it received (FLW-10) | - | drawn in the **top** frame, never in the frame that found it: a banner inside a 300x200 frame is clipped and inside a hidden ad frame warns nobody. The headline names the frame's origin, and it comes from the sender as the background stamped it. The frame's controls act on the frame's domain — trusting means trusting the site in the frame, and "Сменить пароль" opens that site's change-password page rather than the embedding page's |
- **Behavior notes:** closed Shadow DOM; keyboard reachable; announced to screen readers; never covers a form field it warns about; low-confidence findings never block. **A page can delete this surface and nothing can forbid that** — the DOM belongs to the page — so the answer is bounded (ADR-0001, amended 2026-08-20): a short argument, then a channel the page does not own. A dismissal by the user is not a removal: the watch stops before the product destroys its own banner
- **Behavior notes — severity in a word and a colour, in that order.** The word is the message; the strip on the panel's leading edge is the third signal, from the same three token levels the extension's own screens use. Until 2026-08-21 there was no strip and no colour at all here, so `Критично` and `Незначительно` were indistinguishable at a glance (B-116)
- **Wireframe:** wireframes/SCR-03.md
- **Coverage:** packages/ui/src/banner/banner.ts:mountBanner, e2e/scn-003.spec.ts, e2e/a11y-overlays.spec.ts, e2e/scn-034.spec.ts (the credential variant drawn from a frame's report, asserted through the open shadow root of the hooked build)
- **Scenarios:** SCN-003, SCN-006, SCN-008, SCN-009, SCN-011, SCN-012, SCN-013, SCN-031, SCN-034, SCN-035, SCN-036
- **Resources:** shared banner component, variant copy table, i18n strings
- **Status:** built

### SCR-04: Finding inspector
- **Used by:** FLW-02 (inspect), FLW-03 (from the gate)
- **Purpose:** show the evidence so the user can judge the verdict instead of trusting it
- **Elements:** the concealed text verbatim; concealment technique; DOM location; which stage fired and its confidence; neutralised/restored toggle; "Это неверно"; **primary action: "Оставить обезвреженным"**; `[data-role=restore-note]` — what a restore could not put back, shown above the buttons when it could not finish
- **States:**
  | State | Trigger | Figma frame | Behavior |
  |-------|---------|-------------|----------|
  | ~~loading~~ | — | - | **removed 2026-08-20.** The inspector is mounted with the verdict's evidence already in hand, so opening details waits on nothing: there is no state to build and a skeleton would be a wait the product does not have. The row described an architecture this product never had (B-59) |
  | success | evidence available | - | text + technique + location + stage |
  | error | evidence lost (page mutated) | - | says the page changed, offers a re-scan |
  | refused | restore pressed on a node the page has taken over | - | the panel stays and `[data-role=restore-note]` names which of the two happened; **every further press repeats the same sentence.** Until 2026-08-20 the second press answered "nothing to do" and the panel closed as after a success, because the executor dropped its holds whatever the outcome |
- **Wireframe:** wireframes/SCR-04.md
- **Coverage:** packages/ui/src/inspector/inspector.ts:mountInspector, e2e/scn-004-click.spec.ts, e2e/a11y-overlays.spec.ts (restore lands with the sanitizer, M5)
- **Scenarios:** SCN-004, SCN-005
- **Resources:** evidence store, DOM locator renderer
- **Status:** built

### SCR-05: Block interstitial
- **Used by:** FLW-04
- **Purpose:** replace a known-malicious page and make the override honest
- **Elements:** what was blocked; the verdict's source (feed name, entry date), which fills in on a retry if the background was not ready; **primary action: "Назад"**; secondary "Всё равно продолжить" (deliberate, states that the exception is remembered and journalled); "Это мой сайт" → SCR-14, **with the blocked domain already in the link** so the owner does not retype what they were just shown; only the host travels, never the blocked URL's path or query
- **States:**
  | State | Trigger | Figma frame | Behavior |
  |-------|---------|-------------|----------|
  | success | feed match | - | full-page interstitial replacing the site |
  | error | feed metadata unavailable | - | still blocks, states the source is unknown and how to check |
  | embedded by another page | any site puts `interstitial.html` in an iframe — it is the one web-accessible file the extension has, because the blocker redirects a tab to it | - | **refuses to render**: one sentence saying this is our page and the site around it embedded it, and no controls at all. A framed copy would offer a real "Всё равно продолжить", and that control records an exception for the last blocked address — so a click stolen by an overlay would switch off a block the product had made (SCN-037) |
- **Behavior notes:** the page asks the background what was blocked rather than reading its own query string, so it cannot be made to *name* an arbitrary site; the framing refusal is about the **click**, not the text
- **Wireframe:** wireframes/SCR-05.md
- **Coverage:** packages/ui/src/interstitial/interstitial.ts:renderInterstitial, apps/extension/src/interstitial/appeal-link.ts:appealLinkFor, apps/extension/src/interstitial/framed.ts:isFramed, e2e/scn-007.spec.ts, e2e/scn-037.spec.ts
- **Scenarios:** SCN-007, SCN-037
- **Resources:** feed metadata store, exception store
- **Status:** built

### SCR-06: Agent action gate
- **Used by:** FLW-03
- **Purpose:** put a human decision between a poisoned page and a sensitive action
- **Elements:** the action being attempted; the unresolved finding in one line; **primary action: "Заблокировать"**; secondary "Разрешить один раз"; "Показать инструкцию" → SCR-04; timeout notice
- **States:**
  | State | Trigger | Figma frame | Behavior |
  |-------|---------|-------------|----------|
  | success | sensitive action on a page with an unresolved finding | - | modal, blocking, default is Block |
  | error | the action context cannot be identified | - | blocks and says what could not be determined |
- **Behavior notes — the evidence line is the reader's language around the attacker's words.** It was an English template literal until 2026-08-21: the whole panel was Russian around one English sentence, on the surface a person meets mid-decision, in a product whose `default_locale` is `ru`. Found by rendering the gate and looking at it — the i18n sweep had called that file clean, because its anchor could not carry a sentence in backticks with a nested double quote (B-114). The snippet inside the quotes stays untranslated on purpose: it is the attacker's own text, and a reader checking the page has to find the same characters
- **Behavior notes:** timing out defaults to Block, never to Allow; Block holds focus so a stray Enter blocks; Escape blocks; "Show the injection" leaves the gate standing behind the evidence. **What never reaches this screen:** an action with no form and no navigation behind it — a scripted click on a bare button firing `fetch` — is not held, so the gate never appears for it. **What now does reach it:** a trusted click in a browser that reports it is being driven — until 2026-08-08 automation input passed as a human gesture, because it arrives trusted. SCN-010 carries both, with the measurement
- **Behavior notes — it holds focus, and that was a promise before it was true.** The dialog's own header has said "it holds focus so a stray Enter blocks" since it was written; until 2026-08-21 three presses of Tab walked out of it and onto the page beneath — the form the gate is holding — and Escape then stopped working, because the handler is on the panel. Tab and Shift+Tab now cycle the three controls and Escape blocks from any of them. **Not a bypass, measured:** pressing the page's own submit again is caught and held again — and that measurement is where B-123 came from, because what "again" did was mount a second panel. Nine axe checks over this surface said nothing about it, because focus containment is not an axe rule (B-122)
- **Behavior notes — one panel, and the slot is claimed rather than stacked (fixed 2026-08-21).** A second action intercepted while this screen stands used to open a **second** copy of it in the same coordinates (`gates=2` measured, from the B-122 keyboard walk): the handle to the first was overwritten, so the first host stayed in the page after the visible one closed, and either button answered a question the panel underneath had asked about a different action. There is no second panel now — while one question is open the next action is blocked outright, and the journal line says a question was already open rather than blaming the reader for a decision they were never shown. This screen therefore has no "two pending actions" state by design; the reader answers what is in front of them, and the refused action can be retried afterwards (B-123)
- **Wireframe:** wireframes/SCR-06.md
- **Coverage:** packages/ui/src/gate/gate.ts:mountGate, e2e/scn-010.spec.ts, e2e/a11y-overlays.spec.ts
- **Scenarios:** SCN-010
- **Resources:** action interceptor, finding store
- **Status:** built

### SCR-07: Findings queue
- **Used by:** FLW-01, FLW-17
- **Purpose:** turn everything found into at most three next actions
- **Elements:** up to 3 prioritised items, each leading with **how serious in words and when it happened** (`[data-role=severity]`, `[data-role=when]`), then what happened, why it matters, and one executable action; "show all" (collapsed by default); per-item "Готово" and "Не сейчас"
- **States:**
  | State | Trigger | Figma frame | Behavior |
  |-------|---------|-------------|----------|
  | loading | opening after a scan | - | skeleton rows |
  | empty | nothing outstanding | - | "Nothing needs you right now" plus when it was last checked |
  | error | queue store unreadable | - | states the failure, offers repair |
  | success | items exist | - | max 3 shown; the rest behind "show all" |
- **Behavior notes:** the queue never exceeds three visible items — this is the anti-pattern this product exists to avoid (203 alerts, nothing done)
- **Behavior notes — severity is never colour alone, and a row says when.** Until 2026-08-21 a row was a sentence and three buttons: severity lived in a three-pixel coloured strip and nowhere else, which is WCAG 1.4.1 and invisible to the axe sweep — nothing tells a scanner that a border means anything — and the time, the first fact that decides whether a finding still matters, was not on the screen at all. The strip stays as the third signal. The words come from `SEVERITY_WORD_KEY`, the one table the banner and the dashboard also read (there were two, and this screen was one edit from being the third), and the day comes from `when.ts`, the same rendering as the dashboard band that shows these very rows
- **Wireframe:** wireframes/SCR-07.md
- **Coverage:** packages/core-queue/src/rank.ts:buildQueue, packages/ui/src/queue/queue.ts:renderQueue, e2e/scn-020.spec.ts
- **Scenarios:** SCN-002, SCN-022
- **Resources:** priority scorer, action registry
- **Status:** built

### SCR-08: Leaks and repair
- **Used by:** FLW-10 (reuse list), FLW-11, FLW-16
- **Purpose:** what of mine is exposed, and the repair for each
- **Elements:** monitored sources (email, phone) with add/remove; results split into "Недавнее — устройство было заражено" and "Более старые утечки"; per-entry data classes, date, source; **primary action per entry: "Сменить пароль"**; "Отметить решённым"; archive; manual password check field; the list of sources actually checked and when
- **States:**
  | State | Trigger | Figma frame | Behavior |
  |-------|---------|-------------|----------|
  | loading | check running | - | per-source progress, partial results shown as they arrive |
  | empty | no sources monitored | - | prompt to add an email or phone, naming what is sent — the address itself, not a hash |
  | refused | Check now pressed with no usable address | - | states why nothing was sent (`[data-role=needs]`) and keeps the control, so the press is never silent |
  | error | a source failed | - | that row states unavailable + retry; other results stand |
  | success | results present | - | freshest first, historical collapsed |
- **Behavior notes:** the idle state names what is sent, and it is **the address itself** — Hudson Rock's Cavalier and HIBP's breached-account endpoint answer to nothing less, so a screen implying a hashed lookup would be a false privacy claim on the surface where the user decides. The password check is the k-anonymous one and is kept distinct in the copy. The network choke point permits the address only because the request declares `carries: 'address'`, and the self-audit journal records that it left.
- **Behavior notes:** the reuse answer is **on the password warning, not behind a control**. Between 2026-08-08 and 2026-08-09 there was no answer at all: a "Check reuse" control opened `options.html#reuse=`, a hash nothing read, and the index it implied was never built. A panel answering "no reuse found" from a store that does not exist tells the safest possible lie, so the control was removed rather than left lying. The index exists now (`reuse` store, DB v4) and the warning says one of three things — the other sites, "not seen on any other site on this device", or "unknown: this device has not seen it before". The third is the one the old control could not say, and it is what a fresh install has to say
- **Behavior notes (address field):** the field is moved between repaints, never rebuilt, and **its focus and caret are carried with it**. Moving a node keeps its value; removing it from the document blurs it, and native typing needs a focused element to land in — so an address typed while the page was still settling went nowhere. That was the four-day flake tracked as #29: `apps/extension/src/options/keep-focus.ts` carries the rule
- **Wireframe:** wireframes/SCR-08.md
- **Coverage:** packages/ui/src/leaks/leaks.ts:renderLeaks, packages/core-leaks/src/group.ts:groupLeaks, packages/core-leaks/src/merge.ts:mergeLeaks, e2e/scn-015.spec.ts
- **Scenarios:** SCN-014, SCN-015, SCN-016
- **Resources:** source adapters (HIBP, XposedOrNot, Hudson Rock), local hash store, **reuse index** — `reuse` store keyed by [tag, host], tag = HMAC-SHA-256 over the leak-check digest under a device-local random key ([privacy](../privacy.md))
- **Status:** built

### SCR-09: Extensions watch
- **Used by:** FLW-12
- **Purpose:** the inventory plus what changed in it — the delta is the product, not the list
- **Elements:** installed extensions with risk level and last change; deltas highlighted at the top (permissions added, publisher changed, silent update); per-item detail with static findings (obfuscation, `eval`, remote code, endpoints, **powers over the browser** — `chrome.debugger`, a native host, traffic rewriting — and bulk reads of history, bookmarks or identity); **primary action: "Отключить"**; "Это изменение нормально"; "Разобрать пакет"
- **States:**
  | State | Trigger | Figma frame | Behavior |
  |-------|---------|-------------|----------|
  | loading | inventory or package analysis running | - | list renders first, analysis fills in |
  | empty | no extensions installed | - | plain statement, no filler. **Built 2026-08-20:** the list rendered its heading with no rows under "nothing has changed since the last check" — two true sentences that together read as "we looked and there is nothing to say", when the fact is that there is nothing to look at (B-59) |
  | error | package could not be fetched | - | permission delta still shown; analysis marked unavailable |
  | success | inventory with deltas | - | deltas first, then the rest by risk |
- **Behavior notes — a disable that is refused says so on the page.** Policy-installed
  extensions cannot be disabled, and the browser's answer used to arrive in a modal. It is the
  page's failure slot now, above the area, in the product's own words
- **Behavior notes — the actions follow the change.** Each delta shows only what can be done about *it*: an extension that is **no longer installed** offers "Это изменение нормально" and nothing else, because there is nothing left to disable and no package left to read. Until 2026-08-21 all five kinds got the same two buttons, so pressing "Отключить его" on a removed extension sent `extensions/disable` for an id the browser does not have and answered a person's remedy with an error. The mapping is a `Record` over the change union (`CHANGE_ACTIONS` in `extensions.ts`), so a sixth kind fails the build until someone decides what a person can do about it — verified by planting one
- **Wireframe:** wireframes/SCR-09.md
- **Coverage:** packages/ui/src/extensions/extensions.ts:renderExtensions, packages/core-extensions/src/diff.ts:diffInventory, e2e/scn-017.spec.ts
- **Scenarios:** SCN-017, SCN-018
- **Resources:** management adapter, snapshot store, CRX static analyser
- **Status:** built

### SCR-10: Self-audit
- **Used by:** FLW-13, FLW-17
- **Purpose:** make "we don't collect your browsing" verifiable rather than promised
- **Elements:** outbound request log — each row labelled (`когда/куда/зачем/что ушло/источник`) and **openable**, with what that purpose sends and what it holds back plus the outcome in words; a two-position period control (the last seven days / everything kept); **primary action: "Выгрузить журнал"**; a one-line summary that names what left as well as what did not
- **States:**
  | State | Trigger | Figma frame | Behavior |
  |-------|---------|-------------|----------|
  | loading | opening the log | - | skeleton rows |
  | empty | nothing sent yet | - | "Nothing has been sent from this device" |
  | error | journal unreadable | - | states the problem and offers repair; never shows an empty list on error |
  | success | entries exist | - | newest first, grouped by purpose |
- **Behavior notes:** this log is written by the single network choke point before each request; if a request could bypass it, the guarantee is void — enforced by lint and test, not by convention
- **Behavior notes — what the summary may claim.** The one-line summary names no absence it cannot prove. Until 2026-08-21 it ended "no page address, **email** or page content" unconditionally, while [facts.md](../brand/facts.md) says in its own table that `leak-lookup` sends the email address and `domain-status` sends the domain: a list containing such a request, under a sentence denying it exists. The unconditional half is now only what the choke point keeps — no page address, no page content — and what did leave is named per purpose. A purpose this build cannot read drops the absence claim entirely and says why
- **Behavior notes — the window is applied, not just worded.** The panel receives the boundary as an instant (`windowStartIso`) and filters on it; retention is ninety days, and it used to be handed all of them under the words "the last seven". A row whose time is unreadable is kept, because understating what left is this screen's dangerous direction
- **Behavior notes — a row the store wrote incompletely.** Rows are read straight out of IndexedDB, where the type is a promise and an older build's row is not bound by it. Each missing field names itself ("куда — не записано"), the row is never hidden, and an outcome nobody recorded is counted in its own clause rather than dropped from the total
- **Behavior notes — every line says which field it is, and the instant keeps its seconds.**
  A row was five bare lines — an instant, a host, a purpose, a shape, a source — so a reader
  had to know the order to know what they were reading, and a row missing two fields read as
  the same shape with parts silently absent. Each line is labelled now, from the same words
  the missing case uses: "куда: не записано" and "куда: api.pwnedpasswords.com" are one
  sentence with different news in it. This screen is the one place that renders the second
  (`exactInstant`, not `shortTime`), because its purpose is being lined up against a
  browser's own network panel and the second is what makes two records comparable
- **Two promises dropped on purpose, with the reasons (B-101).** The record asked for four
  elements that did not exist; two are built and two are not going to be. **"The exact bytes
  sent" is not stored and must not be:** a leak lookup writes `email:s***@example.test`,
  redacted where it is written, because this log is exportable and wipeable and a log full of
  plaintext addresses would be a secret store of its own — so the row's detail names what left
  for that purpose and what was held back, which is the question a reader has and a stronger
  answer than a byte dump. **A filter by feature** over six purposes at a handful of rows a
  day is a control that costs a line and answers nothing. **Grouping by purpose** contradicts
  the newest-first order this screen's own scenario promises in step 1; with a seven-day
  window the flat list is short enough that grouping only adds nesting
- **Wireframe:** wireframes/SCR-10.md
- **Coverage:** packages/ui/src/self-audit/panel.ts:renderSelfAudit, apps/extension/src/options/index.ts, packages/ui/src/self-audit/panel.test.ts (32 checks), e2e/scn-019.spec.ts (four, including opening a row and widening the period), e2e/rendered-instants.spec.ts (nine areas, seeded stores, one row written the way an older build leaves it)
- **Scenarios:** SCN-019
- **Resources:** net layer journal, exporter
- **Status:** built

### SCR-11: Journal and weekly diff
- **Used by:** FLW-17
- **Purpose:** what changed since last time — not an ever-growing red list
- **Elements:** a default view scoped to what changed since the last check; grouped by type; each entry with verdict, action taken, and whether it was automatic; toggle to full history; retention statement
- **States:**
  | State | Trigger | Figma frame | Behavior |
  |-------|---------|-------------|----------|
  | empty | nothing changed | - | "Nothing changed since <time>" |
  | success | changes exist | - | grouped diff, newest first |
- **Behavior notes — a failure's own words sit under the sentence, never inside it.** Two writers interpolated `String(cause)` into a catalogue sentence, so a reader got a Russian line with an English exception in the middle. The entry carries a `diagnostic` beside its explanation now, and the row draws it as a muted second line in a monospace face — last, the way SCR-20 shows the storage detail, because it is what a bug report needs and not what a reader should meet first (B-115)
- **Behavior notes — the history line is a row.** It is a `<button>`, and until 2026-08-21 it
  inherited the chip look: a bordered box the width of its text, reading as a disabled input.
  The instant it carries is to the minute (`shortTime`), not the second — "nothing new since
  2026-08-21 01:36:17 UTC" was precision nobody asked for in a sentence about whether
  anything happened
- **Wireframe:** wireframes/SCR-11.md
- **Coverage:** packages/core-queue/src/diff.ts:diffSince, packages/ui/src/journal/journal.ts:renderJournal, e2e/scn-020.spec.ts
- **Scenarios:** SCN-021
- **Resources:** event journal, diff selector
- **Status:** built

### SCR-12: Settings
- **Used by:** FLW-05 (watchlist edit), FLW-14
- **Purpose:** the few switches that change behaviour, plus data ownership
- **Elements:** brand watchlist (add/edit/remove); quiet mode toggle; proxy on/off with a plain explanation of what each option reveals and to whom; retention period; **primary action: "Выгрузить все данные"**; "Удалить все данные" (разрушительное, подтверждается списком того, что удаляется — **по одному виду на каждое хранилище, девять**; список приходит из схемы, а не пишется рядом с ней, и рендерер отказывается рисовать подтверждение, которое не называет ничего). **The trusted domains list moved to SCR-16** on 2026-08-12: the dashboard lists one area per view, the overview names "Доверенные домены" and "Ваши данные" separately, and reviewing what you trusted is a different job from exporting and wiping
- **States:**
  | State | Trigger | Figma frame | Behavior |
  |-------|---------|-------------|----------|
  | success | default | - | grouped settings |
  | error | export or wipe failed | - | inline failure with retry; state left unchanged |
- **Wireframe:** wireframes/SCR-12.md
- **Coverage:** packages/ui/src/settings/data-controls.ts:renderDataControls, e2e/scn-024.spec.ts (data controls built; watchlist, quiet mode and the proxy toggle land with their modules)
- **Scenarios:** SCN-023, SCN-024
- **Resources:** settings store, exporter, wipe routine
- **Status:** built

### SCR-13: Recovery checklist
- **Used by:** FLW-06, FLW-07, FLW-16
- **Purpose:** turn "I already did the bad thing" into an ordered, finishable list
- **Elements:** incident type picker (ran a pasted command / entered a password / called a number or gave screen access / not sure); ordered steps, most damaging first, each with why; per-step done state; "Продолжить на другом устройстве" instructions; **primary action: the current step**
- **States:**
  | State | Trigger | Figma frame | Behavior |
  |-------|---------|-------------|----------|
  | loading | building the checklist | - | brief; steps are local |
  | empty | no incident selected | - | the picker, nothing else. **Built 2026-08-20:** every checklist opened because a detector fired, so someone who ran the pasted command and realised afterwards had no way in — `#recovery` with no kind opened the overview and reported itself unrecognised (B-59) |
  | success | checklist active | - | one current step highlighted, rest visible |
  | success (broad) | the incident name is not one we have a playbook for — including an address this product never produces | - | the "not sure" list, with the fallback stated on screen rather than implied |
- **Behavior notes:** no time estimates, no reassurance copy, no scare copy; progress survives a browser restart. **The picker offers one choice per playbook that exists, and "not sure" is last.** It listed a fifth until 2026-08-20 — a kind `core-recovery` has no steps for — and a choice whose answer is the broad list under a specific name is the screen claiming to know more than it does. Last rather than first because put at the top it is what a hurried person picks to skip the question, and the checklist they get is the broad one when a specific one existed. **A malformed address renders the broad list, it does not render nothing** — `#recovery=%E0%A4%A` (a broken escape) and `#recovery=constructor` (a name off `Object.prototype`) each left this screen completely blank until 2026-08-20, which is the worst place in the product for a blank screen
- **Wireframe:** wireframes/SCR-13.md
- **Coverage:** packages/ui/src/recovery/picker.ts:renderIncidentPicker, packages/ui/src/recovery/recovery.ts:renderRecovery, packages/core-recovery/src/checklist.ts:buildChecklist, packages/core-recovery/src/portable.ts:toPortable, e2e/scn-025.spec.ts
- **Scenarios:** SCN-025
- **Resources:** playbook definitions, incident store
- **Status:** built

### SCR-14: Public domain status
- **Used by:** FLW-04 (from the interstitial), FLW-15
- **Purpose:** let an affected site owner see and dispute a verdict without an account — the gap that generated the loudest complaint about the incumbent
- **Elements:** domain lookup field; current verdict with feed source and entry date; upstream appeal link when the verdict came from a third-party feed; appeal form (domain, contact, note) with reference id; **primary action: "Проверить"**
- **States:**
  | State | Trigger | Figma frame | Behavior |
  |-------|---------|-------------|----------|
  | loading | lookup running | - | none of its own — the page is served whole, so the browser's own loading is the only progress there is |
  | empty | domain not in any list | - | "Nothing is recorded for this domain" |
  | error | service unavailable | - | states it plainly and offers retry; never implies "clean" |
  | success | verdict found | - | verdict, source, date, appeal path |
- **Behavior notes:** a public web page, not an extension surface; no account, no tracking, no analytics. **Served whole, with no script:** the verdict and the appeal form are both in the markup, because the owner arrives from an interstitial on a site that is down and has no reason to run another page's JavaScript. The appeal form appears only for listings this service can lift — a form against a third-party feed collects a plea nobody reads
- **Wireframe:** wireframes/SCR-14.md
- **Coverage:** apps/proxy/src/router.ts:statusPage (verdict and appeal form in the markup), apps/proxy/src/router.ts:appeal + appealPage (accepts the form, answers as a page), apps/proxy/src/router.test.ts
- **Scenarios:** SCN-026
- **Resources:** worker status endpoint, feed metadata
- **Web surface:**
  - **Route:** `/status`, and `/status?domain=<domain>` for a named domain
  - **Answers:** is this one domain listed, by which list, and how the owner disputes it
  - **Indexable:** yes — `canonical` → `/status?domain=<domain>` per lookup, built in `apps/proxy/src/router.ts:statusPage`, so a shared link and the page agree
  - **Without JS:** wholly — the verdict and the appeal form are both in the markup, because the owner arrives from an interstitial on a site that is down
  - **Entity:** none. The page is a lookup result about someone else's domain, not a thing this product offers; a `SoftwareApplication` block here would describe the wrong subject
- **Status:** built

### SCR-15: Dashboard overview
- **Used by:** FLW-17
- **Purpose:** answer "what needs me, and where do I go" before any area is opened — the question the eight-panel stack made the user assemble by scrolling
- **Elements:** attention band `"Требует внимания (N)"`, at most three rows, the rest counted as `"…ещё N"`, each row severity-by-icon-plus-text with what, where and when, linking into its area; area list of eight real links, each with a one-line state. **Primary action: the first row of the attention band**; with an empty band, `"Что делать дальше"`
- **States:**
  | State | Trigger | Figma frame | Behavior |
  |-------|---------|-------------|----------|
  | loading | page opened | - | shell and all eight rows paint at once, each row's state reads `"считаем…"` and the band `"Считаем…"`; the shell never waits on data. The record said `"…"` for the row state until 2026-08-20: a bare ellipsis is not a state a screen reader can read out, on the one screen whose axe sweep is a gate — and it must not be `null`, which on this screen means "looked and could not read it" |
  | empty | nothing outstanding anywhere | - | `"Сейчас ничего не требует внимания"` plus when this was last checked; the area list still carries its states |
  | error | the store is unreadable | - | names the failure, offers repair, and **no area row claims a state** |
  | success | outstanding items exist | - | up to three ranked rows, then the eight areas |
- **Behavior notes:** one ranking rule for the whole product — `packages/core-queue/src/rank.ts` orders the band, with each area's outstanding item mapped into the shape it already ranks; a second ranker would be a second definition of "worst". **A row whose count could not be read says `"состояние не прочитано"`, never `"пусто"`** — absence of data must never read as a pass, and eight cheap reads that can each fail all render into one reassuring word. Areas are addressed by hash, one view at a time; **an unknown hash opens the overview and names the hash**, because a silent fallback is how `options.html#journal` went nowhere for a release. Navigation is real links plus `hashchange`, so browser back and forward work without a router. The overview reads counts only, never a section's full data. **The recovery row is the one whose address depends on what is open:** `#recovery` alone names no incident, so with exactly one open checklist the row opens that checklist, and with none or several it opens the overview — where the band lists them. It was given the overview's address outright until 2026-08-20, so a row reading «Восстановление» landed somewhere else (B-59); the rule is `recoveryHref` in `options/views.ts` and the state beside the label says which case it is
- **Visual layer, added 2026-08-21 (B-99):** this screen was built after `pages.css` gained one and inherited **none** of it — no card, the browser's own bullets, and every area row rendering flush: `"Что требует васничего не ждёт"`. It is one of the four store screenshots, so that was the picture a reviewer saw first. Now on the same locked pack as every other surface: the card list in `pages.css`, `list-style: none` on a list that is navigation rather than prose, and `display: flex` + `gap` on the row — the mechanism that file already used for the same defect on the first-run screen. Not one renderer changed, which is that file's own rule. **A when is worded by the caller, never by this renderer** — `OverviewState.lastChecked` says so in its type now, because the renderer puts it straight into a sentence and its own test passes `"сегодня в 9:00"`; the caller had been passing the journal's stored instant, so two rows read `2026-08-20T23:23:22.936Z`
- **Wireframe:** wireframes/SCR-15.md
- **Coverage:** packages/ui/src/dashboard/overview.ts:renderOverview, packages/ui/src/when.ts:shortDate/shortTime, apps/extension/src/pages.css, apps/extension/src/options/views.ts:routeFor, apps/extension/src/options/views.ts:recoveryHref, apps/extension/src/options/keep-focus.ts:keepingFocus, e2e/scn-027.spec.ts, docs/store/screenshots/03-self-audit.png
- **Scenarios:** SCN-027, SCN-028, SCN-029, SCN-030
- **Resources:** `packages/core-queue/src/rank.ts` (ranking), the counts each area can answer cheaply
- **Status:** built

### SCR-16: Trusted domains
- **Used by:** FLW-05, FLW-14
- **Purpose:** review and take back the "this is legitimate" decisions made on other screens
- **Elements:** the trusted list, each entry with when and why it was trusted; per-entry `"Убрать из доверенных"`. **Primary action: none** — this is a review surface whose only action is a reversal
- **States:**
  | State | Trigger | Figma frame | Behavior |
  |-------|---------|-------------|----------|
  | empty | nothing trusted yet | - | says nothing is trusted **and why the list would fill** — an empty state that only states emptiness leaves the user with nothing to do |
  | success | entries exist | - | each with when and why, each reversible |
  | error | store unreadable | - | names the read failure; never an empty list in its place. The sentence was built by the options page rather than by this renderer until 2026-08-20, so this record named a file the state did not live in and no renderer test nor the axe sweep could reach it (B-59) |
- **Behavior notes:** split out of SCR-12 on 2026-08-12 — the dashboard renders one area per view, and the overview names `"Доверенные домены"` and `"Ваши данные"` as separate rows. The renderer and its e2e already existed; only the address changes
- **Wireframe:** wireframes/SCR-16.md
- **Coverage:** packages/ui/src/trusted/trusted.ts:renderTrusted (states `ready` and `error`), e2e/scn-024.spec.ts
- **Scenarios:** SCN-024
- **Resources:** trusted-domain store
- **Status:** built

### SCR-17: Product landing page
- **Used by:** FLW-18 (deciding whether to install). **The gap recorded here on 2026-08-12 is closed 2026-08-20 (B-22)** — and the way it was recorded is why closing it was easy: the entry said a flow traced to no story would be a diagram rather than a design, and named the missing piece instead of inventing one. ST-021 is that story, FLW-18 the flow, SCN-033 the scenario
- **Purpose:** let someone who has never heard of this decide whether to install it — including by reading what it refuses to do
- **Elements:** what the product is in one sentence; what it does; **what it does not do** (half the page); how to install; links to `/privacy` and `/status`. **Primary action: install**
- **States:**
  | State | Trigger | Figma frame | Behavior |
  |-------|---------|-------------|----------|
  | success | any request to `/` | - | the whole page, served as markup |
- **Behavior notes:** a security tool that lists only its own powers describes a product nobody can check — so half the page is what it does not do. **No executable scripts at all**, and eleven rules in `apps/proxy/src/landing.test.ts` hold that, four of them verified by planted defects (a script appeared, the word "полностью" appeared, the does-not-do list was gutted, the structured block became invalid JSON)
- **Web surface:**
  - **Route:** `/`
  - **Answers:** what Okolos is, what it does, and what it will not do
  - **Indexable:** yes — `canonical` → the origin's `/`, emitted by `apps/proxy/src/router.ts:landingPage`
  - **Without JS:** wholly — there is not one script on the page, by gate
  - **Entity:** `schema.org/SoftwareApplication` in `application/ld+json`, repeating the page's own claims in machine form, built in `apps/proxy/src/router.ts:landingPage`
- **Coverage:** apps/proxy/src/router.ts:landingPage, apps/proxy/src/landing.test.ts
- **Scenarios:** none — a scenario needs a flow node to cover, and this screen has no flow (see `Used by`). The eleven rules in `landing.test.ts` are what hold it meanwhile, and they are gates rather than scenarios
- **Resources:** worker root route
- **Status:** built

### SCR-18: Privacy page
- **Used by:** FLW-18 (deciding whether to install), as the second step. It is also linked from the store listing and from the extension, and it is the document SCR-10 (self-audit) must agree with. **The gap recorded here on 2026-08-12 closed 2026-08-20 (B-22):** the pre-install journey is in the chain now — JRN-01 stages 2 and 3 always carried it, and what was missing was ST-021 between the journey and these pages
- **Purpose:** state what leaves the device, where to, why, and what is never stored — the document the store requires and the one the self-audit screen must agree with
- **Elements:** the five outbound destinations with what each carries; what is stored on the device and for how long; the reuse-index paragraph; what does not exist (no analytics, no account, no ads); why the extension asks for every site
- **States:**
  | State | Trigger | Figma frame | Behavior |
  |-------|---------|-------------|----------|
  | success | any request to `/privacy` | - | the whole page, served as markup |
- **Behavior notes:** generated from `docs/privacy.md` by `tools/privacy-page.mjs` into `apps/proxy/src/privacy.generated.ts`, so the served page and the repository document cannot disagree; `tools/docs.test.ts` checks the destination list, the retention period and the recipients against the sources. It must also agree with SCR-10 (self-audit), which shows the same outbound log from the device side
- **Web surface:**
  - **Route:** `/privacy`
  - **Answers:** what this extension sends, to whom, when, and what it keeps
  - **Indexable:** yes — **but the page carries no `canonical`** — `apps/proxy/src/router.ts:privacyPage` serves it without one, unlike `/` and `/status`. Harmless on a single host; the moment a custom domain is added, two hosts serve this page with nothing pointing at the preferred one. Fix belongs with the domain change
  - **Without JS:** wholly — generated HTML, no scripts
  - **Entity:** none yet. The natural one is `schema.org/PrivacyPolicy`; recorded here as a gap rather than claimed
- **Coverage:** apps/proxy/src/router.ts:privacyPage, tools/privacy-page.mjs, tools/docs.test.ts
- **Scenarios:** none — same reason as SCR-17. `tools/docs.test.ts` holds the page against its sources meanwhile
- **Resources:** `docs/privacy.md` (the source), the outbound-log contract
- **Status:** built

### SCR-19: Lookalike comparison
- **Used by:** FLW-05 (from the lookalike banner)
- **Purpose:** show the visited address beside the one it imitates, so the user sees the difference instead of being told about it
- **Elements:** the address as the bar holds it (`[data-role=visited]`); its decoded spelling when the two differ (`[data-role=decoded]`); the name it resembles (`[data-role=resembles]`); one sentence naming the technique (`[data-role=why]`); **primary action "Уйти"**, "Это настоящий сайт", "Закрыть"; a note saying the decision is reversible in settings (`[data-role=trust-note]`)
- **States:**
  | State | Trigger | Figma frame | Behavior |
  |-------|---------|-------------|----------|
  | success | opened from the banner | - | both spellings side by side, the address at full size |
  | no decoding | the address is plain ASCII | - | the decoded row is absent rather than repeating the visited one |
- **Recorded here on 2026-08-20, having been built long before.** It was the fourth in-page surface and the only one outside [ADR-0001](../adr/0001-closed-shadow-root.md): a bare `<section>` appended to the page's own `body`, with no shadow root and **no stylesheet at all** — not one line of CSS in its module. The page it warns about could read it, restyle it and delete it, and it did not need to try: on the hostile fixture the accessibility suite already ships, a `*` rule rendered it as six-pixel grey on grey. The suite audited the three surfaces the ADR names, so nothing looked. A screen with no record is a screen nobody compares against anything
- **Design system:** the shared overlay tokens, like the other three. It carries no palette of its own, and a test asserts there are no hex literals in its stylesheet — three surfaces once accumulated twenty-two hexes between them
- **Coverage:** packages/ui/src/comparison/comparison.ts:mountComparison, packages/ui/src/comparison/comparison.test.ts, e2e/scn-006.spec.ts, e2e/a11y-overlays.spec.ts
- **Scenarios:** SCN-006, SCN-024
- **Status:** built

### SCR-20: Local store unavailable
- **Used by:** FLW-14 (in place of every area, when the store cannot be opened)
- **Purpose:** say which of two different things happened, and offer the two things a person can do about it
- **Elements:** heading; `[data-role=storage-why]` — one sentence per problem, and the sentences differ because the remedies do; `[data-role=storage-versions]` — the profile's version and this build's, absent rather than invented when the profile could not be read at all; `[data-role=storage-detail]` — the underlying message verbatim, last, because it is what a bug report needs and not what a user should read first; **primary action "Попробовать снова"**, "Очистить локальные данные", and `[data-role=storage-reset-note]` listing everything clearing destroys
- **States:**
  | State | Trigger | Figma frame | Behavior |
  |-------|---------|-------------|----------|
  | from a newer version | the profile's schema version is higher than this build's | - | says the data is intact and reinstalling the newer build opens it |
  | shape incomplete | the store opened and lacks a store or an index | - | says updating will not fix it, because a browser changes a schema only on a version change |
  | blocked | another copy of Okolos holds the store | - | says to close the other window; trying again then works |
  | unknown | anything else | - | says the reason is below, and shows it |
- **Replaces six errors with one panel.** Every section of the options page reads the store and catches its own failure, so a profile written by a newer build rendered the browser's sentence about requested and existing versions once per panel, in a page that was otherwise empty. The check runs before any area is built
- **There is no confirmation behind "Clear the local data" — this panel is the confirmation.** The note carries what the wipe dialog's list carries, because a user agreeing to a word is not a user who agreed
- **Coverage:** packages/ui/src/storage/storage-problem.ts:renderStorageProblem, packages/ui/src/storage/storage-problem.test.ts, apps/extension/src/options/index.ts:storageProblem
- **Scenarios:** SCN-032
- **Status:** built

### SCR-21: Message verdict
- **Used by:** FLW-19 (the whole flow), FLW-20 (opened from the alert)
- **Purpose:** say what was found in one message, signal by signal, and say with equal prominence what was **not** checked — the surface exists to be weighed, not obeyed
- **Surface:** terminal output in Ф0; the same content rendered as a local page once a window exists. The content is specified here once; the medium is not what makes it a screen
- **Elements:** the message identified by sender, subject and date, so the reader knows which one this is; `severity + word` on the verdict line, never colour alone; `[data-role=signals]` — one row per signal that fired, each naming the fact it stands on (the authentication result, the two halves of a mismatched link, the two forms of a filename); `[data-role=not-run]` — one row per check that did not run, with its reason, carrying the same visual weight as the signals; `[data-role=review]` — who reviewed, where it ran, and for the cloud mode what left and how large; `[data-role=actions]` — at most three, and never more than one that leaves the terminal
- **States:**
  | State | Trigger | Figma frame | Behavior |
  |-------|---------|-------------|----------|
  | loading | checks started | - | names the check running now, not a spinner; attachments named individually because they are the slow ones |
  | empty | parsed, nothing found | - | says nothing was found **and lists what was checked** — a bare "clean" is the one answer this screen may not give |
  | error | the message could not be parsed | - | says the message could not be read, and does not render a verdict; a scan that failed is never a clean result |
  | success | one or more signals | - | signals first, worst first, then the checks that did not run |
- **Nothing here is carried by colour.** Inherited from the Design system section and restated because a terminal is where it is easiest to break: a severity is a word, and the word is printed whether or not the stream is a TTY.
- **The "did not run" block is not a footnote.** The browser side learned this twice — a download verdict that omitted the hash check read as a full one (B-57), and a scan that exited silently read as a clean page (B-74). A mail verdict has more absent checks than the browser side ever has: an unauthenticated sender, an attachment the parser refused, a reviewer that was off. Listing them quietly would make this the most confidently wrong surface in the product.
- **Scenarios:** SCN-038, SCN-039, SCN-040, SCN-041, SCN-043
- **Resources:** core-mail parser, the signed phishing feed, the lookalike checker, the jailed attachment parser, the reviewer driver
- **Status:** designed

### SCR-22: Message alert
- **Used by:** FLW-20 (the only surface the watcher raises on its own)
- **Purpose:** interrupt for a message worth interrupting for, and for nothing else
- **Surface:** a macOS user notification
- **Elements:** the severity in words; the sender as displayed **and** the address it resolves to, because the gap between them is often the whole finding; the one-sentence reason; a single action that opens SCR-21
- **States:**
  | State | Trigger | Figma frame | Behavior |
  |-------|---------|-------------|----------|
  | loading | — | - | not applicable: this surface only ever appears after a verdict exists, and a notification that says "checking" is an interruption with no content |
  | empty | nothing found | - | **nothing is shown at all.** The recorded verdict is the output; a notification per clean message is how a person learns to swipe them away unread |
  | error | the mail store cannot be read | - | says the watcher is not watching, and why — silence from a watcher that has stopped is indistinguishable from silence from a quiet inbox |
  | success | one or more signals | - | severity, sender, one sentence, one action |
- **Silence has to be earned, and the error state is what earns it.** A watcher that dies quietly leaves the user safer-feeling and no safer. This is the same argument SCN-030 makes on the dashboard — an unread state must never render as "nothing here".
- **Scenarios:** SCN-042
- **Resources:** the watcher, the notification channel
- **Status:** designed

