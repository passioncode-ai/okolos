<!-- Managed with super-ux (ux-contract v4). The WHY layer: update when the understanding of users changes. -->

# Foundation — WHY layer

Evidence base for every claim below: [../evidence/](../evidence/).
Product context: [../product-vision.md](../product-vision.md),
[../coverage-matrix.md](../coverage-matrix.md).

Confidence tags used in this file: **[data]** — backed by a cited source in
`evidence/`; **[assumption]** — plausible but untested, needs validation.

## Personas

### P-01: Agent-augmented power user
Daily driver of AI assistants in the browser — sidebar summaries, an agentic
browser, coding agents. Technically literate: knows what prompt injection is
in theory, has no way to see it in practice. Runs 15–25 extensions, holds
crypto wallets, lives outside the US. Wants control and evidence, distrusts
security vendors that ship telemetry. **[data]** — agentic browsers in
production at 27.7% of enterprises; AI extensions installed by ~15% of users
([evidence/02](../evidence/02-ai-agent-threats.md) §2.4,
[evidence/03](../evidence/03-extensions.md) §3.3).

### P-02: Protected relative
Non-technical, 55+. Uses a browser for mail, banking, shopping. Will not read
a verdict, will not open a dashboard, and will click whatever a convincing
page tells them to click. Needs the product to be silent until it must not
be, and then unmissable and unambiguous. **[data]** — older adults are 5×
more likely to report tech-support scam losses; $159M reported in 2024
([evidence/01](../evidence/01-threat-landscape.md) §1.5).

### P-03: Site owner wrongly flagged *(secondary — affected party, not a user)*
Runs a small site or shop. Never installed our product; discovers it only
when customers say the site is "blocked". Needs to see why, check the current
status, and appeal — without creating an account. **[data]** — the loudest
Guardio complaint on G2: a legitimate site flagged with **no notification to
its owner** ([evidence/06](../evidence/06-competitors.md) §6.3).

## Jobs to Be Done

### JTBD-01: Keep my AI from being hijacked by the page
- **Statement:** When I let an assistant read or act on a web page, I want any instruction planted for it to be caught and removed first, so I can use agents without handing strangers a remote control.
- **Personas:** P-01
- **Type:** functional
- **Forces:** push: agents already act on untrusted pages; pull: a guard outside the AI vendor's own stack; anxiety: false positives breaking pages, another extension reading everything; habit: trusting that the AI vendor handles it.
- **Success metric:** hidden instructions found and neutralised on real pages before the assistant consumes them; zero pages broken by the removal.

### JTBD-02: Judge a page or link before I commit
- **Statement:** When I'm about to open a link, log in, pay, or download, I want to know whether this thing is what it claims to be, so I don't lose money or credentials to a convincing fake.
- **Personas:** P-01, P-02
- **Type:** functional
- **Forces:** push: 971 181 phishing attacks in Q1 2026, median site alive 5.5 hours; pull: a verdict at the moment of decision; anxiety: crying wolf, blocked legitimate sites; habit: "I'd notice a fake".
- **Success metric:** the user stops before entering credentials or running a command on a hostile page. **[data]** — [evidence/01](../evidence/01-threat-landscape.md) §1.2.

### JTBD-03: Keep my extensions from turning on me
- **Statement:** When an extension I installed long ago changes hands or quietly gains permissions, I want to be told at that moment, so a tool I trusted doesn't become spyware behind my back.
- **Personas:** P-01
- **Type:** functional
- **Forces:** push: 34% of extensions increased permissions in 12 months, AI extensions 6× more often; pull: continuous watch instead of one-time vetting; anxiety: alarm fatigue over harmless updates; habit: never revisiting the extensions page.
- **Success metric:** every ownership change and permission escalation on installed extensions is surfaced within a day. **[data]** — [evidence/03](../evidence/03-extensions.md) §3.2.

