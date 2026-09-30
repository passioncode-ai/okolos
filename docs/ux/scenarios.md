<!-- Managed with super-ux (ux-contract v4). Update in the same change as any user-facing behavior change. -->

# Scenarios — source of truth for user-facing behavior

Scope: P0–P5. Every scenario traces to a story in
[foundation.md](foundation.md) and a flow in [flows.md](flows.md); screens
are specified once in [screens.md](screens.md).

## Index

| ID | Title | Feature | Persona | Traces | Status | Last audit |
|----|-------|---------|---------|--------|--------|------------|
| SCN-001 | First run — clean result | onboarding | P-01 | ST-018, FLW-01 | implemented | 2026-08-04 PARTIAL |
| SCN-002 | First run — findings found | onboarding | P-01 | ST-018, ST-015, FLW-01 | implemented | 2026-08-05 PASS |
| SCN-003 | Hidden instruction detected on a page | ai-shield | P-01 | ST-001, FLW-02 | implemented | 2026-08-04 PASS |
| SCN-004 | Inspect what was hidden | ai-shield | P-01 | ST-002, FLW-02 | implemented | 2026-08-04 PASS |
| SCN-005 | Neutralise and restore | ai-shield | P-01 | ST-003, FLW-02 | implemented | 2026-08-04 PASS |
| SCN-006 | Lookalike domain warning | web-guard | P-01 | ST-006, FLW-05 | implemented | 2026-08-05 PASS |
| SCN-007 | Known-malicious page blocked | web-guard | P-02 | ST-005, ST-016, FLW-04 | implemented | 2026-08-05 PASS |
| SCN-008 | ClickFix — page copies a command | web-guard | P-02 | ST-007, FLW-06 | implemented | 2026-08-05 PASS |
| SCN-009 | Browser-lock trap escape | web-guard | P-02 | ST-008, FLW-07 | implemented | 2026-08-05 PASS |
| SCN-010 | Agent blocked from acting on a poisoned page | ai-shield | P-01 | ST-004, FLW-03 | implemented | 2026-08-05 PASS |
| SCN-011 | Credential-entry guard on a new domain | web-guard | P-02 | ST-010, FLW-09 | implemented | 2026-08-05 PASS |
| SCN-012 | Download stopped by feed or hash | web-guard | P-01 | ST-009, FLW-08 | implemented | 2026-08-05 unit |
| SCN-013 | Download partially checked — hash unavailable | web-guard | P-01 | ST-009, FLW-08 | implemented | 2026-08-05 unit |
| SCN-014 | Submitted password is compromised | credentials | P-01 | ST-011, FLW-10 | implemented | 2026-08-05 unit |
| SCN-015 | Leak inventory with one source unavailable | credentials | P-01 | ST-012, FLW-11 | implemented | 2026-08-05 PASS |
| SCN-016 | Repair a leak and mark it resolved | credentials | P-01 | ST-015, ST-012, FLW-11 | implemented | 2026-08-05 unit |
| SCN-017 | Extension gained permissions — disable it | extensions | P-01 | ST-013, ST-014, FLW-12 | implemented | 2026-08-05 PASS |
| SCN-018 | Extension changed publisher, package unavailable | extensions | P-01 | ST-013, FLW-12 | implemented | 2026-08-05 PASS |
| SCN-019 | Verify what left the device | privacy | P-01 | ST-017, FLW-13 | implemented | 2026-08-04 PASS |
| SCN-020 | Popup — verdict for the current page | daily-use | P-01 | ST-015, FLW-17 | implemented | 2026-08-05 PASS |
| SCN-021 | What changed since last time | daily-use | P-01 | ST-015, FLW-17 | implemented | 2026-08-05 PASS |
| SCN-022 | Queue never exceeds three actions | daily-use | P-01 | ST-015, FLW-01 | implemented | 2026-08-05 PASS |
| SCN-023 | Wipe all local data | privacy | P-01 | ST-019, FLW-14 | implemented | 2026-08-04 PARTIAL |
| SCN-024 | Export all local data | privacy | P-01 | ST-019, FLW-14 | implemented | 2026-08-04 PARTIAL |
| SCN-025 | Recovery after running a pasted command | recovery | P-02 | ST-015, FLW-16 | implemented | 2026-08-05 PASS |
| SCN-026 | Site owner checks and appeals a verdict | site-owner | P-03 | ST-016, FLW-15 | implemented | 2026-08-05 unit |
| SCN-027 | Dashboard overview — what needs me, across areas | daily-use | P-01 | ST-015, FLW-17 | implemented | 2026-08-13 PASS |
| SCN-028 | A deep link opens its area; an unknown address says so | daily-use | P-01 | ST-015, FLW-17 | implemented | 2026-08-13 PASS |
| SCN-029 | Acting inside an area keeps the place, the focus and the count | daily-use | P-01 | ST-015, FLW-17 | implemented | 2026-08-13 PASS |
| SCN-030 | An unread count never renders as "nothing here" | daily-use | P-01 | ST-017, FLW-17 | implemented | 2026-08-13 PASS |
| SCN-031 | A finding inside an embedded frame reaches the page that embeds it | ai-shield | P-01 | ST-001, FLW-02 | implemented | 2026-08-20 e2e |
| SCN-032 | The local store was written by a newer build | recovery | P-01 | ST-019, FLW-14 | implemented | 2026-08-20 unit |
| SCN-033 | Deciding whether to install, from pages that run nothing | pre-install | P-01 | ST-021, FLW-18 | implemented | 2026-08-20 unit+gate |
| SCN-034 | A login form inside an embedded frame is checked | web-guard | P-02 | ST-010, FLW-09 | implemented | 2026-08-20 e2e |
| SCN-035 | A password submitted from an embedded frame is checked | credentials | P-01 | ST-011, FLW-10 | implemented | 2026-08-20 e2e |
| SCN-036 | A verdict survives the navigation the submission caused | credentials | P-01 | ST-011, FLW-10 | implemented | 2026-08-20 e2e |
| SCN-037 | The block page refuses to be another page's iframe | web-guard | P-02 | ST-005, FLW-04 | implemented | 2026-08-21 e2e |
| SCN-038 | One message checked on demand | mail-guard | P-01 | ST-022, FLW-19 | draft | — |
| SCN-039 | The sender is not who the name says | mail-guard | P-01 | ST-023, FLW-19 | implemented | 2026-09-12 unit |
| SCN-040 | A link goes somewhere other than it says, and text is hidden from the reader | mail-guard | P-01 | ST-024, FLW-19 | draft | — |
| SCN-041 | An attachment is judged without being opened | mail-guard | P-01 | ST-025, FLW-19 | draft | — |
| SCN-042 | A message arrives and is judged before it is read | mail-guard | P-01 | ST-022, FLW-20 | draft | — |
| SCN-043 | Who reviewed, where it ran, and what left | mail-guard | P-01 | ST-026, FLW-19 | draft | — |

## Personas

See [foundation.md](foundation.md) → Personas.

## onboarding