### JTBD-04: Know what of mine is already out there — and fix it
- **Statement:** When my credentials leak, I want to learn it early and be walked through the repair, so a stolen password doesn't quietly become a stolen account.
- **Personas:** P-01, P-02
- **Type:** functional
- **Forces:** push: >6B passwords stolen by malware in 2025, 75% of theft via infostealers; pull: fresh stealer-log data most services miss; anxiety: being shown 26 leaks and no next step; habit: reusing the same password.
- **Success metric:** the user completes the repair (password changed, reuse cleared, sessions revoked) — not merely reads the alert. **[data]** — [evidence/04](../evidence/04-credentials.md) §4.1.

### JTBD-05: Be protected without being watched
- **Statement:** When I install a security tool, I want to verify with my own eyes that it isn't shipping my browsing anywhere, so protection doesn't cost me the privacy it claims to defend.
- **Personas:** P-01
- **Type:** emotional
- **Forces:** push: every competitor's dashboard shows a server-side history of your visits; pull: open source plus a visible outbound-request log; anxiety: "every extension says that"; habit: accepting vendor privacy promises.
- **Success metric:** the user can name what left the device in the last week — from the product's own audit panel, and it matches the network log.

### JTBD-06: Get out of trouble after something already happened
- **Statement:** When I realise I clicked, pasted, or entered something I shouldn't have, I want a concrete ordered list of what to do now, so panic doesn't turn a scare into a loss.
- **Personas:** P-01, P-02
- **Type:** emotional
- **Forces:** push: 26% were scam victims in the past year; pull: guidance at the moment of realisation; anxiety: not knowing what was taken; habit: googling advice of unknown quality.
- **Success metric:** the user finishes the recovery checklist for their case. **[data]** — only 14% of people have access to scam review/analysis support ([evidence/05](../evidence/05-demand-and-market.md) §5.6).

### JTBD-07: Look after a relative without moving in with them
- **Statement:** When I set this up for my parent, I want to know they were protected and be alerted if something serious happened, so I can help without monitoring their browsing.
- **Personas:** P-01 (as carer), P-02 (as protected)
- **Type:** social
- **Forces:** push: elder fraud losses; pull: alerts without surveillance; anxiety: spying on family, breaking their browser; habit: driving over to fix things.
- **Success metric:** carer receives only serious events, containing a verdict — never a page, URL, or content. **[assumption]** — desirability untested; the segment's willingness is inferred from market signals, not interviews.

### JTBD-08: Clear my site's name *(P-03)*
- **Statement:** When my site is flagged, I want to see why and get it re-checked quickly, so a wrong verdict doesn't cost me customers.
- **Personas:** P-03
- **Type:** functional
- **Forces:** push: false flags directly cost e-commerce revenue; pull: public status check without an account; anxiety: no channel, no answer; habit: complaining on social media.
- **Success metric:** an owner can look up their domain's status and open an appeal in under two minutes, with no account.

### JTBD-09: Judge a message before I act on it
- **Statement:** When a message lands in my mailbox asking me to click, pay, sign in or open a file, I want to know whether it is what it claims to be, so that the channel that reaches me uninvited is not the one I check least.
- **Personas:** P-01, P-02
- **Type:** functional
- **Forces:** push: mail arrives without me choosing it, and the same phishing campaigns that own the web surface own the inbox; pull: a verdict computed on the machine the mail already sits on; anxiety: a tool that reads my mail is a worse exposure than the scam it prevents; habit: judging a sender by the display name.
- **Success metric:** a message carrying a forged sender, a disguised link or a dangerous attachment is named as such before the user acts on it, with every check computed locally by default. **[assumption]** — no measurement of mail-borne scam against this corpus exists yet; the browser-side numbers in [evidence/01](../evidence/01-threat-landscape.md) are about pages, not messages.
- **Why this is not JTBD-02.** JTBD-02 is about a page or a link the user *chose to open*. Mail arrives uninvited, is read in a program that is not the browser, and carries two things a page does not: a claimed sender whose authenticity the receiving server already assessed, and files attached to the artefact itself. A job that starts with "when I'm about to open a link" cannot carry it.