### SCN-001: First run — clean result
- **Persona:** P-01
- **Feature:** onboarding
- **Traces:** ST-018, FLW-01 (JTBD-02, JRN-01/#4)
- **Entry point:** extension just installed, first-run screen opens automatically
- **Preconditions:** no prior local data
- **Steps:**
  1. User finishes installing -> system opens the first-run screen and starts local checks, listing each check by name with live progress
  2. User watches the checks complete -> system reports nothing found and names every check that ran and when its data was last updated
  3. User closes the screen -> system leaves the toolbar icon in a neutral state and records the run time
- **Expected result:** the user knows, within 30 seconds and without an account, that their open tabs and installed extensions were checked locally and nothing was found
- **Alt paths:** user clicks "Skip for now" mid-run -> system finishes the checks in the background and surfaces results in the popup badge only if something is found
- **UI elements:** first-run screen, per-check progress rows, "what this sends" link, "See what to do first" (disabled when nothing found), "Skip for now"
- **States covered:** loading, empty, success
- **Errors & recovery:** a check cannot run (e.g. corpus still downloading) -> that row states the reason and offers retry; the other checks continue and the result explicitly says the run was partial
- **Status:** implemented
- **Coverage:** packages/ui/src/first-run/screen.ts:renderFirstRun, apps/extension/src/first-run/index.ts — PARTIAL: the tab and extension inventories this scenario describes need permissions this version deliberately does not request, so those rows render as `unavailable` with the reason. They become `ok` with REQ-23 (extensions) and the tabs permission that justifies it

### SCN-002: First run — findings found
- **Persona:** P-01
- **Feature:** onboarding
- **Traces:** ST-018, ST-015, FLW-01 (JTBD-02, JTBD-04, JRN-01/#4)
- **Entry point:** first-run screen, checks completed with findings
- **Preconditions:** at least one open tab with a finding, or one extension with a risk signal
- **Steps:**
  1. User waits for the checks -> system shows findings grouped by category with counts
  2. User clicks "See what to do first" -> system opens the findings queue with at most three prioritised actions
  3. User opens the top item -> system shows what happened, why it matters, and one executable action
- **Expected result:** the user's first interaction ends with a concrete action available, not a list to read
- **Alt paths:** user ignores the queue and closes it -> items stay in the queue and the toolbar badge shows the count
- **UI elements:** findings summary by category, "See what to do first", queue items, per-item primary action, "not now"
- **States covered:** loading, error, success
- **Errors & recovery:** queue store unreadable -> the queue states the storage problem rather than showing an empty list
- **Status:** implemented
- **Coverage:** packages/ui/src/queue/queue.ts:renderQueue, apps/extension/src/first-run/index.ts, e2e/scn-002.spec.ts

## ai-shield

### SCN-003: Hidden instruction detected on a page
- **Persona:** P-01
- **Feature:** ai-shield
- **Traces:** ST-001, FLW-02 (JTBD-01, JRN-01/#5)
- **Entry point:** any page load or DOM mutation batch
- **Preconditions:** the page contains text present in the DOM but not perceivable by a human, phrased as an instruction
- **Steps:**
  1. User opens the page -> system runs the visibility diff, then rules, and raises a finding
  2. User sees the banner naming the finding in one sentence -> system states whether the text was already neutralised
  3. User continues reading the page -> system keeps the banner until dismissed or the tab closes
- **Expected result:** the user knows the page carries instructions addressed to an AI, and whether they are still active
- **Measured latency — 110 ms median from the navigation to the warning, on a cold worker.** Eight cold contexts on a quiet machine, 2026-08-20: 79, 92, 102, 104, 106, 119, 140, 535 ms; the slowest is the first run of a batch, which is the browser cache rather than the code. Cold means what it says — a fresh persistent context per run, so the figure covers the browser launch, the extension load, the service-worker boot, the page load, the scan, the RPC and the mount. Until this was measured the only thing anywhere that spoke about this delay was a test's ten-second wait, written into thirteen files (B-65), and "before the page settles" was a promise rather than a number. The product reports it itself — `performance.measure('okolos:banner')` from the navigation's time origin — and `e2e/cold-start.spec.ts` refuses above 4 s, which is not the latency but a threshold with room for a loaded machine: the same wait has been observed past twenty seconds on a shared CI runner without the code doing anything different
- **Alt paths:** the page is on the user's trusted list for this rule -> system logs the finding to the journal without showing a banner
- **UI elements:** in-page banner (injection variant), "Show me", "This is wrong", dismiss
- **States covered:** success
- **Errors & recovery:** the classifier stage fails or times out -> the verdict falls back to the deterministic stages, the banner states that detection was partial. **A page cannot blind the scan with cheap markup, and cannot buy a complete-looking verdict by making it expensive.** Six thousand `<!-- -->` in `<head>` spent the whole traversal allowance before the document was looked at — `candidates=0, nodeCount=5001, truncated=true`, and the same injection with the comments removed was found. Both allowances are split between the two walks now, and an empty comment carries nothing so it costs nothing (B-40). **And a scan that spent everything and found nothing says so:** zero candidates used to mean a silent exit — no banner, no record, a person believing the page had been checked. It writes a `scan-blinded` journal line instead. Journalled rather than bannered, because a banner on every large page cries wolf and the journal is where this product already says "we looked and could not finish". The candidate ceiling was checked once per node, and one node can carry candidates without limit: an element with 20 000 `data-*` attributes produced 20 000 candidates and reported `truncated: false` — the memory ceiling walked around and the verdict claiming a full scan of a page it had not finished, repeatable twice a second in every frame (B-41). The ceiling applies on every addition now, and reaching it says the scan was cut short; a detector exception disables that detector for the session and is journalled, and the page is never broken. **A scan that cannot finish at all now says so.** Until 2026-08-20 it did not: the receiver answers `{ error: 'failed' }` when a handler throws and `{ error: 'unsupported' }` for a type it does not know, both were handed to the caller as if they were the response, and `response?.verdicts ?? []` turned a **failed scan into a clean page** — no banner, no record, and the person believing the page had been checked. An error answer is now a rejection at the adapter, and the scan's fail-open wrapper writes a `scan-failed` journal line instead of a `console.warn` nobody reads (B-74). Fail open is right; fail silent is not
- **The traversal budget is deterministic, and that is a promise about warnings.** How much
  of a page gets read is bounded by nodes, candidates and characters — not by the clock. It
  used to include eight milliseconds of wall clock, which made the decision a function of
  machine load: on a busy runner the collector gave up on a **seven-node page**, returned no
  candidates, and the page went unwarned with only a journal line to say so. Four CI runs
  failed that way before the report was detailed enough to name it (B-110). The time ceiling
  is still there as a hang guard at 500 ms — two orders above an honest scan — and a test
  holds a floor under it so it cannot drift back to a value that decides. A security check
  that abandons itself when the machine is under strain is the one thing it may not do
- **Known limit — a page whose scan failed is not re-scanned on its own.** The record says the page was not checked, and on a static page no further mutation arrives to trigger another attempt. A bounded retry is a policy of its own — how many times, how far apart, what is said when the budget is gone — and adding one without that shape is how an unbounded retry gets written by accident. Not built; the honest state is on screen instead of a false clean one
- **Known limit — the wording of the nine signals is matched in English and Russian, and no other language.** Hidden text in a third language reaches stage 1 as a candidate and leaves it without a signal, so no verdict is raised. Russian was added on 2026-08-08 after a sweep found all nine written in English alone: five Russian attack shapes produced zero signals between them, in the detector this product is named for and for the audience its watchlist and interface are written for. **The invisible-character class was described here as carrying no language and therefore never affected, and that was the wrong way round:** carrying no language is exactly what made it fire on five writing systems at once — a family emoji, a Scottish flag, a Persian word, a Hebrew sentence with a Latin brand in it, a phone number in a right-to-left wrapper. Presence of an invisible character is no longer the finding; placement is. What remains genuinely language-free is the DOM-versus-render difference that makes a candidate in the first place
- **Known limit — a zero-width non-joiner inside an Arabic, Persian or Indic word is not reported.** In those scripts the same character between two letters of a word is the orthography *and* the shape a splitter attack takes, and no placement test separates them. The alternative is reporting the language, which is the failure the placement rule exists to prevent. Pinned by a test in `packages/core-injection/src/chars.test.ts`, so widening the rule to those scripts goes red and the trade is made again on purpose
- **What one signal is allowed to do.** A single signal used to produce `high` confidence, which the ladder turns into `sanitize`, which edits the page — so a screen-reader label, a specification row and a family emoji each got a paragraph of somebody's page emptied. Measured 2026-08-20: **fourteen of sixteen ordinary strings produced `sanitize`.** Signals now sit in two tiers. The shapes with no innocent reading in hidden text — cancelling prior instructions, claiming to be the system layer, asking for secrecy from the user, a condition only a machine can meet, assigning the reader a model's role — still act alone. A tool noun, a credential, an address or an invisible character corroborate: **one of them is a banner, two are an edit.** The tier is also a property of *how* the signal matched, not only of which signal it is: "use **your** browsing tool" and "open the tools" are the same signal and not the same evidence, and a right-to-left override and an unclosed isolate are both `char-anomaly` while only one is a deception primitive. Recorded as [ADR-0012](../adr/0012-one-signal-is-a-suspicion.md)
- **Telemetry:** none — no analytics events are emitted by this product
- **Status:** implemented
- **Known limit — a page that deletes the surface wins the page and loses the warning.** Removing the host node in a loop is the one vector CSS armour and an unpredictable element name cannot reach, because the DOM belongs to the page. It is not forbidden, it is **bounded**: three re-mounts a quarter-second apart, and then the extension's own icon carries the warning with a journal line naming the count ([ADR-0001](../adr/0001-closed-shadow-root.md), amended 2026-08-20). A page removing every 30 ms spends that budget in under a second, which is the intended outcome — the reader sees the warning flash, the icon holds it after that, and no timer is left running for the life of the tab. **What this costs the reader:** the banner sits on the page it is about, and half its value is that location; the badge says "open Okolos" instead of "look here". The alternative that would keep it — a system notification — costs a permission the manifest does not have, so it was refused rather than taken quietly
- **Alt path — the user dismisses the banner.** Closing it also takes the host out of the document, and that is not an attack: the watch stops before the product destroys its own surface, so "gone" always means "gone without us doing it". Otherwise a dismissed banner would come back three times and then mark the icon about it
- **Coverage:** apps/extension/src/content/collect.ts:collect, packages/core-injection/src/stage1.ts:detectHidden, packages/ui/src/banner/banner.ts:mountBanner, packages/ui/src/host.ts:createOverlayHost, apps/extension/src/content/keep-surface.ts:keepSurfaceMounted, e2e/scn-003.spec.ts, e2e/hostile-page.spec.ts, e2e/surface-deleted.spec.ts (the badge and the journal line, against the shipping build)

### SCN-004: Inspect what was hidden
- **Persona:** P-01
- **Feature:** ai-shield
- **Traces:** ST-002, FLW-02 (JTBD-01, JTBD-05)
- **Entry point:** "Show me" on the injection banner
- **Preconditions:** an active finding on the current page
- **Steps:**
  1. User clicks "Show me" -> system opens the inspector with the concealed text verbatim
  2. User reads the evidence -> system shows the concealment technique, the DOM location, which stage fired and its confidence
  3. User decides -> system offers "Keep it neutralised", "Restore page", "This is wrong"
- **Expected result:** the user can judge the verdict from the evidence rather than trusting a score
- **Alt paths:** the page mutated and the node no longer exists -> system says the page changed and offers a re-scan
- **UI elements:** inspector panel, concealed text block, technique label, location path, stage and confidence, three actions
- **States covered:** loading, success, error
- **Errors & recovery:** evidence cannot be loaded -> inline failure with retry; the banner and the neutralisation both remain in place
- **Status:** implemented
- **Coverage:** packages/ui/src/inspector/inspector.ts:mountInspector, apps/extension/src/content/index.ts:MEASURE_COLLECT, e2e/scn-004-click.spec.ts — the click path is exercised against a build whose only difference is an open shadow root (REQ-35); a bundle gate asserts production keeps it closed

### SCN-005: Neutralise and restore
- **Persona:** P-01
- **Feature:** ai-shield
- **Traces:** ST-003, FLW-02 (JTBD-01, JRN-01/#6)
- **Entry point:** a high-confidence finding on a page the user is about to hand to an assistant
- **Preconditions:** injection confirmed by the deterministic stages
- **Steps:**
  1. User opens a page with a confirmed injection -> system neutralises the offending nodes before the page settles and states this in the banner
  2. User asks their assistant to summarise the page -> system leaves the assistant with the cleaned DOM
  3. User clicks "Restore page" -> system puts the original nodes back exactly and marks the finding unresolved
- **Expected result:** the assistant reads a page without planted instructions, and the user can always get the original page back
- **Alt paths:** confidence is below the automatic threshold -> system warns but does not modify the page; neutralisation becomes a button
- **UI elements:** banner statement "hidden instructions removed", "Restore page", "Keep it neutralised"
- **States covered:** success, error
- **Errors & recovery:** removal fails on a protected node -> system reports which nodes could not be neutralised and keeps warning; restore always returns the DOM to its pre-change state; **restoring will not put text back into a node the page has taken over.** If the element left the document there is nothing to restore, and if the page wrote into it while it was held, appending would splice the hidden instruction in beside the page's new content — a document neither party wrote, with the injection back in it. Both are counted and reported rather than performed **The panel stays open and says which of the two happened**, and the same sentence is written to the self-audit journal, because a control that fails quietly is one the user learns to distrust. **Pressing the button again repeats the same sentence** rather than answering "nothing to do": while the page's content sits in that node the refusal is a standing fact, and a second press that looked like success is how the user concludes the first message was noise. **The screen repeats; the journal does not.** The self-audit log is a store with a retention period, so ten presses on one node wrote ten identical records and evicted what happened once — a record per distinct fact now, and a *different* outcome (one node put back, another still refused) is a different fact and is written (B-64). The two contracts pull opposite ways and both are kept: a person pressing a button is answered every time, the store is told once
- **What a second pass may not do:** the page is re-read while a finding is open, and the plan handed to the executor names locators from the *previous* scan of the *previous* DOM — so "this locator now names a node we have never held" is the ordinary case on a page that rebuilds itself, not an exotic one. Three rules follow, all measured against the compiled artefact on 2026-08-20 and all previously broken. The executor **captures before it empties, always** — a second pass that emptied the node the locator names *now* while holding the contents of the node it named *then* destroyed the page's own content with nothing able to put it back, and then reported `gone`, which reads as the page having taken it. It **does not empty a node the page has written into** — doing so left the node looking like ours, so restore appended the held original and **put the injection back on the page** reporting success, walking around the refusal above by one rescan cycle. And it **does not count a node it refused to touch** as neutralised, because the banner's "hidden instructions removed" is derived from that number
- **Status:** implemented
- **Coverage:** packages/core-sanitizer/src/plan.ts:planSanitisation, apps/extension/src/content/sanitize.ts:Sanitiser, apps/extension/src/content/journal-once.ts:createJournalOnce, e2e/scn-005.spec.ts (two presses: the sentence twice, the record once)
- **Behaviour notes:** the locator names one element and the executor refuses an ambiguous one; until 2026-08-20 a truncated tag-only path could point at an innocent twin. The hold is keyed by the element and not by the locator, for the reason above: the locator is a question about the page and its answer changes, the node whose contents are held does not

### SCN-010: Agent blocked from acting on a poisoned page
- **Persona:** P-01
- **Feature:** ai-shield
- **Traces:** ST-004, FLW-03 (JTBD-01, JRN-01/#6)
- **Entry point:** a sensitive action is attempted from a page carrying an unresolved finding
- **Preconditions:** finding present and not resolved or dismissed
- **Steps:**
  1. User's assistant attempts a sensitive action -> system pauses it and opens the gate naming the action and the finding
  2. User clicks "Show the injection" -> system opens the inspector, then returns to the gate
  3. User clicks "Block" -> system cancels the action and journals the decision
- **Expected result:** no action proceeds from a compromised page without an explicit human decision
- **Alt paths:** user clicks "Allow once" -> the action proceeds and is journalled with the finding attached
- **UI elements:** gate modal, action description, finding line, "Block" (default), "Allow once", "Show the injection"
- **States covered:** success, error
- **Errors & recovery:** the action context cannot be identified -> system blocks and states what could not be determined; the gate timing out defaults to Block, never to Allow; the gate surface itself cannot be shown -> the action is blocked and journalled
- **What decides "no human started this":** two facts, not one. `event.isTrusted`, which a page cannot forge — and whether the browser reports it is being driven (`navigator.webdriver`). **Measured 2026-08-08**, clicking one button three ways: page script `el.click()` → `isTrusted: false`; automation input through the devtools protocol → `isTrusted: **true**`; `dispatchEvent('click')` → `false`. So `isTrusted` separates page script from input into the browser, not a machine from a person — and a browser agent driving Chrome, the most ordinary kind there is, was greeted as the user by the screen built to stop it. Under automation a trusted event is no longer taken as a person. This closes the default configuration, not the determined case: an agent driving through an extension is not WebDriver, and whoever controls the browser's launch can clear the flag
- **Two fail-open paths, both closed 2026-08-20.** The description of an action was built **before** `preventDefault` and outside any `try` — and a capture-phase listener that throws does not cancel its event, so anything the description threw let the action out. It was not hypothetical: the id came from `crypto.randomUUID()`, which is `[SecureContext]`, and the manifest matches plain-HTTP pages, so on every one of them the first line threw `TypeError` and **the gate was a no-op on exactly the pages a poisoned document is cheapest to serve from**. The id now comes from `getRandomValues`, which carries no such restriction; a failed description falls back to an action nobody can name, which `assessAction` already blocks outright rather than asking, because a modal that cannot say what it is about invites a reflexive "allow"; and the fallback depends on nothing that could have failed — the first version of it called the same broken `newId` again. A bundle gate now refuses any secure-context API in a script that runs on a page
- **Known limit — the window before this page has been read.** Between `document_idle` and the verdict returning there is nothing to weigh, and the gate used to answer "nothing unresolved here" — an unrun check reported as a passed one, with nothing written down. Holding instead would mean holding every click on every page for the length of a scan, which is how an extension becomes the thing that broke the web. So the window stays open and is **recorded**: the list of findings is `null` rather than empty until the page has been read, and an action that goes through in that window is journalled as one that did. The page controls the window's contents — it can fire its scripted click on the first line of its own body — and cannot make the record disappear
- **Known limit:** the hold is driven by DOM events, and it covers **navigational** actions only — forms, links, and controls inside a form. Two things fall outside it, and the expected result above must be read against both. (1) A page calling `form.submit()` directly fires no event at all and cannot be seen from an isolated world; a scripted click or `requestSubmit()` — what agent tooling actually does — is caught. (2) A scripted click on a control that belongs to no form is seen and deliberately not held: pages click their own tabs, menus and cards constantly, and holding those would make the extension the thing that broke the web. The cost is that an action performed by `fetch` from a bare button — how a single-page application moves money — is not gated. Pinned by tests in `apps/extension/src/content/agent-gate.test.ts` so the boundary is a decision rather than an oversight. **The channel could be silenced by the page until 2026-08-20**, which was the opposite of what ADR-0009 promised: a `disarm` on `window.postMessage`, accepted from `event.source === window` — exactly what the page's own post satisfies. One line of page script and the record stopped, in the one mechanism whose entire value is that a record exists. Authenticating that channel is not available on this platform, because the MAIN world *is* the page's, so arming is one-way now and the question "is this worth recording" is answered in the background from the extension's own database, against the origin **the sender reports** rather than the host in the payload. A forged report from a clean page therefore writes nothing at all — better than the noise the decision had settled for. **Resolved 2026-08-09, and not by closing it:** holding such a request is not achievable — a content script is in an isolated world, MV3 has no blocking `webRequest`, and `declarativeNetRequest` cannot ask a person anything. What is achievable is a record, so a `MAIN`-world watcher now observes state-changing requests while a finding is unresolved and journals host and method, saying in those words that the request was **not stopped**. Decision and its limits: [ADR-0009](../adr/0009-the-page-watcher-observes-and-never-holds.md).
- **One gate, one action — the second attempt is refused, not stacked (fixed 2026-08-21).** A gate names the action it was opened about, so a second interception arriving while it stands cannot be answered by it: the panel underneath says one thing and the button belongs to the other. It used to mount a **second** panel in the same coordinates (`gates=2` measured), overwrite the handle to the first, and leave that first host in the page out of reach of the close path — the shape B-69 recorded for banners. The slot is claimed now: while a question is open the next action is blocked immediately with no surface of its own, and the record says why in its own words — `already-asking`, not `user-blocked`, because a refusal attributed to a reader who saw nothing is a false record about a person. The reader answers the standing question; the refused action is theirs to retry afterwards (B-123)
- **Status:** implemented
- **Coverage:** packages/core-gate/src/decide.ts:assessAction, apps/extension/src/content/agent-gate.ts:AgentGate, packages/ui/src/gate/gate.ts:mountGate, e2e/scn-010.spec.ts

## web-guard

### SCN-006: Lookalike domain warning
- **Persona:** P-01
- **Feature:** web-guard
- **Traces:** ST-006, FLW-05 (JTBD-02)
- **Entry point:** navigation to a domain within confusable or typo distance of the watchlist or the popular-domains list
- **Preconditions:** the domain is not on the user's trusted list
- **Steps:**
  1. User opens the page -> system decodes punycode, normalises confusables, and raises the lookalike finding
  2. User clicks "Show comparison" -> system shows the visited domain and the expected one side by side, with the decoded form
  3. User clicks "Leave" -> system returns to the previous page
- **Expected result:** the user sees both spellings before interacting with the page
- **Techniques named:** mixed-script, homograph, typo, tld-swap, and **brand-subdomain** — the watched name standing as its own label in front of another site (`paypal.com.evil.test`), which is the commonest phishing shape and which every similarity test passed, because the registrable domain resembles nothing watched
- **Alt paths:** user clicks "This is legitimate" -> the domain is trusted, the warning stops here on, and the entry is editable in settings
- **UI elements:** banner (lookalike variant), comparison view, decoded punycode, "Leave", "This is legitimate", dismiss
- **States covered:** success
- **Errors & recovery:** the watchlist cannot be read -> comparison falls back to the popular-domains list that ships with the extension
- **What decides where a name stops belonging to its registrant.** Every rule here asks whether a brand stands where it does not belong, and the answer needs the public suffix. Taking "the second-to-last label" instead reported **twenty-one genuine hosts out of a thirty-four-host sample** (measured 2026-08-20): `amazon.co.uk`, `apple.co.jp`, `microsoft.com.au` and `booking.co.il`, whose brand looked like a subdomain of `co`; **every Russian government site**, because `pfr.gov.ru` and `nalog.gov.ru` share the label `gov`; and three of the largest mail providers, because the watchlist contains the word `mail`. The rule is now stated once — the brand appears among the labels the registrant put in front of **their own domain** — and `packages/core-lookalike/src/real-hosts.test.ts` holds the sample
- **Known limit — the suffix table is a curated subset of the Public Suffix List, and 32 entries are deliberately *not* in it.** A suffix it does not carry is read as a single label, which makes the registrable domain one label too short: that direction can only **miss** a finding, never invent one. The private half fails the other way and matters more — a missing private suffix lets the blocklist treat a platform's apex as a site and emit a `||host^` rule over the whole platform. **Measured 2026-08-20 against the real list** (10 248 rules; 283 wildcard and 8 exception rules this table implements neither of): vendoring all of it costs 171 KB of JSON on a 61.5 KB content script — 3.7× on every page load — and the private section alone 69 KB. What it buys against the 248 hosts of the shipped feed: three sat under a private suffix this table lacked, and **zero** were an unknown private apex. Those three families were added instead, and the 32 divergences are recorded in `suffixes.json` so a future "sync with the PSL" cannot delete them silently — `pnpm suffix:gap` re-measures all of it on demand. B-66 is closed as this trade rather than as a vendoring project
- **Partly recovered 2026-08-20 — a brand under an ending that is itself a word about accounts is reported.** `paypal.security`, `paypal.support`, `paypal.login`, `sberbank.verify` are findings now (`brand-under-login-word`). The rule that used to catch them — same name, **any** different ending — flagged `google.de`, `yandex.com`, `github.io`, `stripe.dev`, `discord.gg`, `sberbank.com`, `telegram.me`, `vk.ru` and `ozon.by`, every one of them the real company, and a warning on `google.de` is how a user learns to dismiss the next one. Ownership is still not a fact a content script has — but the **meaning of the ending** is, and that is the second signal [ADR-0012](../adr/0012-one-signal-is-a-suspicion.md) asks for: the brand alone is a suspicion, the brand plus "sign in here" is a verdict. Measured against the thirty-four recorded real hosts: **zero** flagged; removing the word list from the rule reddens exactly those nine again, which is the test that says the word list is what buys it (`packages/core-lookalike/src/real-hosts.test.ts`)
- **Known limit — a brand under a word ending that is not about accounts is still not reported.** `paypal.shop`, `sberbank.city` pass silently, because a real company may well own those and the false positive costs more than the miss. The word list is a coverage claim like the watchlist itself, and B-67 is closed as this trade rather than as the data-collection project it looked like: per-brand declared endings would need fifty brands kept current, and ageing data in a security check is worse than a stated gap. What is also kept is the **mistyped** ending: `.co` and `.cm` are one edit from `.com` and are the classic squats
- **Known limit — the brand label must be a name, not a service word.** `mail.ru` and `office.com` are on the watchlist and their first labels are what the whole web calls a subdomain, so the standing-alone rule skips those two: `mail.evil.test` is not reported, while `mail.ru.evil.test` still is. A length threshold was the alternative and it was worse — it would have dropped `vtb`, `mkb`, `mos`, `ozon` and `cdek`, five names this product exists to protect, to catch two it can name
- **Status:** implemented
- **The comparison is a surface of its own, recorded as SCR-19 on 2026-08-20.** Until then it was the fourth in-page surface and the only one outside [ADR-0001](../adr/0001-closed-shadow-root.md): a bare `<section>` in the page's own `body`, no shadow root, no stylesheet. The page could read it, restyle it and remove it — and on the hostile fixture the accessibility suite already ships, it rendered as six-pixel grey on grey without the page having to try. It mounts like the other three now and is audited beside them
- **Coverage:** packages/core-lookalike/src/check.ts:checkLookalike, packages/core-lookalike/src/suffix.ts:registrableDomain, packages/core-lookalike/src/real-hosts.test.ts, apps/extension/src/content/lookalike.ts:warnIfLookalike, packages/ui/src/comparison/comparison.ts:mountComparison, e2e/scn-006.spec.ts, e2e/a11y-overlays.spec.ts

### SCN-007: Known-malicious page blocked
- **Persona:** P-02
- **Feature:** web-guard
- **Traces:** ST-005, ST-016, FLW-04 (JTBD-02, JRN-03/#2)
- **Entry point:** navigation to a URL matching a signed feed entry
- **Preconditions:** feeds present and signature-verified — **and the feed has to have arrived**: until 2026-08-08 nothing fetched one, so the list was empty on every install and this scenario held only in a test that seeded storage by hand. It is pulled every six hours and once at start now, through the audited choke point, and a refusal leaves the last verified snapshot in force
- **Steps:**
  1. User clicks a link -> system replaces the page with the interstitial before it renders
  2. User reads why -> system names the feed that produced the verdict and the entry's date
  3. User clicks "Go back" -> system returns to the previous page
- **Expected result:** the malicious page never renders and the user understands on whose authority it was blocked
- **Alt paths:** user clicks "Continue anyway" -> system states that an exception will be remembered and journalled, then loads the page; user clicks "I own this site" -> system opens the public domain status page with the blocked domain already filled in. **It opened `options.html#appeal` until 2026-08-08** — an extension page with no appeal section, at a hash that matched nothing. The record here was right the whole time; nothing tested the wiring, so only the destination drifted
- **UI elements:** interstitial, verdict source line, "Go back" (primary), "Continue anyway", "I own this site", "Details"
- **States covered:** success, error
- **Errors & recovery:** **this browser cannot check the list's signature** -> the list is not downloaded at all and the journal says so, naming the browser rather than the publisher. Ed25519 in WebCrypto exists from Chrome 137 and Firefox 129; the manifests invited 116 and 128, and on that range every update was refused, no list was ever in force, and the journal reported "not signed by the expected key" — a check that never ran, reported as a check that failed. The floors now match the primitive ([ADR-0011](../adr/0011-the-signature-primitive-decides-the-supported-range.md)), so this branch is unreachable in the field and exists for an install that ignores them; feed metadata unavailable -> the block still applies, the interstitial says the source is unknown and how to check it — **but only after asking again**: the screen paints immediately with whatever the background has (the blocked page is not rendering, so a delayed first paint is a blank tab) and re-asks for up to five short attempts, repainting once the list is named. It stops on the first thing the user does. Before this, a cold service worker made the honest statement permanent — an end-to-end run failed once in seventy-four on exactly that, and passed three times out of three in isolation; feeds stale beyond the freshness window -> the interstitial states the data age; **a listing on a parent domain no longer overrides an exception granted on a child** — `||shop.test^` reaches www.shop.test, so a user who chose to continue there and was stopped again next visit had been taught that trusting a site does nothing. The listing still stands for everyone else, and trusting a parent never excuses a listed subdomain
- **How often the list is fetched, and why the number lives in storage.** Six hours, which is REQ-13's cadence and the alarm's period — but the alarm cannot be trusted with it: `alarms.create` replaces an alarm of the same name, the background re-creates it on every start, and an MV3 worker starts on nearly **every page**, because a content script sends it a message. So a six-hour alarm on a browser in daily use is reset before it fires, and the start-time pull that exists to cover that had no due-check of its own. Until 2026-08-20 the product therefore made **one feed request per page**, each writing a row to `outbound_log` — the audit entry is mandatory before a request leaves — so the self-audit panel, the screen whose whole subject is what left this device, filled with `feed-update` and buried everything else. The feed now records its last **attempt** (attempt, not success: a failed pull that left no mark would be retried on the next wake-up, which is the flood again and only when something is already wrong) and skips a pull inside the window
- **Status:** implemented
- **Coverage:** packages/core-feeds/src/rules.ts:buildRules, packages/storage/src/retention.ts:dueForFeed, packages/ui/src/interstitial/interstitial.ts:renderInterstitial, apps/extension/src/interstitial/appeal-link.ts:appealLinkFor, apps/extension/src/interstitial/context.ts:settleContext, e2e/scn-007.spec.ts

### SCN-037: The block page refuses to be another page's iframe
- **Persona:** P-02
- **Feature:** web-guard
- **Traces:** ST-005, FLW-04 (JTBD-02, JRN-03/#2)
- **Entry point:** any site embeds `chrome-extension://<id>/interstitial.html` in an iframe
- **Preconditions:** none — the address is public by design, because the blocker redirects a tab to it and a web-accessible resource is reachable from every page
- **Steps:**
  1. A page puts the block page in an iframe by its fixed address -> on Chrome the browser refuses the load, because the resource answers only to a per-session address the page cannot learn
  2. Where that flag does not exist (Firefox), the page loads and notices it is not the top document, before it asks the background anything
  3. It draws one sentence and stops -> the sentence says this is an Okolos page and the site around it embedded it
- **Expected result:** the person is told what they are looking at, and there is no control of ours inside somebody else's layout
- **Alt paths:** the page is opened as a tab of its own, which is how a real block creates it -> it renders normally; a cross-origin parent makes reading `window.top` throw -> read as framed, because only a framed document can be denied its own top
- **UI elements:** one sentence in `#root`; no "Назад", no "Всё равно продолжить", no "Это мой сайт"
- **States covered:** success
- **Errors & recovery:** nothing to recover — the refusal makes no request, so there is no failure path to report
- **Behaviour notes:** **since 2026-08-21 there are two defences, and the outer one is the browser's.** `use_dynamic_url` on the resource (Chrome; Firefox has no such flag) means it answers only to a per-session address a page cannot learn, so an embed by the fixed address never loads — measured: the frame exists, its document is unreachable, nothing of ours runs. The refusal below is the inner defence, and it is what still holds on Firefox and if the manifest were ever changed back. **What an attacker gains is narrow and real, and it is the click rather than the text.** The page cannot be made to name an arbitrary site: it asks the background for the last block instead of reading its own query string, a decision that predates this scenario. But "Всё равно продолжить" records an exception for that address, so a click stolen by an overlay switches off a block the product had made. Refusing costs nothing, because in real use this document is always a tab of its own. **Detection is closed on Chrome and open on Firefox**, and that asymmetry is the flag's, not a choice: probing the fixed address no longer answers in Chrome (B-95), and Firefox has no equivalent
- **Status:** implemented
- **Coverage:** apps/extension/src/interstitial/framed.ts:isFramed, apps/extension/src/interstitial/index.ts, apps/extension/src/interstitial/framed.test.ts (three checks including the cross-origin throw), e2e/scn-037.spec.ts (the refusal, and the page still rendering as its own tab)

### SCN-008: ClickFix — page copies a command
- **Persona:** P-02
- **Feature:** web-guard
- **Traces:** ST-007, FLW-06 (JTBD-02, JRN-03/#3)
- **Entry point:** a script writes a shell-like payload to the clipboard without a genuine user copy action
- **Preconditions:** none — the hosting site is usually a legitimate compromised one
- **Steps:**
  1. User clicks the fake "verify you are human" control -> system detects the scripted clipboard write and shows a blocking warning
  2. User reads it -> system states in one sentence that a real verification never asks you to leave the browser, and shows the copied text verbatim
  3. User clicks "Leave page" -> system returns to the previous page
- **Expected result:** the user does not paste the command into a system dialog
- **Alt paths:** user clicks "I already ran it" -> system opens the recovery checklist for pasted commands; user dismisses -> dismissal requires a deliberate action and leaves a persistent marker on the page
- **UI elements:** blocking banner (clickfix variant), copied text block, "Leave page" (primary), "I already ran it", deliberate dismiss control
- **States covered:** success
- **Errors & recovery:** clipboard content cannot be read -> the warning still appears based on the write event and the page pattern, and says the content could not be displayed
- **Known limit — the wording is matched in two languages, English and Russian, and no others.** The page pattern rests on reading what the page says, so a campaign written in a third language passes clean. Russian was added on 2026-08-08 after a sweep found it missing: the watchlist ships `sberbank.ru` and `gosuslugi.ru`, so a Russian ClickFix page is not an evasion but the normal case for this audience. The clipboard payload itself is matched independently of language, and the scripted-copy signal has no language at all
- **Status:** implemented
- **Coverage:** packages/core-traps/src/clickfix.ts:detectClickFix, apps/extension/src/content/traps.ts:watchForTraps, e2e/scn-008.spec.ts

### SCN-009: Browser-lock trap escape
- **Persona:** P-02
- **Feature:** web-guard
- **Traces:** ST-008, FLW-07 (JTBD-02, JTBD-06)
- **Entry point:** a page forces fullscreen without a user gesture, or loops modal dialogs
- **Preconditions:** none
- **Steps:**
  1. User lands on the page -> system exits the forced fullscreen and suppresses the dialog loop
  2. User sees the banner -> system states plainly that the warning on the page is fake and no company is watching their computer
  3. User clicks "Close this page" -> system closes the tab or returns to the previous page
- **Expected result:** the user regains control of the window and does not call the number on screen
- **Alt paths:** user clicks "I already called them" -> system opens the recovery checklist for that case
- **UI elements:** banner (techsupport variant), "Close this page" (primary), "I already called them", dismiss
- **States covered:** success, error
- **Errors & recovery:** dialogs cannot be fully suppressed in this context -> system says so and directs the user to close the tab
- **Known limit — the page wording is matched in English and Russian, and no other language.** The two signals that carry no language at all are unaffected and are what a third-language page still rests on: a fullscreen nobody asked for, and dialogs that keep coming back. Russian was added on 2026-08-08 after a sweep found the pattern English-only, which for this product's audience meant a locked-screen scam passed clean
- **Status:** implemented
- **Coverage:** packages/core-traps/src/techsupport.ts:detectTechSupport, apps/extension/src/content/traps.ts:watchForTraps, e2e/scn-008.spec.ts

### SCN-011: Credential-entry guard on a new domain
- **Persona:** P-02
- **Feature:** web-guard
- **Traces:** ST-010, FLW-09 (JTBD-02, JRN-03/#4)
- **Entry point:** focus on a password or payment field on a domain that is neither trusted nor established
- **Preconditions:** the domain is not on the trusted list
- **Steps:**
  1. User focuses the password field -> system shows an inline warning beside the field, without covering it
  2. User clicks "Why" -> system states the domain's age, when it was first seen, and any brand similarity
  3. User clicks "Leave" -> system returns to the previous page
- **Expected result:** the user pauses before typing credentials into an unfamiliar domain
- **Alt paths:** user clicks "I trust this site" -> the domain is trusted and the warning is suppressed there on; user ignores it and types -> the warning stays visible but never blocks input
- **UI elements:** inline banner (credential variant), "Why", domain facts, "Leave", "I trust this site"
- **States covered:** success
- **Errors & recovery:** domain age data unavailable -> the warning states which facts are missing rather than implying the domain is new. Registration age is never looked up at all: asking a server would send the address of every login page the user visits
- **Behaviour notes:** this scenario is the form **on the page itself**. A form inside an embedded frame is SCN-034, and until 2026-08-20 it was covered by neither: the watcher stood under `if (isTopFrame)` and this entry did not say so, which is how a gap reads as covered
- **Status:** implemented
- **Coverage:** packages/core-credential/src/guard.ts:guardCredentialEntry, apps/extension/src/content/credential.ts:watchCredentialFields, e2e/scn-011.spec.ts

### SCN-034: A login form inside an embedded frame is checked
- **Persona:** P-02
- **Feature:** web-guard
- **Traces:** ST-010, FLW-09 (JTBD-02, JRN-03/#4)
- **Entry point:** focus on a password or payment field inside a frame the page embeds from another origin
- **Preconditions:** the frame's own domain is neither trusted nor established; the embedding page itself raises nothing
- **Steps:**
  1. User clicks into the password field inside the frame -> the watcher runs **in that frame** and asks what this device knows about the frame's own domain, not the page's
  2. The frame has facts to state -> it hands them to the page that embeds it as keys, and draws nothing itself
  3. The top frame shows one warning, naming the frame's domain -> "before you type a password here" and "before you type a password into a form from g00gle.com" are different sentences, and only the second says whose form it is
- **Expected result:** the ordinary shape — an OAuth or payment form in an iframe — is checked, and the person sees the warning on the page they are looking at
- **Alt paths:** user clicks "Это неверно" -> the **frame's** domain is trusted, because that is the domain the warning is about; user clicks "Уйти со страницы" -> the top frame goes back, which is what leaving a page carrying that form means; a banner is already up for a worse finding -> this becomes a line on it rather than a second panel (the slot rule, SCN-031)
- **UI elements:** in-page banner (credential variant) in the **top** frame, headline naming the frame's domain, the domain's facts, "Уйти со страницы", "Это неверно", "Скрыть"
- **States covered:** success
- **Errors & recovery:** the top frame's content script has not started yet -> the frame retries, twelve attempts 750 ms apart, then journals `credential-unreported` naming the count and the duration, because a password warning that silently failed to arrive is worse than one that says so; a frame with no address of its own (`srcdoc`, `about:blank`) -> the banner says "встроенный фрейм без собственного адреса" and the trust control only hides the warning, because there is no domain to record a decision about
- **Behaviour notes:** the frame reports and never draws, and both halves are deliberate. A banner inside a 300x200 frame is clipped and inside a hidden ad frame warns nobody — so drawing there is not warning. **The facts travel, not the sentence:** the frame sends catalogue keys and their arguments, and the surface that draws owns the words, which is the same rule the journal follows (B-75, B-77) and the reason one wording module serves both surfaces. **The domain the warning names comes from the origin the background stamped, never from a field the frame filled in:** the frame is the thing being reported on, so a frame that could name itself could name somebody else — and the trust control acts on that stamped domain for the same reason. **Until 2026-08-20 nothing watched this at all** (B-79): `watchCredentialFields` stood under `if (isTopFrame)` while the comment above it claimed a subframe's form "is warned about by the frame it is in", which that very condition prevented
- **Status:** implemented
- **Coverage:** apps/extension/src/content/index.ts:tellEmbeddingPageOfPassword and showFrameCredential, apps/extension/src/content/credential.ts:watchCredentialFields (the `report` seam), apps/extension/src/content/credential-words.ts:credentialLines, packages/contracts/src/rpc.ts:FrameFinding, apps/extension/src/background/index.ts:relayFrameFinding, e2e/scn-034.spec.ts, apps/extension/src/content/credential.test.ts (the frame path), apps/extension/src/content/credential-words.test.ts

### SCN-012: Download stopped by feed or hash
- **Persona:** P-01
- **Feature:** web-guard
- **Traces:** ST-009, FLW-08 (JTBD-02)
- **Entry point:** a download starts from a page or a direct link
- **Preconditions:** feeds fresh; the file's source or hash matches a known-bad entry
- **Steps:**
  1. User starts the download -> system checks the final URL against the feeds before the file is saved
  2. User sees the blocking warning -> system names what matched and when that entry was published
  3. User clicks "Discard file" -> system cancels the download and journals it
- **Expected result:** the dangerous file never reaches the disk
- **Alt paths:** user clicks "Keep anyway" -> the download proceeds and the exception is journalled
- **UI elements:** blocking banner (download variant), matched-source line, "Discard file" (primary), "Keep anyway"
- **States covered:** success, error
- **Errors & recovery:** feeds unavailable or stale -> system says the checks were limited; the verdict never claims more than the checks that actually ran
- **The hash check does not exist, and the verdict says so rather than the matrix pretending otherwise.** `hash: { ran: false, why: 'downloadNotWritten' }` — the check sits between the browser creating the item and the bytes landing, so there is no file to hash. Row 2.2 of the coverage matrix carried a **tick** on this until 2026-08-20 while nothing in the tree computed a digest (B-57); it is unmarked now, and a tick anywhere in that matrix has to name a file that exists. Recomputing over re-downloaded bytes would mean fetching a possibly-malicious file a second time and becoming a second client of the same host; looking a digest up at MalwareBazaar or VirusTotal would send the hash of a user's file off the device, which `docs/privacy.md` promises it does not, and would need an API key inside a client
- **Both addresses are checked, not whichever one was to hand.** A redirect is the ordinary way a malicious file is served — the link a page carries is a shortener nobody lists and the host it lands on is the one in the feed — and the reputation check read `item.url` alone while the matrix promised `finalUrl`. Either address being listed is enough now, and an ordinary CDN redirect is still ordinary. Firefox has no `finalUrl`, and its absence does not turn the check off
- **The name and the type are compared in both directions.** It fired one way round only: a name that looks executable while the site sends it as a document. The commoner shape — `invoice.pdf` served as `application/x-msdownload` — passed silently. `application/octet-stream` counts only against a document-shaped name, because half the web sends it for anything it cannot classify
- **The verdict travels as codes and is worded on the surface.** `judgeDownload` returned five English headlines and five English shape sentences from a zero-dependency package, and the background joined them and sent the English across the RPC — so the banner a person read was written where the catalogue is not (B-75). It now carries `headline` and `shape` as codes with the values their sentences need, and `apps/extension/src/content/download.ts` resolves them through `*_KEY` tables. `reasons` deliberately stays words: those come from the checks, and whoever ran them had already resolved them
- **Status:** implemented
- **What "a program" means here:** the list of extensions in `judge.ts`, and it is a coverage claim. It held 18 entries until 2026-08-08 with no Windows script or control-panel formats and no macro-enabled Office documents — the commonest malicious attachment there is. Membership never blocks; it produces "this is a program, and not every check could be run on it", and it is also the gate on the double-extension check, so a missing extension made `счёт.pdf.wsf` read as an ordinary file. `.html` and `.svg` stay out deliberately: a saved page is the most ordinary download there is, and a note on every one of them teaches people to ignore the notes
- **Known limit:** the banner goes to the tab the user is looking at, because a `DownloadItem` carries no tab id — so a download begun in a background tab, from a bookmark, or in a tab that has since navigated gets no banner, and the journal is the record. **When that happens the journal now says so:** "the verdict was not shown" and "the check did not run" read identically otherwise. **Until 2026-08-19 no download ever got a banner at all** — the verdict was sent with `runtime.send`, which from a background context reaches the extension's own pages and never a content script, so a 76-line module with nine tests could not run in the product and REQ-19's promise of a warning before the file is saved was a journal entry nobody had reason to open
- **Coverage:** packages/core-download/src/judge.ts:judgeDownload, apps/extension/src/background/downloads.ts:handleDownload, apps/extension/src/content/download.ts:showDownloadVerdict, packages/platform/src/adapter.ts:sendToActive (unit only — driving a real download through an extension in Playwright is not stable enough to gate on; the channel itself is covered by five tests in packages/platform/src/adapter.test.ts and by the channel rule in tools/test-quality.test.ts)

### SCN-013: Download partially checked — hash unavailable
- **Persona:** P-01
- **Feature:** web-guard
- **Traces:** ST-009, FLW-08 (JTBD-02, JTBD-05)
- **Entry point:** a download behind authentication, or one whose bytes cannot be re-fetched
- **Preconditions:** URL checks pass; the hash cannot be computed
- **Steps:**
  1. User starts the download -> system runs URL and file-type checks and cannot obtain a hash
  2. User sees an informational banner -> system states exactly which checks ran, which did not, and why
  3. User keeps the file -> system journals the partial verdict
- **Expected result:** the user is never given a clean verdict that the product did not actually earn
- **Alt paths:** file type is executable with a mismatched MIME or a double extension -> the banner escalates to a warning naming that specific reason
- **UI elements:** informational banner (download variant), "checks that ran" list, "checks that did not run" list with reasons
- **States covered:** success, error
- **Errors & recovery:** all checks fail -> the verdict says the file was not checked at all
- **Status:** implemented
- **Coverage:** packages/core-download/src/judge.ts:judgeDownload, apps/extension/src/background/downloads.test.ts (unit only, as SCN-012)

## credentials

### SCN-014: Submitted password is compromised
- **Persona:** P-01
- **Feature:** credentials
- **Traces:** ST-011, FLW-10 (JTBD-04, JTBD-05, JRN-02/#1)
- **Entry point:** a password field is submitted on any site
- **Preconditions:** local corpus loaded
- **Steps:**
  1. User submits a login form -> system hashes the password inside the page context and checks the local corpus first
  2. User sees the banner -> system states the password appears in known leaks and how the check was performed
  3. User clicks "Change password" -> system opens the site's change-password endpoint. **Until 2026-08-20 this step described a control that did nothing** (B-80): the in-page banner's four handlers all returned `undefined`, because a content script cannot open a tab — `chrome.tabs` is not in its API surface — and the failure was silent, so the scenario read as covered. The banner now asks the background, which composes the address itself
- **Expected result:** the user learns the password is compromised, and no password or full hash ever left the device
- **Alt paths:** not found locally -> system performs a padded k-anonymity query with a 5-character prefix and shows the result; user clicks "Where else do I use it" -> **not built**: there is no local reuse index, and the control was removed rather than left answering from nothing (see SCN-016)
- **UI elements:** banner (password variant), "how this was checked" line, "Change password" (primary), "Where else do I use it", "This is wrong"
- **States covered:** success, error
- **Errors & recovery:** network unavailable during the k-anonymity step -> system reports the local-only result and says the online check did not run; the journal records the prefix sent, or that nothing was sent. **And when the digest itself cannot be taken, the journal says that too** — which it did not until 2026-08-20: the hash came from `crypto.subtle`, which is `[SecureContext]`, and the manifest matches plain-HTTP pages, so on every one of them the digest threw and a silent `catch` swallowed it. **The breach and reuse check simply did not run**, on exactly the pages where a password sent in the clear matters most, and a check that did not run was indistinguishable from a password that came back clean
- **The digest is the product's own, and that is a portability decision rather than a cryptographic one.** SHA-1 is chosen by Have I Been Pwned's range protocol, not by us; only five characters of it leave the device, and the property SHA-1 has lost — collision resistance — is one nothing here depends on. `packages/core-credential/src/sha1.ts` is checked against the FIPS 180-4 vectors *and* against the platform's own `crypto.subtle` digest on twelve inputs including the padding boundaries and non-ASCII, so "the same answer with one fewer requirement" is a test rather than a hope
- **Status:** implemented
- **Behaviour notes:** this scenario is the form **on the page itself**. A form inside an embedded frame is SCN-035, and until 2026-08-20 it was covered by neither: the submit listener stood under `if (isTopFrame)` and this entry did not say so
- **The navigation the submission causes no longer loses the verdict (B-82, closed 2026-08-20).** The check runs after submission, deliberately, and a form with an `action` takes the document with it while the check is in flight. The verdict is now **recorded before any delivery is attempted** and **held for the tab**, and the page the login lands on both asks for it and is pushed it — SCN-036 is that path. Until then nothing was shown and nothing was recorded at all
- **Coverage:** apps/extension/src/background/password.ts:checkSubmittedPassword, apps/extension/src/background/index.ts:openChangePassword, packages/core-credential/src/change-url.ts:changePasswordUrl, packages/core-credential/src/guard.ts:guardCredentialEntry, packages/core-credential/src/sha1.ts:sha1Hex, packages/net/src/request.ts:request (unit only for the range query — a real password submission in Playwright would have to carry a real credential, so the k-anonymity path is exercised against a stubbed range endpoint; the offline path is end-to-end in e2e/scn-035.spec.ts, whose fixture submits a password from the shipped common list)

### SCN-035: A password submitted from an embedded frame is checked
- **Persona:** P-01
- **Feature:** credentials
- **Traces:** ST-011, FLW-10 (JTBD-04, JTBD-05, JRN-02/#1)
- **Entry point:** a login form inside a frame the page embeds from another origin is submitted
- **Preconditions:** local corpus loaded; the frame's own site is the one that receives the password
- **Steps:**
  1. User submits the form inside the frame -> the digest is taken **in that frame**, and the host that travels with it is the frame's own: the frame's site is the one that received the password, and the one "where else do I use this" has to be answered about
  2. The verdict says the password is in a breach -> the frame hands the two facts upward as catalogue keys and draws nothing itself
  3. The top frame shows one warning naming the frame's site -> "this password has appeared in a breach" and "the password sent to sso.partner.test has appeared in a breach" are different sentences, and only the second says which login is affected
  4. User clicks "Сменить пароль" -> the background opens that site's own change-password page
- **Expected result:** a password typed into the ordinary shape of a login — an OAuth or payment form in an iframe — is checked, and the person can act on the verdict from the page they are looking at
- **Alt paths:** the pause before the password is already up for the same frame -> the leak verdict is `major` against the pause's `minor`, so it takes the one panel and the pause becomes a line on it (the slot rule, SCN-031); the password is not in a breach -> nothing is shown, and the pause, if it was up, stays where it is
- **UI elements:** in-page banner (password variant) in the **top** frame, headline naming the frame's site, the verdict and the reuse line, "Сменить пароль" (primary), "Это неверно", "Скрыть"
- **States covered:** success
- **Errors & recovery:** the top frame's content script has not started yet -> the frame retries, twelve attempts 750 ms apart, then journals `password-unreported` naming the count and the duration; the frame has no address of its own (`srcdoc`, `about:blank`) -> there is no site whose change-password page could be opened, so the primary offers the journal instead of a button that would navigate to `https:///…` and fail silently; the digest cannot be taken -> `password-unchecked` in the journal, as on the page's own form
- **A form that navigates is SCN-036, not this scenario (B-82, closed 2026-08-20).** Submitting a form with an `action` tears down the frame's content script while the check is in flight; the verdict is now recorded and held for the tab rather than lost, and the landing page picks it up. The end-to-end fixture here deliberately submits a form that **stays** on the page — the common modern shape, and the honest limit of what this spec proves on its own
- **Behaviour notes:** the frame reports and never draws, for the reason SCN-034 gives. **The address the primary opens is composed by the background from the origin it stamped itself**, and the content script may ask only for a host — `packages/core-credential/src/change-url.ts` refuses a host that would hand the authority elsewhere (`good.test@evil.test` loads `evil.test` while the banner says `good.test`), and the published `/.well-known/change-password` path has one definition rather than one per caller. **Two defects met here** (B-80): the check itself stood under `if (isTopFrame)`, so a password submitted from an iframe was never compared against a breach and never counted towards reuse; and the banner it would have drawn had four handlers that all returned `undefined`, so its primary was a label with nothing behind it — invisible because a content script's `chrome.tabs` call rejects and nobody was listening
- **Status:** implemented
- **Coverage:** apps/extension/src/content/index.ts:tellEmbeddingPageOfLeak, showFramePassword and claimPasswordBanner, apps/extension/src/content/password-words.ts:passwordLines, packages/contracts/src/rpc.ts:FrameFinding (the `password` kind) and `password/change`, apps/extension/src/background/index.ts:openChangePassword, packages/core-credential/src/change-url.ts:changePasswordUrl, e2e/scn-035.spec.ts (three checks, including the address the primary requests), apps/extension/src/content/password-words.test.ts, packages/core-credential/src/change-url.test.ts

### SCN-036: A verdict survives the navigation the submission caused
- **Persona:** P-01
- **Feature:** credentials
- **Traces:** ST-011, FLW-10 (JTBD-04, JTBD-05, JRN-02/#1)
- **Entry point:** a login form with an `action` is submitted, and the page navigates
- **Preconditions:** local corpus loaded
- **Steps:**
  1. User submits the form -> the digest is taken and the check is asked for, after the submission and by design: interrupting a login somebody was going to finish is worse than saying it afterwards
  2. The page navigates -> the document that asked is gone, and with it the surface that would have drawn the answer
  3. The verdict comes back compromised -> it is **written to the journal first**, because the fact is true whether or not anybody sees it, then held for the tab
  4. The page the login landed on shows it -> that document asks for a held verdict as it starts, and the background also offers it once the moment it exists
  5. User clicks "Сменить пароль" -> the background opens the change-password page of the site the password was sent to, not of the page they are now on
- **Expected result:** the person learns their password is in a breach on the page they are actually looking at, and the fact is on record even if they never see it
- **Alt paths:** the answer beats the navigation -> the form's own page draws the banner; if it then navigates within a second and a half, `pagehide` withholds the confirmation and the landing page shows it again, and if it does not, the confirmation is sent and it is not shown twice; the person dismisses it -> the held copy is released and no later page repeats it; nobody ever draws it -> the held copy expires after a minute and the journal row remains
- **UI elements:** in-page banner (password variant) on the landing page, headline naming the site the password was sent to, "Сменить пароль", "Это неверно", "Скрыть"; the journal row on SCR-08
- **States covered:** success
- **Errors & recovery:** the journal cannot be written -> the answer still returns and the surface still draws; nothing claims a record that was not made. The held copy cannot be written -> the form's own page still shows whatever it received
- **Behaviour notes:** **the verdict is offered both ways, and each direction covers what the other misses.** A document that starts *before* the check answers is told nothing when it asks; a document that starts *after* it has nothing pushed to it, because there was nobody to push to. Measured by removing each: with no question asked, this scenario failed in every one of three runs; with no push, one run in three. **Neither is a retry loop, and that is deliberate** — the first version pushed twelve times over nine seconds from the service worker, and a service worker is torn down when the browser decides, which made a security warning arrive *most* of the time. **The confirmation is what releases the held copy, and when it is sent decides whether this works at all:** sent the instant the banner was claimed, it was a lie — the document already navigating away drew a banner nobody could read and then reported success, so the landing page showed nothing. It now waits for the panel to still be there a moment later, and `pagehide` cancels it whenever the document is genuinely leaving
- **Status:** implemented
- **Coverage:** apps/extension/src/background/index.ts:handlePasswordCheck (journal + hold + push), apps/extension/src/background/pending-password.ts:holdVerdict/takeVerdict/releaseVerdict, apps/extension/src/content/index.ts:showPasswordVerdict and the `password/pending` question, packages/contracts/src/rpc.ts:PasswordAnswer, e2e/scn-036.spec.ts (four checks, including the journal row read through the screen a person uses), apps/extension/src/background/pending-password.test.ts (nine)

### SCN-015: Leak inventory with one source unavailable
- **Persona:** P-01
- **Feature:** credentials
- **Traces:** ST-012, FLW-11 (JTBD-04, JRN-02/#2-3)
- **Entry point:** the leaks screen, with at least one monitored email or phone
- **Preconditions:** at least one source configured
- **Steps:**
  1. User opens the leaks screen -> system queries each source and shows partial results as they arrive
  2. User sees results split into fresh infostealer hits and historical breaches -> system shows data classes, dates, and the source for each entry
  3. User reads the coverage line -> system names every source checked, every source that failed, and when each was last updated
- **Expected result:** the user knows what is exposed and, equally, what was not checked
- **Alt paths:** pressing Check now with an empty or malformed address -> the panel **states the refusal** and keeps the control, rather than redrawing identically; no sources configured -> the empty state prompts to add an email or phone and states exactly what will and will not be sent — **and what is sent is the address itself**: Hudson Rock's Cavalier and HIBP's breached-account endpoint answer to nothing less, so the leak check is not k-anonymous and the empty state may not imply that it is (the password check is a separate, k-anonymous one)
- **UI elements:** monitored sources list, results grouped fresh/historical, per-entry data classes, coverage line, per-source retry
- **States covered:** loading, empty, error, success
- **Errors & recovery:** a source is unreachable or rate-limited -> that row states unavailable with a retry; results from other sources stand and the summary never implies full coverage
- **Status:** implemented
- **Coverage:** apps/extension/src/options/keep-focus.ts:keepingFocus (typing survives a repaint — focus and caret, not only the value), packages/core-leaks/src/merge.ts:mergeLeaks, packages/core-leaks/src/group.ts:groupLeaks, packages/ui/src/leaks/leaks.ts:renderLeaks, e2e/scn-015.spec.ts

### SCN-016: Repair a leak and mark it resolved
- **Persona:** P-01
- **Feature:** credentials
- **Traces:** ST-015, ST-012, FLW-11 (JTBD-04, JRN-02/#4-6)
- **Entry point:** a leak entry in the queue or the leaks screen
- **Preconditions:** at least one unresolved leak
- **Steps:**
  1. User opens the entry -> system shows what leaked, when, from where, and at most three next steps
  2. User clicks "Change password" -> system opens the site's change-password endpoint in a new tab
  3. User returns and clicks "Mark resolved" -> system archives the entry and removes it from the active queue
- **Expected result:** the leak leaves the active list only when the user says the repair is done
- **Alt paths:** user clicks "Not now" -> the entry stays and is not re-raised as new. **"Check reuse" was removed on 2026-08-08:** it opened `options.html#reuse=`, a hash nothing read, and behind it was meant to be a local index of which sites had seen which password hash. No such store was ever built. Answering "none found" from an index that does not exist is the one wrong answer this panel must never give, so the control is gone until the index is
- **UI elements:** leak entry, data classes, next-step buttons, "Mark resolved", "Not now", archive
- **States covered:** success, error
- **Errors & recovery:** the site publishes no change-password endpoint -> system opens the site's login page and says the shortcut is unavailable for this site
- **Status:** implemented
- **Coverage:** packages/core-leaks/src/merge.ts:mergeLeaks, packages/core-recovery/src/checklist.ts:buildChecklist, packages/ui/src/leaks/leaks.ts:renderLeaks (unit only — the repair step leaves the browser, so the e2e can watch the item clear but not the repair itself)

## extensions

### SCN-017: Extension gained permissions — disable it
- **Persona:** P-01
- **Feature:** extensions
- **Traces:** ST-013, ST-014, FLW-12 (JTBD-03)
- **Entry point:** an installed extension updates and its permissions differ from the last snapshot
- **Preconditions:** a baseline snapshot exists
- **Steps:**
  1. System detects the delta -> the extensions screen surfaces it at the top and the toolbar badge increments
  2. User opens the delta -> system lists permissions added and removed, the version dates, and the publisher
  3. User clicks "Disable" -> system disables the extension and journals the action
- **Expected result:** a permission escalation is seen and handled the day it happens, and a removed extension is reported once — `db.delete('snapshots')` appeared nowhere in the repository until 2026-08-20, so "no longer installed" was raised on every run for the rest of the profile's life, naming the extension by its id because its name was never stored
- **Alt paths:** user clicks "Trust this change" -> the delta is acknowledged and the baseline updated, and it is not raised again
- **What a removed extension may be offered, and what it may not.** "Отключить его" was on that row too until 2026-08-21, for an extension the browser no longer has: the call fails, and the screen met a person's remedy with an error for a problem the remedy never fitted. Acknowledging is the whole of it there, and acknowledging *does* the right thing — `acceptInventoryChange` deletes the snapshot when the extension is gone rather than writing an exception nothing reads, which is the failure this scenario already records for the domain-scope case
- **UI elements:** deltas section, permission diff list, version dates, publisher, "Disable" (primary), "Trust this change", "Inspect package"
- **States covered:** loading, success, error
- **Errors & recovery:** the extension cannot be disabled (policy-installed) -> system says why **on the page** and offers the manual steps. It used to say it in a browser modal, which blocks the page, cannot carry the brand pack's sentence and reads as the browser failing rather than as this product answering (B-107); the failure slot is one slot, replaced rather than appended, the same rule SCN-023 and SCN-024 record. **Known limit:** the slot itself is unit-tested and the absence of modals is gated, but no end-to-end test reaches this path — the only extension a test browser has installed is this one, and a spec that disabled it would be disabling the thing under test
- **What the alt path promised and did not do, until 2026-08-20.** "Trust this change" wrote an `exceptions` row with `scope: 'extension'` and **nothing in the repository read it** — both readers filter for `scope === 'domain'`, correctly, since they build blocking rules and the trusted-domain list. The delta came back the next time the screen opened and the button was decoration. Acknowledging now means one thing and it is the thing the sentence above says: the stored state becomes the current one, for that extension alone
- **Reading never writes; only a decision writes.** The comparison used to record the new state as the baseline, and three callers ran it — the daily alarm, the extensions screen, and **the area counter on the overview**. The counter and the screen share one handler, so whichever ran first consumed the difference: the counter said there were changes and the screen, opened half a second later, said there were none. A delta is now an unacknowledged fact, like a finding, and it keeps being reported until the user accepts it or disables the extension. Two consequences the user sees: the number and the screen always agree, and the same change is journalled **once** rather than once per visit
- **Known limit — a snapshot taken before 2026-08-20 records less than the comparison needs.** Host permissions, the extension's name and its enabled state were not stored. A row without host permissions means *unknown*, and unknown is not compared against — read as an empty list, every extension holding host access looked as though it had just been granted it, `host-access-widened` at severity `critical`, on **every run for the life of the profile**. The one finding on this screen a user should never ignore was the one it always showed. Such a row still reports what it does record, and gains the missing fields the first time the user accepts anything about that extension
- **Status:** implemented
- **Coverage:** packages/core-extensions/src/diff.ts:diffInventory, apps/extension/src/background/extensions.ts:compareInventory, packages/ui/src/extensions/extensions.ts:renderExtensions, e2e/scn-017.spec.ts

### SCN-018: Extension changed publisher, package unavailable
- **Persona:** P-01
- **Feature:** extensions
- **Traces:** ST-013, FLW-12 (JTBD-03)
- **Entry point:** store metadata shows a different publisher than the last snapshot
- **Preconditions:** the extension package cannot be fetched for static analysis
- **Steps:**
  1. System detects the publisher change -> the extensions screen raises it as a high-severity delta
  2. User opens it -> system shows the old and new publisher, the change date, and states that package analysis is unavailable and why
  3. User clicks "Disable" -> system disables the extension and journals it
- **Expected result:** the ownership change is actionable even when deeper analysis is impossible
- **Alt paths:** package becomes available later -> system adds the static findings to the same entry without re-alerting
- **UI elements:** delta entry, publisher before/after, "analysis unavailable" reason, "Disable", "Trust this change"
- **States covered:** error, success
- **Errors & recovery:** store metadata itself is unreachable -> system states that the publisher could not be verified and keeps the previous baseline rather than assuming a change
- **Status:** implemented
- **What the analyser reads, and what it did not:** until 2026-08-08 it read remote code, `eval`, hex escapes, endpoints and cookie or token access. It did not read the powers an extension can hold — `chrome.debugger`, which drives the browser through the devtools protocol; `chrome.runtime.connectNative`, which runs code outside the browser; traffic rewriting through `declarativeNetRequest` or `chrome.proxy` — nor bulk reads of history, bookmarks and identity, nor `atob`/`fromCharCode`, nor a `wss:` socket, which meant an exfiltration channel was the one endpoint the endpoints list could not contain. All of it is a fact about the text and none of it is a verdict; the report says so
- **Coverage:** packages/core-extensions/src/analyse.ts:analysePackage, packages/ui/src/extensions/extensions.ts:renderExtensions, e2e/scn-017.spec.ts

## privacy

### SCN-019: Verify what left the device
- **Persona:** P-01
- **Feature:** privacy
- **Traces:** ST-017, FLW-13 (JTBD-05, JRN-01/#7)
- **Entry point:** "What did you send?" from the popup, settings, or any finding
- **Preconditions:** none
- **Steps:**
  1. User opens the self-audit panel -> system shows a one-line weekly summary and the outbound log, newest first
  2. User opens a row -> system shows destination, purpose, the exact payload sent, and what was redacted
  3. User clicks "Export log" -> system produces a JSON file the user can compare against a browser network trace
- **Expected result:** the user can state what left the device this week, from the product's own records, and verify it independently
- **What a fresh install shows:** one entry — the blocking feed being downloaded, with its purpose in plain words, `none` as the payload and `alarm:feeds` as the trigger. Until 2026-08-08 it showed the sentence "nothing has been sent", and that was true only because nothing fetched a feed: the block list was empty on every install, so the panel's honesty rested on the product doing nothing
- **Alt paths:** nothing was sent -> the empty state says so explicitly rather than showing an empty table
- **UI elements:** summary line, labelled log rows (time, destination, purpose, payload shape, trigger) that open onto what the purpose sends and holds back, a two-position period control, "Export log"
- **States covered:** loading, empty, error, success
- **What the summary may say, and what it may not.** The weekly line names no absence it cannot prove. Until 2026-08-21 it asserted unconditionally that no request carried an email — while `docs/brand/facts.md` says in its own table that `leak-lookup` sends the address and `domain-status` sends the domain, so a list containing exactly such a request sat under a sentence denying it exists. False privacy claims are the one failure this screen cannot survive. Now: the unconditional half is what the choke point keeps (no page address, no page content), what did leave is named per purpose, and a purpose this build cannot read drops the absence claim and says so. The window is applied as well as worded — the panel takes the boundary as an instant, where it used to be handed all ninety days of retention under the words "the last seven"
- **Errors & recovery:** the journal is unreadable -> system states the storage problem and offers repair; it never renders an empty log on error, because an empty log is a claim; **a row the store wrote incompletely** -> each missing field names itself and the row is kept, because on this screen hiding a row is the dangerous direction, and it printed `источник: undefined` until 2026-08-21; **the device runs out of room** -> the audit entry cannot be written, so nothing is sent — the guarantee working, not a fault — and the extension sweeps records past their retention window once and retries. Whether that made room or not is written to the journal in plain words, because a full device otherwise stops every network feature at once and reports it feature by feature as 'that source was unavailable'
- **Status:** implemented
- **Coverage:** packages/ui/src/self-audit/panel.ts:renderSelfAudit, apps/extension/src/options/index.ts, e2e/scn-019.spec.ts, e2e/rendered-instants.spec.ts — step 2 built 2026-08-21: a row is a native disclosure, and what is behind it is what the log holds. **"The exact payload sent" is deliberately not among it** — the address is redacted where it is written, so the detail names what that purpose sends and what it holds back, plus the outcome in words. The period is a two-position control; a filter by feature and grouping by purpose were dropped with reasons recorded in SCR-10 (B-101)

### SCN-023: Wipe all local data
- **Persona:** P-01
- **Feature:** privacy
- **Traces:** ST-019, FLW-14 (JTBD-05)
- **Entry point:** settings screen
- **Preconditions:** local data exists
- **Steps:**
  1. User clicks "Wipe all data" -> system asks for confirmation and lists exactly what will be deleted — **one kind per store, nine of them.** The word "exactly" was here before the list was: the confirmation named five while `wipeAll` cleared nine, so `models`, `feeds`, `snapshots` and the password-reuse index went unmentioned and the user agreed to five while nine went. Safe in direction, and still a confirmation that had not asked. Completeness now lives in `DATA_KIND_KEY: Record<StoreName, string>`, so a new store fails the build until the dialog has words for it
  2. User confirms -> system deletes all local data
  3. User sees the result -> system returns the extension to its first-run state
- **Expected result:** nothing of the user's remains locally, in one confirmed step
- **Alt paths:** user cancels -> nothing changes
- **UI elements:** "Wipe all data" (destructive), confirmation listing data categories, cancel
- **States covered:** success, error
- **Errors & recovery:** deletion partially fails -> system names what could not be deleted and offers retry; it never reports success on a partial wipe. **A wipe that could not start says that instead**, and says it differently: the handler opens the database first, so "could not open" is the ordinary failure — and it used to be silence. `void run()` swallowed the rejection with the confirmation already dismissed, so the user clicked "yes, delete it", the dialog vanished, nothing was deleted, and a dialog vanishing is what success looks like on this screen. The two failures are reported apart because they are different facts: a partial wipe leaves some of the user's data gone and names which, a wipe that never began leaves all of it, and naming stores that were never touched would invent a state
- **One answer on the screen, whatever the clicking.** The failure note and the retry are single slots, not appended lines: the first version removed the old note before its `await` and appended the new one after, so three clicks on a failing action produced three identical lines. A success takes both the note and the retry away, because a retry button beside a first-run screen invites a second wipe of nothing
- **Status:** implemented
- **Coverage:** packages/ui/src/settings/data-controls.ts:renderDataControls, apps/extension/src/options/index.ts, **e2e/scn-023.spec.ts** — the gate REQ-32 named since 2026-08-04 and which **did not exist** until 2026-08-20: three checks over a profile seeded into all nine stores, asserting that the confirmation names one kind per store, that every store is emptied, that cancelling changes nothing, and that the first click asks rather than deletes. The failure paths stay unit tests, because nothing in a browser makes IndexedDB refuse on request

### SCN-024: Export all local data
- **Persona:** P-01
- **Feature:** privacy
- **Traces:** ST-019, FLW-14 (JTBD-05)
- **Entry point:** settings screen
- **Preconditions:** local data exists
- **Steps:**
  1. User clicks "Export all data" -> system produces a JSON file containing findings, journal, settings, and the outbound log
  2. User saves the file -> system confirms and states what the file contains
- **Expected result:** the user holds a complete, readable copy of everything the product stored
- **Alt paths:** none
- **UI elements:** "Export all data" (primary), completion confirmation with contents list
- **States covered:** success, error
- **Errors & recovery:** export fails -> inline failure naming the reason; no partial file is left behind. **This was a promise the screen did not keep until 2026-08-20:** the click was `() => void handlers.onExport()`, so a rejected export did nothing and said nothing. Export needs no confirmation because nothing is lost — which is a reason to skip the question, not a reason to skip the answer. The failure is one slot, replaced rather than appended, and it comes down when a later export works
- **Known limit — the retry is the button itself.** There is no separate "try again" for export, unlike the wipe: pressing "Export all data" again *is* the retry, and the stale failure clears when it succeeds. Recorded so the absence is a decision
- **Status:** implemented
- **Coverage:** packages/ui/src/settings/data-controls.ts:renderDataControls, apps/extension/src/options/index.ts — PARTIAL: unit-tested including the rejected-export path; the download itself is not yet asserted end-to-end, because a Chromium download in a persistent-context extension test writes to a real path and the assertion would be about Playwright's plumbing rather than the product

## daily-use

### SCN-020: Popup — verdict for the current page
- **Persona:** P-01
- **Feature:** daily-use
- **Traces:** ST-015, FLW-17 (JTBD-02)
- **Entry point:** toolbar icon clicked
- **Preconditions:** a page is open
- **Steps:**
  1. User clicks the toolbar icon -> system shows the current page's verdict with the reason behind it
  2. User reads the "what changed" count -> system shows up to three queued actions beneath it
  3. User closes the popup -> system records the check time
- **Expected result:** in about three seconds the user knows whether this page is fine and whether anything needs them
- **Alt paths:** verdict still computing -> the popup shows "checking this page" rather than a blank or a premature clean verdict
- **UI elements:** verdict line with reason, "what changed" count, up to 3 actions, footer links (Self-audit, Journal, Settings)
- **States covered:** loading, empty, error, success
- **Errors & recovery:** local storage unreadable -> the popup states the failure and offers repair; it never shows a clean verdict it could not compute; the active page cannot be identified -> the verdict is `unknown`, never `clean`
- **Status:** implemented
- **Coverage:** apps/extension/src/popup/state.ts:toQueueItems, packages/ui/src/popup/popup.ts:renderPopup, e2e/scn-020.spec.ts

### SCN-021: What changed since last time
- **Persona:** P-01
- **Feature:** daily-use
- **Traces:** ST-015, FLW-17 (JTBD-04, JRN-02/#6)
- **Entry point:** "what changed" from the popup
- **Preconditions:** at least one previous check
- **Steps:**
  1. User opens the diff view -> system shows only what is new since the last check, grouped by type
  2. User opens an entry -> system shows the verdict, the action taken, and whether it was automatic
  3. User returns -> system marks this moment as the new baseline
- **Expected result:** the user sees a short list of changes, never a growing wall of old alerts
- **Alt paths:** nothing changed -> the empty state says so with the time of the last check; user switches to full history -> system shows everything within the retention period
- **UI elements:** diff list grouped by type, entry detail, full-history toggle, retention statement
- **States covered:** empty, success
- **Errors & recovery:** journal partially unreadable -> system shows what it can and states that the view is incomplete
- **Status:** implemented
- **Coverage:** packages/core-queue/src/diff.ts:diffSince, packages/ui/src/journal/journal.ts:renderJournal, e2e/scn-020.spec.ts

### SCN-022: Queue never exceeds three actions
- **Persona:** P-01
- **Feature:** daily-use
- **Traces:** ST-015, FLW-01 (JTBD-04, JTBD-06)
- **Entry point:** findings queue with many outstanding items
- **Preconditions:** more than three unresolved findings
- **Steps:**
  1. User opens the queue -> system shows exactly three items, ranked by severity, freshness, and how easily they can be fixed
  2. User resolves the top item -> system removes it and promotes the next one
  3. User clicks "Show all" -> system reveals the remaining items in a collapsed list
- **Expected result:** the user always faces a finishable list, and the product never presents 203 alerts as progress
- **Alt paths:** fewer than three items -> only those are shown, with no filler
- **UI elements:** three prioritised items, per-item action, "Show all", resolved state
- **States covered:** empty, success
- **Errors & recovery:** the ranking data is incomplete -> items are ordered by severity alone and the UI states the reduced ranking
- **Status:** implemented
- **Coverage:** packages/core-queue/src/rank.ts:buildQueue, packages/ui/src/popup/popup.ts:renderPopup, e2e/scn-020.spec.ts

### SCN-027: Dashboard overview — what needs me, across areas
- **Persona:** P-01
- **Feature:** daily-use
- **Traces:** ST-015, FLW-17 (JTBD-02, JTBD-06)
- **Entry point:** the extension's own page opened with no hash — toolbar menu, the store's "options" link, or a bookmark
- **Preconditions:** the local stores are readable
- **Steps:**
  1. User opens the page -> system paints the shell and all eight area rows at once, each row's state reading "считаем…" and the band "Считаем…"; nothing waits on data. **Built 2026-08-20:** the record promised this and `overview.ts` had the `loading` state ready, while `renderRoute` awaited the storage check and the whole section before touching the DOM — a blank page for the length of eight reads (B-59). The shell is painted on arrival only; a repaint after an action leaves the page as it is, because flashing "Считаем…" over a page someone is reading trades a blank first paint for a flicker on every press
  2. Reads land -> system fills the band with **at most three** ranked rows and counts the rest as "…ещё N", and fills each area row with its one-line state
  3. User reads the top row -> it names what happened, where it came from and when, with severity as **icon plus text**
  4. User activates the top row -> system opens the area that owns it
- **Expected result:** the user learns what needs them without scrolling and without opening anything, and the first thing they can press is the worst thing there is
- **Alt paths:** nothing outstanding anywhere -> the band says "Сейчас ничего не требует внимания" **and when this was last checked**, and the area rows still carry their states; with an empty band the primary action is "Что делать дальше"
- **UI elements:** attention band with up to three rows and a remainder count, eight area rows as real links, primary action
- **States covered:** loading, empty, success
- **Alt paths:** the recovery row is the one whose address depends on what is open -> with exactly one unfinished checklist it opens that checklist; with none or several it opens the overview, where the band lists them. `#recovery` alone names no incident, so there is no third answer. Until 2026-08-20 the row was given the overview's address outright and a row reading «Восстановление» went somewhere else (B-59)
- **Errors & recovery:** the store cannot be opened at all -> the failure is named, repair is offered, and **no area row claims a state**; a partial failure is SCN-030. The recovery row's own read failing is the same case as nothing being open: it opens the overview, because "we cannot tell" is not an address
- **Behaviour notes:** one ranking rule for the whole product — `packages/core-queue/src/rank.ts` orders the band, each area's outstanding item mapped into the shape it already ranks. **No counter of blocked threats, no protection score, no streak** — the band names things to do, and when there is nothing to do it says so instead of scoring the silence
- **Status:** implemented
- **Coverage:** packages/ui/src/dashboard/overview.ts:renderOverview, apps/extension/src/options/index.ts, apps/extension/src/options/views.ts:recoveryHref, e2e/scn-027.spec.ts

### SCN-028: A deep link opens its area; an unknown address says so
- **Persona:** P-01
- **Feature:** daily-use
- **Traces:** ST-015, FLW-17 (JTBD-02)
- **Entry point:** "что изменилось" in the popup, a banner's "what was sent" link, a recovery link — any `options.html#…`
- **Preconditions:** none
- **Steps:**
  1. User clicks "что изменилось" in the popup -> system opens the page **on the journal**, not on the overview and not at the top of a long page
  2. User presses browser Back -> system returns them where they came from, because navigation is real links plus `hashchange` rather than a router
  3. A link carries an address the page does not know -> system opens the overview **and names the address it did not understand**
- **Expected result:** every address the product produces lands where it says it lands, and one that does not is visible rather than silent
- **Alt paths:** `#recovery=<kind>` carries a value -> the recovery area opens for that incident kind; an unknown kind gets the broad checklist and is told so (SCN-025)
- **UI elements:** the hash → view map; the "адрес не распознан" line on the overview
- **States covered:** success, error
- **Errors & recovery:** the area behind a valid address cannot read its data -> that area shows its own error state, and the address is still honoured; the user is not bounced to the overview for a read failure
- **Behaviour notes:** this scenario exists because the defect existed. `apps/extension/src/popup/index.ts:onWhatChanged` and its sibling handler produced `options.html#journal` from two call sites while `SECTION_FOR_HASH` held only `#queue`, so the button opened a settings page with the journal four sections below — and no test could see it, because producer and consumer were never checked against each other. The gate that comes with this scenario greps the extension for every `options.html#…` producer and asserts each one resolves
- **Status:** implemented
- **Coverage:** apps/extension/src/options/views.ts:routeFor, tools/options-routes.test.ts, tools/gates/bundle-scan.test.ts, e2e/scn-027.spec.ts

### SCN-029: Acting inside an area keeps the place, the focus and the count
- **Persona:** P-01
- **Feature:** daily-use
- **Traces:** ST-015, FLW-17 (JTBD-06)
- **Entry point:** any area opened from the overview or by deep link
- **Preconditions:** at least one actionable row in that area
- **Steps:**
  1. User presses an action on a row — "Готово", "Не сейчас", a recovery step's checkbox -> system puts **that row** into a pending state within the same frame, before the write returns
  2. The write succeeds -> the row settles into its new state; **only this area repaints**, and the other seven are not read
  3. Focus and selection return to the element the user was on, whichever element that is
  4. User returns to the overview -> the back affordance reads "← Обзор · N требуют внимания", or "← Обзор" when N is 0
- **Expected result:** a keyboard user can work down a list without being thrown to the top of the document, and a mouse user can see that their click registered before the result arrives
- **Alt paths:** a burst of actions -> repaints stay serialised and collapse to the last state, so no repaint paints over a newer one
- **UI elements:** per-row pending state, back affordance carrying the count
- **States covered:** loading, success, error
- **Errors & recovery:** the write fails -> the row returns to its previous state **with the failure named on the row**; pending is never reported as success
- **Behaviour notes:** replaces two behaviours measured on 2026-08-12. Focus was restored for exactly one node — the address field, in `apps/extension/src/options/keep-focus.ts:keepingFocus` — so the recovery checkbox and the queue buttons blurred on every action; and one action cost two whole-document repaints with five section reads each. The address-field invariant of SCR-08 is unchanged: the live node is moved, never rebuilt, so a value and an in-progress IME composition still survive
- **Status:** implemented
- **Coverage:** apps/extension/src/options/keep-focus.ts:keepingFocus, apps/extension/src/options/pending.ts:whilePending, e2e/scn-015.spec.ts

### SCN-030: An unread count never renders as "nothing here"
- **Persona:** P-01
- **Feature:** daily-use
- **Traces:** ST-017, FLW-17 (JTBD-05)
- **Entry point:** the overview, when one of the eight cheap count reads fails
- **Preconditions:** one area's count cannot be read; the rest can
- **Steps:**
  1. User opens the page -> seven rows fill with their states
  2. The eighth read fails -> that row reads **"состояние не прочитано"** and offers the area anyway
  3. User opens that area -> the area shows its own error state, with the failure named
- **Expected result:** the user is never told an area is quiet because the product could not look
- **Alt paths:** every read fails -> the whole overview goes to its error state (SCN-027) rather than eight identical unread rows
- **UI elements:** the per-row unread state; the area's own error state
- **States covered:** error
- **Errors & recovery:** this scenario *is* the recovery path; there is no branch in which a failed read produces a reassuring word
- **Behaviour notes:** this is the product's oldest rule applied to its newest surface — "absence of data must never read as a pass", standing instruction 3 in `docs/superpowers/retro.md`. The overview multiplies the risk by eight: eight cheap reads, each able to fail, all rendering into one word that comforts. A planted rejected read is part of the gate, not an afterthought
- **Status:** implemented
- **Coverage:** packages/ui/src/dashboard/overview.ts:renderOverview, apps/extension/src/options/index.ts


## recovery

### SCN-025: Recovery after running a pasted command
- **Persona:** P-02
- **Feature:** recovery
- **Traces:** ST-015, FLW-16 (JTBD-06, JRN-03/#5)
- **Entry point:** "I already ran it" from a ClickFix warning, or the recovery entry in the popup — **the second was written here from the start and built on 2026-08-20** (B-59). Until then every checklist opened because a detector fired, so a person who ran the pasted command and realised afterwards had no way in at all
- **Preconditions:** none
- **Steps:**
  1. User states what happened -> system builds the checklist for pasted commands, most damaging step first. Arriving with no incident named (`#recovery`, the popup's entry) shows the picker: four choices, one per playbook that exists, with "not sure" last so it is not what a hurried person picks to skip the question
  2. User works through the steps -> system tracks progress per step and keeps it across restarts
  3. User finishes -> system archives the incident with its date
- **Expected result:** the user completes a concrete recovery sequence instead of searching for advice of unknown quality
- **Alt paths:** a step must be done on another device -> system shows what to do there and preserves progress; user is unsure what happened -> system offers the "not sure" path with the broadest safe checklist
- **UI elements:** incident type picker, ordered steps with reasons, per-step done control, "continue on another device", archive
- **States covered:** loading, empty, success
- **Errors & recovery:** playbook data missing -> system shows the broadest safe checklist and says that is what it is showing; **an address this product never produces -> the same broad list, and the page renders** — until 2026-08-20 two such addresses left it completely blank, which is the worst possible failure for the one screen a person opens while something is already going wrong
- **Known limit — an incident name is read from the address, so the address can say anything.** Two kinds of nonsense were fatal and are now ordinary. A broken percent escape (`#recovery=%E0%A4%A`): `routeFor` decodes once and deliberately keeps a malformed value raw so the checklist can report it, and the options entry decoded a **second** time, threw `URIError`, and never reached `replaceChildren`. A name inherited from `Object.prototype` (`#recovery=constructor`, `__proto__`, `toString`): `kind in INCIDENTS` walks the prototype chain, so the lookup returned a function and rendering died on it. Both measured 2026-08-20. The rules that replace them: the address is decoded **once**, by the routing module and nowhere else, and membership is `Object.hasOwn`
- **Status:** implemented
- **Coverage:** packages/core-recovery/src/checklist.ts:buildChecklist, packages/ui/src/recovery/recovery.ts:renderRecovery, e2e/scn-025.spec.ts (including a broken escape and three inherited names), packages/core-recovery/src/checklist.test.ts (eight inherited names, and every real incident still named), apps/extension/src/options/views.test.ts (decoded once, and the entry point holds no second decode)

### SCN-032: The local store was written by a newer build
- **Persona:** P-01
- **Feature:** recovery
- **Traces:** ST-019, FLW-14 (JTBD-05)
- **Entry point:** any screen, on a profile the installed build cannot open
- **Preconditions:** the profile holds a schema version this build does not know — an enterprise rollback, Chrome reverting an update, or a downgrade by hand
- **Steps:**
  1. User opens any area -> system says the local data cannot be opened, in one panel rather than in every panel
  2. User reads why -> system names which of two things happened: the data was written by a newer version and is intact, or the store's shape is wrong and updating will not help
  3. User chooses -> "Try again" for a store held by another window, or "Clear the local data" with what that destroys spelled out
- **Expected result:** the user knows whether their data is recoverable and what to do, instead of reading a browser's sentence about requested and existing versions
- **Alt paths:** the store is held by another copy of Okolos in the same profile -> the panel says so and trying again succeeds once that window closes
- **UI elements:** SCR-20 — heading, the reason, the two version numbers, the underlying message verbatim, "Try again" (primary), "Clear the local data", and a note listing everything clearing destroys
- **States covered:** error
- **Errors & recovery:** **this scenario is the error path**, and it had none until 2026-08-20: `openDB` was called with no `catch`, so a `VersionError` propagated into each of the six sections that read the store, and each rendered the browser's own wording. Nothing in the repository recognised the error by name, nothing distinguished it from a damaged store, and there was no way back — `wipeAll` needs a connection, which is precisely what is missing. `resetStorage` deletes the store outright, so the recovery does not depend on the thing that failed
- **Why refusing is right rather than a fallback:** the newer build may have added a store, an index or a field this one cannot describe, and writing into a schema we do not know is how a downgrade becomes data loss. The panel offers reinstalling that build first, because it is the remedy that keeps everything
- **Known limit — a store already at the current version whose shape is wrong cannot be repaired.** A browser changes a schema only inside a version-change transaction, so a store or index a half-finished upgrade left out is simply missing: `upgrade` does not run and nothing may create anything. Measured while writing the migration tests. The shape is therefore **verified after opening** and the gap named, because `reuse` without its `by-tag` index answers "where else was this password used" with nothing, quietly and forever. The remedy is clearing, and the panel says so
- **Telemetry:** none — no analytics events are emitted by this product
- **Status:** implemented
- **Coverage:** packages/storage/src/db.ts:openDb, packages/storage/src/db.ts:resetStorage, packages/ui/src/storage/storage-problem.ts:renderStorageProblem, packages/storage/src/db.test.ts (upgrades from versions 1, 2 and 3; a profile from version 9; a shape with a store and an index missing), packages/ui/src/storage/storage-problem.test.ts — unit only: a browser cannot be made to hold a future profile without writing one, which is what the unit tests do directly

## site-owner

### SCN-026: Site owner checks and appeals a verdict
- **Persona:** P-03
- **Feature:** site-owner
- **Traces:** ST-016, FLW-15 (JTBD-08)
- **Entry point:** the public status page, reached from an interstitial link or shared by a customer
- **Preconditions:** none — no account, no extension installed
- **Steps:**
  1. Owner enters their domain -> system returns the current verdict, the feed that produced it, and the entry date
  2. Owner reads the source -> system links to the upstream feed's own appeal process when the verdict is not ours, and offers an appeal form only when the listing is one this service can lift
  3. Owner submits an appeal -> system records it and shows a reference id, as a page — the form posts without script, so it works on the first load
- **Expected result:** an affected owner learns why their site is flagged and has a route to dispute it within two minutes, without an account
- **Alt paths:** the domain is not flagged -> system states that nothing is recorded for it
- **UI elements:** domain field, "Check domain" (primary), verdict card with source and date, upstream appeal link, appeal form, reference id
- **States covered:** loading, empty, error, success
- **Errors & recovery:** the status service is unavailable -> system says so plainly; it never implies the domain is clean when it could not check; **the same appeal sent twice is reported as already on file, with its reference, not as a failure**; and a host that is not a public domain (`..`, a single label) is refused at the door rather than stored and answered about
- **What guards the one route on this service that writes.** Until 2026-08-20 there was nothing: no rate limit, no body cap — `request.text()` and `request.json()` read whatever a sender chose to send and the 2000-character cap came after — no origin check of any kind, and no security headers anywhere in the service. The form is `x-www-form-urlencoded`, which needs no preflight, so **any page anywhere could file an appeal under any domain in a visitor's name, with one HTML form and no JavaScript.** Now: the body is bounded as it arrives (`content-length` *and* a running total, because the header is optional and a chunked body has none); `Sec-Fetch-Site` or `Origin` must say the request came from this site, which is a check about browsers and not authentication, and is described as such in the code; five appeals per domain per hour, counted from the appeals table because **nothing about the sender is stored** and the domain is the only thing an appeal contains that is worth limiting
- **Why a failing rate limiter still lets the appeal through.** The count is a `SELECT` and it can fail. Turning that into "your appeal was rejected" would be a denial of service performed on the owner, so an unreadable limiter means *unknown* rather than *over budget* — the body cap and the duplicate check still bound the write
- **The reference is random, and that is a security property.** It was a 32-bit hash of the domain and the message **and** the primary key, so an attacker could compute the reference an owner's appeal would receive, file it first with their own contact, and the owner's submission came back "already filed" — with the owner's contact never stored and nothing to tell them why. A duplicate is now the same domain, message **and contact**, read rather than collided with
- **Somebody reads them.** The whole tree held an `INSERT` and a `DELETE`: appeals were written, swept after 180 days, and never read by anyone. `/appeals` returns them to whoever holds `APPEALS_TOKEN` and **does not exist without it** — 404 rather than 401, because a confirmed address gets guessed at — never cached, never readable cross-origin, and the token compared without leaking the answer through how long it took
- **Status:** implemented
- **Coverage:** apps/proxy/src/router.ts:statusPage, apps/proxy/src/router.ts:appeal, apps/proxy/src/router.ts:listAppeals, apps/proxy/src/router.ts:appealPage, apps/proxy/src/router.test.ts, apps/proxy/src/appeal.test.ts (34 checks: origin, body cap, budget, reference, read path, headers), apps/proxy/src/sweep.test.ts — live at `/status`, verified against the deployed worker

### SCN-031: A finding inside an embedded frame reaches the page that embeds it
- **Persona:** P-01
- **Feature:** ai-shield
- **Traces:** ST-001, FLW-02 (JTBD-01)
- **Entry point:** any page that embeds a frame from another origin
- **Preconditions:** the embedded frame carries hidden text addressed to an assistant; the embedding page itself is clean
- **Steps:**
  1. User opens the page -> the content script scans in every frame, because injections hide in iframes too
  2. The frame's finding comes back -> the frame neutralises it and arms the agent gate **in that frame**, and the background tells the top frame
  3. The top frame shows one warning, naming the frame's **origin** -> "something on this page" and "something in the frame from ads.example" are different warnings, and only the second says where to look
- **Expected result:** a poisoned frame is handled *and* mentioned; the user is not left with an injection silently neutralised inside an advert
- **Alt paths:** the embedding page has its own finding and a banner is already up -> the frame's finding does not become a second overlay. **Generalised 2026-08-20 (B-69): this rule is about the surface, not about the source, and it was applied here only.** Two other sources kept mounting their own panel, so a page that was both a lookalike and poisoned drew two warnings at identical coordinates — one exactly on top of the other, the lower one unreadable. Every source now claims one slot (`apps/extension/src/content/surface-slot.ts`): the worst finding holds the panel, a tie leaves it where it is, and anything not worse becomes a line on the panel that is up rather than a panel beside it. So the frame's finding is now named on screen instead of only in the journal — the same rule, kept better
- **UI elements:** the injection banner, headline naming the frame's origin; "Показать запись"
- **States covered:** success
- **Errors & recovery:** the frame navigated or the tab closed before the report arrived -> nothing is drawn and the journal holds the finding; a frame with no address of its own (`srcdoc`, `about:blank`) -> the banner says "встроенный фрейм без собственного адреса" rather than inventing a name
- **Behaviour notes:** the frame keeps asking until someone hears it — twelve attempts, 750 ms apart, then a journalled give-up naming the count and the duration. **Not a workaround for slowness:** measured at 135 ms when it lands, and lost entirely when it does not, because an embedded document can reach `document_idle` and finish its whole cycle before the embedding page's content script has started, so a report sent once arrives at a frame zero with no listener. The end-to-end spec passed in isolation and failed in the full suite on exactly that; setting the budget back to one attempt reproduces it. The report goes frame → background → top frame rather than frame → top frame directly, and that is a security choice rather than a convenience. A subframe can reach the top with `window.top.postMessage`, and that message travels through the page's own window — where the page can forge it, and the top frame has no way to tell an extension's report from a claim made by the thing being reported. The background sits outside the page, so this hop is not forgeable. **Until 2026-08-20 the reporting half did not exist at all:** `content/index.ts` returned on `if (!isTopFrame)` after neutralising and arming, while its own comment three screens up promised "subframes still collect and report; the top frame is the one that speaks"
- **Status:** implemented
- **Coverage:** apps/extension/src/background/index.ts:handleCandidates (the relay), packages/platform/src/adapter.ts:sendToFrame, apps/extension/src/content/index.ts:showFrameFinding, apps/extension/src/content/surface-slot.ts:createSurfaceSlot, packages/contracts/src/verdict.ts:worstOf, e2e/scn-031.spec.ts, e2e/two-findings.spec.ts (one panel on the fixture that is both a lookalike and poisoned)

### SCN-033: Deciding whether to install, from pages that run nothing
- **Persona:** P-01
- **Feature:** pre-install
- **Traces:** ST-021, FLW-18 (JTBD-05, JRN-01/#2, JRN-01/#3)
- **Entry point:** a search result, a link from a blocked page's `/status`, a repository README
- **Preconditions:** nothing is installed and nobody has an account
- **Steps:**
  1. Reader opens `/` -> system serves the whole argument as markup: what it is, what it does, and **what it does not do** — half the page
  2. Reader looks for what leaves the device -> system links to `/privacy`, which says the same thing in more detail and does not contradict it
  3. Reader decides -> the install link goes to the store listing, which is Chrome's page with Chrome's permission prompt
- **Expected result:** somebody who had never heard of this can say what it refuses to do before granting it broad permissions — which is the only basis on which a security tool asking for `<all_urls>` can be trusted
- **Alt paths:** the reader decides **not** to install -> that is an exit of this flow and not a failure; a page that serves only the other exit is a sales page rather than an argument
- **UI elements:** SCR-17 (landing), SCR-18 (privacy); the store listing is drawn as a boundary because it is not ours
- **States covered:** success
- **Errors & recovery:** the pages carry no state that can fail — there is no script on either, by gate, so there is no loading state to get wrong and no error state to render. `/status` failing is SCN-024's path, not this one
- **Behaviour notes:** **no executable scripts at all**, held by eleven rules in `apps/proxy/src/landing.test.ts`, four of them verified by planted defects; the privacy page is generated from `docs/privacy.md` by `tools/privacy-page.mjs` and `tools/docs.test.ts` refuses when the two disagree, so the claims a reader checks are the claims the repository states
- **Why this was written on 2026-08-20 and not when the pages shipped.** The journey carried the step from the day it was drawn, the pages were built and gated in B-15, and the screen entries recorded on 2026-08-12 that no flow covered them — honestly, rather than inventing one. What was missing was the story in between. Written now as ST-021 → FLW-18 → this scenario (B-22)
- **Status:** implemented
- **Coverage:** apps/proxy/src/landing.test.ts, apps/proxy/src/router.test.ts, tools/docs.test.ts

## mail-guard

Scope note, written before the first scenario rather than discovered after it:
**this feature serves P-01 only, and that is a limitation, not an oversight.**
Mail-borne scam hits P-02 hardest — `foundation.md` describes them as someone
who "не откроет дашборд и не прочитает" — and phase 0 is a command line. A
command line is not a surface P-02 will ever meet. Claiming this feature
protects them would be the most comfortable sentence in this document and the
least true one. It becomes true when a surface exists that they would use, and
that surface is not designed here.

### SCN-038: One message checked on demand
- **Persona:** P-01
- **Feature:** mail-guard
- **Traces:** ST-022, FLW-19 (JTBD-09, JRN-04/#4, JRN-04/#5)
- **Entry point:** `okolos-mail scan <path>` on an `.eml` or `.emlx` file
- **Preconditions:** the file is readable; no configuration has been done
- **Steps:**
  1. User hands over one message -> system parses it and runs every deterministic check
  2. User reads the result -> system names each signal that fired and the fact it stands on
  3. User reads further -> system names each check that did not run, and why, with the same prominence
- **Expected result:** the user can weigh the answer, because they can see both what it found and what it could not look at — and nothing about the message left the machine
- **Alt paths:** the message carries nothing suspicious -> system says so **and still lists what was checked**; a bare "clean" is refused by SCR-21's empty state
- **UI elements:** SCR-21 — verdict line with severity in words, signals, the did-not-run block
- **States covered:** loading, empty, error, success
- **Errors & recovery:** the file cannot be parsed -> the run reports the message as unreadable and renders no verdict. **A scan that failed is never a clean result** — the same rule B-74 established for the page scan, applied before the first line of this feature is written rather than after it costs someone a warning
- **Status:** draft
- **Coverage:** partial — the refusal path is built and the finding path is not. `packages/core-mail/src/parse.ts:parseMessage` reads `.eml` and `.emlx`, `verdict.ts:assembleVerdict` refuses to call a check clean when nobody reported it, `report.ts:buildReport` renders SCR-21, and `apps/mail-cli/src/scan.ts` exits `2` on an unreadable message rather than `0`. **Every check reports `mailSkipNotBuilt` and the command prints that four times** — the scenario stays `draft` because its own steps 1–3 have not run, not because nothing exists

### SCN-039: The sender is not who the name says
- **Persona:** P-01
- **Feature:** mail-guard
- **Traces:** ST-023, FLW-19 (JTBD-09, JRN-04/#1, JRN-04/#5)
- **Entry point:** any message check
- **Preconditions:** the message carries headers
- **Steps:**
  1. User checks a message -> system reads the authentication result the receiving server already computed (SPF, DKIM, DMARC alignment) and reports its verdict in plain words
  2. User checks a message whose display name carries a brand -> system compares it against the address's registrable domain and shows both halves when they disagree
  3. User checks a message from a domain that neighbours a known one -> system names the lookalike using the same words the browser side uses for the same finding
- **Expected result:** the sender is judged by what the sender cannot forge, not by the display name — the one field an attacker controls completely
- **Alt paths:** `Reply-To` resolves to a different domain than `From` -> reported as a signal in its own right, because it is the shape of business-email compromise
- **UI elements:** SCR-21 signals block, one row per signal, each carrying its evidence
- **States covered:** success, empty
- **Errors & recovery:** the headers carry **no** authentication result at all -> reported in the did-not-run block as a check that could not run, never as a pass. A message that nobody authenticated and a message that authenticated cleanly must not print the same thing
- **Known limit — the brand check reads a Latin label, and that is the whole of its language coverage.** Standing instruction 10 asks every wording-reading detector to name the languages it matches, and here the honest answer is narrower than "Russian and English": the check takes the label of each watched domain — `paypal` from `paypal.com` — and looks for it in the display name. So `"PayPal Service" <billing@secure-notice.test>` is caught, and **«Сбербанк» is not**, because no Cyrillic brand name is in `DEFAULT_WATCHLIST` to match against. Everything else in this scenario is structural and carries no language at all: a header value, a comparison of two registrable domains, a script mixture in a hostname. Naming which half is which is the point of the instruction — so nobody re-derives it, and nobody reads the caught case as proof of the missed one
- **Known limit — a brand name inside a longer word is not that brand.** `"Applesauce Recipes"` carries `apple` and is not Apple. The match is bounded by letters and digits of any script on both sides, so a Cyrillic word beside a Latin brand still separates. A check that cries wolf here is how a person learns to dismiss the next one unread
- **Status:** implemented
- **Coverage:** `packages/core-mail/src/sender.ts:checkSenderAuth` (RFC 7601 `method=result`, the older `Received-SPF`, and DKIM alignment compared on the registrable domain so `mail.bank.test` signing for `bank.test` is not an anomaly), `:checkSenderIdentity` (lookalike domain via `@okolos/core-lookalike`, brand-in-display-name), `:checkReplyPath`; `packages/core-mail/src/sender.test.ts` — 19 checks, **seven planted defects, each landed and each caught**; `apps/mail-cli/src/scan.ts:outcomes` wires all three. **The absent-header path is the one that decides the design:** a message with no authentication result at all makes `senderAuth` report `not run` while `senderIdentity` and `replyPath` run on the same message — which is why the registry splits the sender into three entries rather than one, recorded in `verdict.ts:CHECKS`

### SCN-040: A link goes somewhere other than it says, and text is hidden from the reader
- **Persona:** P-01
- **Feature:** mail-guard
- **Traces:** ST-024, FLW-19 (JTBD-09, JTBD-01, JRN-04/#5)
- **Entry point:** any message check
- **Preconditions:** the message has an HTML part
- **Steps:**
  1. User checks a message -> system extracts every link and compares the visible text against the destination, showing both when they disagree
  2. System unwraps redirects and checks each resulting host against the signed blocklist the browser side already carries, and against the lookalike checker
  3. System runs the hidden-text detector over the HTML part and reports text present in the message but not perceivable by a human and phrased as an instruction
- **Expected result:** neither the reader nor an assistant reading the mailbox is steered by something the reader cannot see
- **Alt paths:** the message is plain text only -> the link checks still run over the raw addresses, and the hidden-text check reports in the did-not-run block that there was no HTML part to examine
- **UI elements:** SCR-21 signals block; a link signal shows the two addresses on adjacent rows, never inline in a sentence
- **States covered:** success, empty
- **Errors & recovery:** the blocklist is older than its ceiling -> the host check reports as not run, naming the age. **The blocklist this reuses was 29.3 days old on the machine this was designed against (measured 2026-09-11) and its ceiling is 14** — so on the day this ships, this check's honest answer is "did not run", and the surface must be able to say that without looking broken
- **Why this scenario is the feature's reason to exist.** The hidden-instruction detector is what this product is for, and a mailbox read by an assistant is where indirect prompt injection arrives without the user having chosen to open anything. The same `core-injection` stage that reads a page reads a message body; nothing about it is new except the carrier
- **Status:** draft
- **Coverage:** none — designed 2026-09-11, not built

### SCN-041: An attachment is judged without being opened
- **Persona:** P-01
- **Feature:** mail-guard
- **Traces:** ST-025, FLW-19 (JTBD-09, JRN-04/#6)
- **Entry point:** a message check where the message has attachments
- **Preconditions:** the attachment bytes are present, or the message names an attachment that is not
- **Steps:**
  1. User checks a message with a file attached -> system reads the bytes in a jailed child process with no network and no write access, and asks no application on the machine to open, render, preview or index it
  2. System compares the real type by magic bytes against the declared MIME and against the extension, and names any disagreement
  3. System reports a filename carrying a bidirectional override in both forms — as stored and as displayed — and names the trick
- **Expected result:** the user learns whether the file is what it claims to be, and checking it was never the thing that ran it
- **Alt paths:** a dangerous class with no ambiguity (installer, script, disk image, an office document carrying a macro project, an HTML attachment) -> named as such without needing a mismatch to fire
- **UI elements:** SCR-21 signals block, one attachment per row with its own did-not-run entries
- **States covered:** success, empty, error
- **Errors & recovery:** the parser crashes or exceeds its ceiling -> that attachment's checks are reported as not run, the rest of the message is still judged, and nothing outside the jailed process is affected. **This is the whole reason the process is separate**: the input is chosen by an attacker, so the parser is assumed to be the thing that breaks
- **Known limit — no hash is sent anywhere.** The browser side already took this position for downloads (`coverage-matrix.md` 2.2): sending a hash of the user's file to a third party is not among the network purposes this product declares. The verdict therefore never carries "known-bad sample", and says so rather than leaving the reader to assume it was checked
- **Status:** draft
- **Coverage:** none — designed 2026-09-11, not built

### SCN-042: A message arrives and is judged before it is read
- **Persona:** P-01
- **Feature:** mail-guard
- **Traces:** ST-022, FLW-20 (JTBD-09, JRN-04/#2, JRN-04/#7)
- **Entry point:** `okolos-mail watch` running; a message lands in the local mail store
- **Preconditions:** the watcher can read the store; the message arrived after the watcher started
- **Steps:**
  1. A message lands -> system waits for the complete form rather than judging the partial one the client writes first
  2. System runs the checks of SCN-038 through SCN-041 and records the verdict
  3. System interrupts **only** if something was found, naming severity, the displayed sender, the address it resolves to, and one sentence
- **Expected result:** the user hears about the message before they read it, and hears nothing for every message that is fine
- **Alt paths:** the user opens the alert -> SCR-21 for that message
- **UI elements:** SCR-22 (severity in words, sender in both forms, one sentence, one action), then SCR-21
- **States covered:** empty, error, success
- **Errors & recovery:** the mail store becomes unreadable -> the watcher says it has stopped watching, and why. **Silence from a watcher that died is indistinguishable from silence from a quiet inbox**, which makes the error state the thing that earns the silence — the argument SCN-030 already makes for the dashboard
- **Bounded by design: only messages that arrive after the watcher starts.** The store held **82 595 messages** on the machine this was designed against (`find ~/Library/Mail -name '*.emlx' | wc -l`, 2026-09-11). A first run over the archive would take hours and produce a backlog nobody asked for. Reviewing what is already there is a separate, explicit act with its own bound
- **Known limit — reading the store needs Full Disk Access, and that is the whole onboarding.** Granted once in system settings. Without it the watcher reports that it cannot see the store rather than reporting an empty one
- **Status:** draft
- **Coverage:** none — designed 2026-09-11, not built

### SCN-043: Who reviewed, where it ran, and what left
- **Persona:** P-01
- **Feature:** mail-guard
- **Traces:** ST-026, FLW-19 (JTBD-09, JTBD-05, JRN-04/#4)
- **Entry point:** any message check
- **Preconditions:** none — the default configuration is the main path of this scenario
- **Steps:**
  1. User checks a message having configured nothing -> system runs the review on-device or not at all, **nothing leaves the machine**, and the verdict names which of the two happened
  2. User switches the cloud review on deliberately and names a model -> system writes the outbound record **before** the request, naming the model, the provider and the size of what was sent, and routes only to an endpoint that retains nothing
  3. User reads the verdict -> system names who reviewed and where it ran, on the verdict itself and not only in a log
- **Expected result:** the product's central claim survives contact with a language model, because the one step that can leave the machine is off by default, named when on, and recorded before it happens
- **Alt paths:** the reviewer is unavailable, refuses, or times out -> the deterministic verdict stands unchanged and the output says the review did not run
- **UI elements:** SCR-21 `[data-role=review]`
- **States covered:** success, error
- **Errors & recovery:** the outbound record cannot be written -> the request is **not made**. This is `packages/net`'s existing rule, and it is the rule rather than a new one because a second network path with a second set of habits is how the first one's guarantee stops being true
- **The reviewer may not raise severity.** It explains, orders and summarises; it cannot manufacture a verdict the deterministic checks did not reach. This is [ADR-0004](../adr/0004-verdict-never-outruns-checks.md) applied to a new stage rather than a new decision
- **The message is untrusted input to the reviewer.** A message can carry instructions addressed to whatever reads it, and the reviewer is a reader. The sanitiser runs before the reviewer sees anything — which means this product's own detector protects its own model, and a failure here would be the exact attack the product is named for, committed by the product
- **Recorded exception to an anti-goal.** `coverage-matrix.md` §6 refuses "анализ содержимого писем через облачный OAuth". The cloud review is not that — no OAuth, no mailbox access, one message the user handed over — but it is adjacent, and the distance is kept by three things rather than by the wording: off by default, recorded before it is sent, and routed only where nothing is retained
- **Status:** draft
- **Coverage:** none — designed 2026-09-11, not built