## Customer journeys

### JRN-01: P-01 — keep my AI from being hijacked (JTBD-01)
| # | Stage | User action | Touchpoint | Emotion (1-5) | Pain | Opportunity |
|---|-------|------------|------------|---------------|------|-------------|
| 1 | Before | Reads about agent hijacking incidents | news, OpenAI Lockdown Mode announcement | 2 | Knows the risk is real and unpatchable from inside | Position as the outside guard the vendor cannot be |
| 2 | Discover | Looks for a defence | Chrome Web Store, GitHub, HN | 2 | Nothing consumer-grade exists; only enterprise platforms | Be findable as the first consumer tool |
| 3 | Install | Adds the extension | store page, permission prompt | 3 | Broad permissions demanded by a security tool — the exact thing they distrust | Explain each permission in the store listing and at first run |
| 4 | First value | Runs the instant check | first-run screen | 4 | Wants proof it does something in seconds, not days | Scan open tabs + extensions immediately, show findings **[data]** §5.1 demand for "check yourself" |
| 5 | Daily use | Browses; a page carries a hidden instruction | in-page banner | 4 | Needs to know *where* it hid and whether the agent already read it | Show the concealed text, its hiding technique, and whether it was neutralised |
| 6 | Agent action | Asks the sidebar to summarise / act | agent surface + our stop-gate | 3 | Cannot tell whether the agent saw the clean or dirty page | Sanitise before read; require confirmation for sensitive actions |
| 7 | Trust check | Asks "what did you send?" | self-audit panel | 4 | Every vendor claims privacy; nobody proves it | Outbound log with payload detail, matching a real network trace |
| 8 | After | Recommends it / contributes | GitHub | 5 | — | Public source + open corpora make contribution the natural next step |

### JRN-02: P-01 — my credentials leaked (JTBD-04)
| # | Stage | User action | Touchpoint | Emotion (1-5) | Pain | Opportunity |
|---|-------|------------|------------|---------------|------|-------------|
| 1 | Trigger | Hears of a breach, or logs in with an old password | news, login form | 2 | No idea which of ~130 accounts is affected | Check at the moment of login, locally |
| 2 | Check | Runs the leak check | popup / first-run screen | 3 | Existing tools return "nothing found" or a wall of 26 old leaks | Multi-source incl. stealer logs; say honestly what was checked |
| 3 | Understand | Reads what leaked | leak entry | 2 | "Available on the dark web" explains nothing | Name the data classes and the date; separate fresh infostealer hits from old dumps |
| 4 | Repair | Changes the password | site's change-password page | 3 | Doesn't know where else the same password is used | Reuse detection from local hashes; one-click to `/.well-known/change-password` |
| 5 | Verify | Confirms it's done | repair queue | 4 | Nothing ever marks an alert as resolved | Explicit "resolved" state and archive |
| 6 | After | Next week | diff view | 4 | Old alerts re-shown as if new | Show only what changed since last time |

### JRN-03: P-02 — a page tells them to paste a command (JTBD-02, JTBD-06)
| # | Stage | User action | Touchpoint | Emotion (1-5) | Pain | Opportunity |
|---|-------|------------|------------|---------------|------|-------------|
| 1 | Before | Searches for something ordinary | search results | 3 | — | — |
| 2 | Landing | Opens a compromised legitimate site | the page itself | 3 | Domain reputation is clean — the site really is legitimate **[data]** §1.6 | Detect the behaviour, not the domain |
| 3 | Trap | Sees "verify you are human", page copies a command | fake CAPTCHA | 4 | Looks exactly like a real check | Intercept the clipboard write; state plainly that a real CAPTCHA never asks you to leave the browser |
| 4 | Decision | About to press Win+R and paste | OS run dialog | 2 | We cannot reach outside the browser — this is the last moment we can act | Make the in-page warning unmissable and dismissible only deliberately |
| 5 | After (bad) | Already pasted and ran it | — | 1 | Doesn't know what happened or what to do | Recovery checklist: what to check, what to change, in what order |
| 6 | After (good) | Leaves the page | banner | 4 | Doesn't understand what nearly happened | One plain sentence, no jargon, no scare metrics |

### JRN-04: P-01 — a message arrives and has to be judged (JTBD-09)
| # | Stage | User action | Touchpoint | Emotion (1-5) | Pain | Opportunity |
|---|-------|------------|------------|---------------|------|-------------|
| 1 | Before | Reads mail in Apple Mail, several times a day | Mail.app | 3 | The client shows a display name and a subject — the two fields an attacker controls completely | Judge the fields the attacker does not control: the authentication result the receiving server already computed |
| 2 | Arrival | A message lands | Mail.app, message list | 3 | Nothing between arrival and reading says anything about the sender | The message is on disk before it is read; a verdict can be there too |
| 3 | Suspicion | Something feels off, or nothing does | the message body | 2 | "Looks off" is not a check, and most of these look fine | An explicit, repeatable answer instead of a feeling |
| 4 | Check | Asks for this message to be checked | CLI, later a notification | 3 | Forwarding it to a scanning service means handing a stranger the mail | Everything computed on the machine the mail already lives on |
| 5 | Verdict | Reads what was found | verdict output | 4 | A score explains nothing and cannot be argued with | Name each signal, and name every check that did **not** run |
| 6 | Attachment | Wonders whether the file is safe | the attachment | 2 | The only way most people check a file is to open it — which is the attack | Judge it as bytes, in a jailed process, and never hand it to an application |
| 7 | After | Deletes it, or acts on it knowingly | Mail.app | 4 | — | The verdict is recorded, so "did I already check this one" has an answer |

## User stories

### ST-001: Hidden-instruction warning
- **Story:** As P-01, I want to be told when a page carries instructions written for an AI, so that I don't let my assistant act on someone else's orders.
- **Traces:** JTBD-01, JRN-01/#5
- **Acceptance criteria:**
  - Given a page with text present in the DOM but not visible to a human, and phrased as an instruction, when the page finishes loading, then a banner names the finding and offers to show it.
  - Given a page with no such text, when it loads, then nothing is shown and nothing is logged as a threat.
- **Priority:** must
- **Status:** proposed

### ST-002: See what was hidden and how
- **Story:** As P-01, I want to see the concealed text, where it sat, and by what technique it was hidden, so that I can judge the finding myself instead of trusting a score.
- **Traces:** JTBD-01, JTBD-05, JRN-01/#5
- **Acceptance criteria:**
  - Given a finding, when I open it, then I see the text, its DOM location, the concealment technique, and which detection stage fired.
- **Priority:** must
- **Status:** proposed

### ST-003: Neutralise before the agent reads
- **Story:** As P-01, I want hidden instructions removed from the page before my assistant reads it, so that summarising a page can't hand it my session.
- **Traces:** JTBD-01, JRN-01/#6
- **Acceptance criteria:**
  - Given a page with a confirmed hidden instruction, when the page is ready, then the offending nodes are neutralised and the change is reversible from the banner.
  - Given neutralisation ran, when I click "restore", then the page returns to its original DOM.
- **Priority:** must
- **Status:** proposed

### ST-004: Confirm before an agent acts on a compromised page
- **Story:** As P-01, I want a confirmation step when an assistant is about to act on a page where an injection was found, so that a poisoned page can't drive an action silently.
- **Traces:** JTBD-01, JRN-01/#6
- **Acceptance criteria:**
  - Given a page with an unresolved finding, when a sensitive action is attempted from it, then the action pauses until I confirm.
- **Priority:** should
- **Status:** proposed

### ST-005: Block known-malicious pages
- **Story:** As P-01/P-02, I want known phishing and malware pages stopped before they render, so that I never face the decision at all.
- **Traces:** JTBD-02, JRN-03/#2
- **Acceptance criteria:**
  - Given a URL matching a signed feed entry, when I navigate to it, then an interstitial replaces the page and states the source of the verdict.
  - Given I choose "continue anyway", then the choice is remembered for that domain and recorded in the journal.
- **Priority:** must
- **Status:** proposed

### ST-006: Lookalike domain warning
- **Story:** As P-01/P-02, I want to be warned when a domain merely looks like one I trust, so that a homoglyph or typo domain doesn't collect my login.
- **Traces:** JTBD-02
- **Acceptance criteria:**
  - Given a domain whose decoded punycode or confusable-normalised form is near a domain on my watchlist or the popular-domains list, when it loads, then a warning names both the real and the visited domain.
- **Priority:** must
- **Status:** proposed

### ST-007: ClickFix interception
- **Story:** As P-02, I want to be stopped when a page copies a command and tells me to run it, so that a fake CAPTCHA can't turn me into the delivery mechanism.
- **Traces:** JTBD-02, JRN-03/#3
- **Acceptance criteria:**
  - Given a page writes a shell-like command to the clipboard without a genuine user copy action, when that happens, then a blocking warning appears stating that a real verification never asks you to leave the browser.
  - Given the warning is shown, when I dismiss it, then dismissal requires a deliberate action, not a stray click.
- **Priority:** must
- **Status:** proposed

### ST-008: Escape a browser-lock trap
- **Story:** As P-02, I want a way out when a page traps me in fullscreen with looping dialogs, so that a fake "virus detected" screen doesn't push me into calling a scam number.
- **Traces:** JTBD-02, JTBD-06
- **Acceptance criteria:**
  - Given a page forces fullscreen or loops modal dialogs, when detected, then the trap is broken and a plain-language explanation is shown.
- **Priority:** should
- **Status:** proposed

### ST-009: Download check
- **Story:** As P-01/P-02, I want downloads checked before they land, so that a fake update doesn't install a stealer.
- **Traces:** JTBD-02
- **Acceptance criteria:**
  - Given a download starts, when its source or hash matches a known-bad entry, then a warning appears before the file is saved, naming the reason.
  - Given the file cannot be hashed, when the check runs, then the UI says which checks did and did not apply.
- **Priority:** must
- **Status:** proposed

### ST-010: Credential-entry guard
- **Story:** As P-01/P-02, I want a warning before I type a password or card into an untrusted or brand-new domain, so that I stop at the last useful moment.
- **Traces:** JTBD-02, JRN-03/#4
- **Acceptance criteria:**
  - Given a password or payment field on a domain that is neither trusted by me nor established, when I focus it, then an inline warning states why this domain is unusual.
- **Priority:** must
- **Status:** proposed

### ST-011: Offline password-leak check
- **Story:** As P-01, I want to know a password is compromised without sending it anywhere, so that checking my security isn't itself a leak.
- **Traces:** JTBD-04, JTBD-05, JRN-02/#1
- **Acceptance criteria:**
  - Given a password is checked, when the check runs, then only a hash prefix ever leaves the device, and the journal records exactly what was sent.
  - Given the password is in the local corpus, when checked, then the verdict is produced with no network request at all.
- **Priority:** must
- **Status:** proposed

### ST-012: Leak inventory with fresh sources
- **Story:** As P-01, I want to see which of my accounts appear in breaches and infostealer logs, so that I fix the ones that actually matter.
- **Traces:** JTBD-04, JRN-02/#2-3
- **Acceptance criteria:**
  - Given a monitored email or phone, when the check runs, then results name each source, its date, the exposed data classes, and separate fresh infostealer hits from historical dumps.
  - Given sources were unavailable, when results are shown, then the UI names which sources were not checked.
- **Priority:** must
- **Status:** proposed

### ST-013: Extension watch over time
- **Story:** As P-01, I want to be told when an installed extension changes owner or gains permissions, so that a tool I trusted can't become spyware unnoticed.
- **Traces:** JTBD-03
- **Acceptance criteria:**
  - Given an installed extension updates, when its permissions or publisher differ from the last snapshot, then an alert names the exact delta.
- **Priority:** must
- **Status:** proposed

### ST-014: Act on a risky extension
- **Story:** As P-01, I want to disable or trust an extension straight from the alert, so that knowing about the risk and handling it are one step.
- **Traces:** JTBD-03
- **Acceptance criteria:**
  - Given an extension alert, when I choose "disable", then the extension is disabled and the action is journalled; when I choose "trust", then this delta stops being reported.
- **Priority:** must
- **Status:** proposed

### ST-015: Plain-language explanation and repair
- **Story:** As P-01/P-02, I want every verdict explained in ordinary words with the next step attached, so that an alert produces an action rather than anxiety.
- **Traces:** JTBD-04, JTBD-06, JRN-02/#4
- **Acceptance criteria:**
  - Given any finding, when I open it, then I see what happened, why it matters to me, and at most three concrete next steps, at least one executable in place.
  - Given a step is completed, when I return, then the item is marked resolved and leaves the active queue.
- **Priority:** must
- **Status:** proposed

### ST-016: Undo and appeal a wrong verdict
- **Story:** As P-01, I want to overrule a wrong verdict instantly and, as P-03, to check and appeal my own site's status, so that a false positive costs seconds instead of customers.
- **Traces:** JTBD-02, JTBD-08, JRN-01/#5
- **Acceptance criteria:**
  - Given a verdict I disagree with, when I click "this is wrong", then the block is lifted for that domain and the decision is remembered.
  - Given a domain, when its owner checks status on the public page, then the current verdict, its source, and an appeal path are shown without an account.
- **Priority:** should
- **Status:** proposed

### ST-017: See what left the device
- **Story:** As P-01, I want a log of every outbound request the product made, so that "we don't collect your browsing" is something I can verify rather than believe.
- **Traces:** JTBD-05, JRN-01/#7
- **Acceptance criteria:**
  - Given any outbound request, when it is made, then the journal records destination, purpose, and the exact payload shape before sending.
  - Given a week of use, when I open the panel, then I can see the count and detail of every request, and export it.
- **Priority:** must
- **Status:** proposed

### ST-018: Instant first check
- **Story:** As P-01, I want a useful result within seconds of installing, so that I can judge the product before configuring anything.
- **Traces:** JTBD-02, JTBD-04, JRN-01/#4
- **Acceptance criteria:**
  - Given a fresh install, when the first-run screen opens, then open tabs and installed extensions are checked locally and findings appear in under 30 seconds without an account.
- **Priority:** should
- **Status:** proposed

### ST-019: Own my data
- **Story:** As P-01, I want to export or wipe everything the product stored, so that leaving costs nothing.
- **Traces:** JTBD-05
- **Acceptance criteria:**
  - Given the settings screen, when I export, then a JSON file with all local data is produced; when I wipe, then all local data is deleted after one confirmation.
- **Priority:** should
- **Status:** proposed

### ST-021: Judge the product before installing it
- **Story:** As P-01, I want to see what this thing refuses to do before I install it, so that I can trust a security tool that asks for broad permissions.
- **Traces:** JTBD-05, JRN-01/#2, JRN-01/#3
- **Acceptance criteria:**
  - Given no prior knowledge and no installation, when I open the product's own page, then I can read what it does, what it does **not** do, and what leaves the device — without running a script and without an account.
  - Given that page, when I follow the privacy link, then I read the same claims in more detail, and the two do not disagree.
- **Priority:** must
- **Status:** implemented
- **Note:** written 2026-08-20 (B-22). The journey had carried this step since it was drawn — JRN-01 stages 2 and 3 are Discover and Install — and the pages were built and gated in B-15, but no story tied the two together, so SCR-17 and SCR-18 belonged to no flow. The gap was recorded in the screen entries on 2026-08-12 and named honestly rather than filled with an invented flow; this is the story that was missing, and FLW-18 is the flow that traces to it.

### ST-020: Quiet mode for a protected relative
- **Story:** As P-01 acting as carer, I want a mode that stays silent except for serious events, so that a relative isn't trained to dismiss warnings.
- **Traces:** JTBD-07
- **Acceptance criteria:**
  - Given quiet mode, when a low-confidence finding occurs, then it is journalled without interrupting; when a high-confidence one occurs, then it interrupts unmissably.
- **Priority:** could
- **Status:** proposed
- **Kill criteria:** if no carer configures it within 3 months of release → drop the mode, keep the confidence thresholds. **[assumption]** — segment desirability untested.

### ST-022: Check one message on demand
- **Story:** As P-01, I want to hand a single message to the checker and get a verdict, so that a message I am unsure about has an answer that is not my own feeling.
- **Traces:** JTBD-09, JRN-04/#4, JRN-04/#5
- **Acceptance criteria:**
  - Given a message file, when I ask for it to be checked, then I get a verdict that names each signal that fired and each check that did not run, with its reason.
  - Given a message with nothing wrong, when I check it, then the answer says so and still lists what was checked.
  - Given a message the parser cannot read, when I check it, then it says the message could not be read — never that it is clean.
- **Priority:** must
- **Status:** proposed

### ST-023: Judge the sender by what the sender cannot forge
- **Story:** As P-01, I want the sender judged by the authentication the receiving server already performed and by the shape of the address, so that a display name I recognise is not what decides.
- **Traces:** JTBD-09, JRN-04/#1, JRN-04/#5
- **Acceptance criteria:**
  - Given a message whose SPF, DKIM or DMARC result is a failure, when it is checked, then that is named as a signal in plain words.
  - Given a display name carrying a brand whose domain the address does not belong to, when it is checked, then the mismatch is named and both halves are shown.
  - Given a sender domain that is a punycode or homoglyph neighbour of a known one, when it is checked, then it is named the same way the browser side names a lookalike.
  - Given a message whose headers carry no authentication result at all, when it is checked, then that absence is reported as a check that did not run — not as a pass.
- **Priority:** must
- **Status:** proposed

### ST-024: See where a link really goes, and what the message hides
- **Story:** As P-01, I want every link judged by its destination rather than its text, and any text hidden from me but visible to a machine surfaced, so that neither I nor an assistant reading my mail is steered by something I cannot see.
- **Traces:** JTBD-09, JTBD-01, JRN-04/#5
- **Acceptance criteria:**
  - Given a link whose visible text names one address and whose target is another, when the message is checked, then both are shown side by side.
  - Given a link to a host on the blocklist the browser side already uses, when the message is checked, then it is named with the same words that side uses.
  - Given text present in the message but not perceivable by a human and phrased as an instruction, when the message is checked, then it is reported as an instruction planted for a machine.
- **Priority:** must
- **Status:** proposed

### ST-025: Judge an attachment without opening it
- **Story:** As P-01, I want attachments judged as bytes in an isolated process, so that checking a file is never the thing that runs it.
- **Traces:** JTBD-09, JRN-04/#6
- **Acceptance criteria:**
  - Given an attachment whose real type, declared type and extension disagree, when it is checked, then the disagreement is named.
  - Given a filename carrying a bidirectional-override character, when it is checked, then the name is shown as stored and as displayed, and the trick is named.
  - Given any attachment, when it is checked, then no application on this machine is asked to open, render, preview or index it, and the parse runs in a process with no network and no write access.
  - Given a parser that crashes or exceeds its ceiling, when that happens, then the check is reported as not run, the rest of the message is still judged, and nothing else on the machine is affected.
- **Priority:** must
- **Status:** proposed

### ST-026: Choose who reviews, and be told what leaves
- **Story:** As P-01, I want to choose whether the final review runs on my machine, in a cloud model I selected, or not at all — and to be told exactly what left, so that the product's privacy claim survives contact with a language model.
- **Traces:** JTBD-09, JTBD-05, JRN-04/#4
- **Acceptance criteria:**
  - Given no configuration, when a message is checked, then the review runs locally or not at all, and nothing leaves the device.
  - Given the cloud review is switched on deliberately, when a message is checked, then the outbound record is written before the request, names the model, the provider and the size of what was sent, and a refusal to record cancels the request.
  - Given the cloud review is on, when the request is made, then it is routed only to an endpoint that retains nothing, and a route that cannot promise that is not used.
  - Given the reviewer is unavailable for any reason, when a message is checked, then the deterministic verdict still stands and the output says the review did not run.
  - Given any reviewer, when it answers, then it cannot raise the severity above what the deterministic checks found.
- **Priority:** must
- **Status:** proposed

## Assumptions register

| # | Assumption | Type | Risk | How to test |
|---|---|---|---|---|
| A-1 | P-01 will accept broad host permissions from a security extension because the source is open | desirability | high — it is our install funnel | Store listing copy test; ask 5 target users to read the permission screen aloud |
| A-2 | Users read and value the self-audit panel rather than merely liking that it exists | usability | medium — it is our main differentiator | Instrument nothing; ask 5 users to answer "what did it send this week?" using only the UI |
| A-3 | Hidden-instruction findings on ordinary browsing are frequent enough to feel useful, not rare enough to feel decorative | viability | high | Measure finding rate on the personal browsing of 3 testers over 2 weeks |
| A-4 | Automatic neutralisation never visibly breaks a page | feasibility | high | Run the sanitiser over the top-1000 domains, diff rendered output. **Untested, and now says so in both places (B-49):** REQ-03 and REQ-10 carried this as a closed acceptance criterion while this table carried it as an open assumption — two documents disagreeing about one fact. It needs network and a browser over a thousand live sites, which no gate in this repository can do; what *is* measured is reversibility (SCN-005) and the three refusals a page can force |
| A-5 | The carer segment (JTBD-07) exists at all | desirability | low — gated behind ST-020 `could` | Kill criteria on ST-020 |

## Monetization

- **Model:** none — free, source-available (PolyForm Noncommercial or Internal
  Use, ADR-0015). Free for individuals and for a company's internal use; commercial
  redistribution by separate licence. No paid tier, no
  billing, no upsell surfaces, no paywalled features. Decided 2026-08-04.
  Consequence: no paywall/trial/dunning flows exist downstream, and any
  future monetisation is a foundation change, not a feature.

## Design tooling

- **Figma:** disabled
- **Figma file:** none
- Decision 2026-08-04: the chain is built text-first with ASCII wireframes in
  `wireframes/`.
- **Corrected 2026-08-12.** This block used to continue "Figma is switched on
  before any interface code is written — at that point every screen state gets a
  frame link in `screens.md`". That did not happen: seventeen screens were built
  with Figma off, and the sentence sat here through all of them describing an
  intention as a rule. What actually happened, and what holds now: the wireframes
  in `wireframes/` are **generated from the renderers** by `tools/wireframes.mjs`
  and gated by `tools/wireframes.test.ts`, so they cannot drift from the code —
  which is a stronger guarantee than a frame link, and a different one. `screens.md`
  is the record of intent; the wireframe is derived evidence. Switching Figma on
  is still open, and it is now a decision to make deliberately rather than a
  promise already broken.

## Product mechanics

- **Personalization:** rule-based — a user-editable watchlist of the brands
  they actually use (bank, exchange, mail) drives lookalike and typosquat
  detection. Correction path: every watchlist-derived warning can be
  dismissed and the entry edited from the warning itself.
- **Engagement mechanics:** none — no streaks, points, badges, or scores.
  Security alerts must not be gamified, and a "protection score" would create
  pressure to inflate findings.
- **Accessibility regime:** none stated legally; target is WCAG 2.2 AA for
  all extension surfaces, owner is the project maintainer. Consequence:
  warnings never rely on colour alone, in-page banners are keyboard
  reachable, and interstitials are screen-reader announced.
