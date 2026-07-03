# Post-Test Punch List — Execution Report

Branch: `sam-overhaul` (fixes before merge). One commit per group. No deploys (Greg redeploys).
`node --check` run with no pipe on every changed file. Permitted D1 write: item 4 only.

---

## Group A — compliance correctness (commit 1)

### Item 1 — FEC authority bug (federal race → state SOS). ROOT CAUSE + fix.
**Root cause:** the finance-report and donation-limit lookup handlers (`/api/finance/lookup`,
`/api/donation/lookup`) resolved the authority with `fetchAuthorityForRace(stateCode, jurisdictionName)`
— a **state-only** helper that queries `compliance_authorities WHERE state_code = ? AND jurisdiction_type
= 'state'`. It has **no notion of office level**, so a U.S. House (federal) candidate in Louisiana got
the Louisiana state authority (LA SOS). The campaign_reference rows weren't the culprit — the source
cascade for these two fact classes is stubbed (`tryFecReportingCalendar` etc. are commented out), so
every call fell straight to `fetchAuthorityForRace`, which is federal-blind. (Compliance/qualifying and
jurisdiction lookups correctly stay state-based — qualifying is state-administered even for federal
office — so `fetchAuthorityForRace` was left unchanged for those.)

**Fix:** added `isFederalOffice(office)` and `fecAuthority(factClass)` helpers. In the finance and
donation lookup handlers, authority now resolves office-level-aware:
`isFederalOffice(office) ? fecAuthority(...) : fetchAuthorityForRace(...)`. Federal races →
**Federal Election Commission (FEC)**, `fec.gov`, 1-800-424-9530 (deadlines URL for finance,
contribution-limits URL for donations). The web_search fallback query for federal races now targets
"FEC federal" instead of the state name. State/local races: unchanged.

### Item 2 — Trust-ladder fall-through (rung 3 empty → rung 4).
Updated **MODULE_TRUST_LADDER rung 3**, **MODULE_TOOL_GUIDANCE**, and the three `lookup_*` tool
descriptions: call the tool FIRST, but if it returns no verified data, **do not stop at a bare
deferral** — fall through to `request_web_search` targeting the official source (fec.gov for federal
finance/limits, the candidate's state SOS otherwise), cite what's found, and add a one-line advisory to
confirm with the named authority before acting. Budget guard stays green (TRUST_LADDER 355/500, base
1959/2500).

### Item 3 — Placeholder leak ("unsupported" quoted to the user). Fixed at the data layer.
Sam quoted the internal token `unsupported`. The pre-fetch prompt block already naturalizes it
(worker.js ~9054), so the leak was the **tool-result** path. Added `naturalizeLookupForModel(result)`
and applied it to every model-facing return of the compliance / finance / donation / jurisdiction
lookup endpoints (both the cached-formatter and fresh-result paths). It maps `status`/`source ===
'unsupported'` and null values inside the data sub-objects (reports/limits/deadlines/schedule) to
**"no verified data available"** before the JSON ever reaches the model. Safe because the client never
reads `status` (confirmed: `app.html` has zero references to `unsupported`) and the server-side
validators use internal lookups, not this HTTP response.

**Verification:** `node --check worker.js` + `lib/sam_prompt_modules.mjs` pass (no pipe); budget guard green.

---
## Group B — verified data (commit 2)

### Item 4 — Louisiana 2026 U.S. House campaign_reference update (the one permitted D1 write)
Applied `migrations/002_la_house_2026.sql` (`wrangler d1 execute … --remote --file …`). Three rows
updated; verified exactly 3 rows now carry the new source (`56a2dabafbc9ca70`, `082540aec9f1b04d`,
`7b05300ec0cff83e`). New source on all three:
`source_name = 'Louisiana Act 7 of 2026 Regular Session; LA Secretary of State release (2026-05-14)'`,
`source_url = 'https://www.sos.la.gov/OurOffice/PublishedDocuments/05.14.26FallHouseRaces.pdf'`,
`last_verified_date = '2026-07-02'`, `update_frequency = 'per_cycle'`. Full UPDATE statements are in the
migration file. Before → after:

**`56a2dabafbc9ca70`** — "Do federal elections use the same jungle primary as state elections?"
- BEFORE: "No. Beginning with the 2026 cycle (per Act 1 of 2024 1st Ex. Sess.), Louisiana utilizes a
  closed partisan primary system for U.S. House and U.S. Senate races…"
- AFTER: "As of Act 7 of the 2026 Regular Session, U.S. House races have been MOVED onto Louisiana's
  Nov 3, 2026 open 'jungle' primary ballot … Dec 12, 2026 general runoff if needed. The … May 16, 2026
  closed-primary races … no longer applies. U.S. Senate is not on the 2026 ballot."

**`082540aec9f1b04d`** — "When is the 2026 primary election for Congress and State offices?"
- BEFORE: "Due to the ongoing Callais redistricting litigation, early 2026 primary dates were
  suspended. The state is currently anticipating a rescheduled primary in late Summer (July/August)
  2026…"
- AFTER: "Per Act 7 of the 2026 Regular Session, U.S. House races are on the Nov 3, 2026 open primary
  ballot, with a Dec 12, 2026 general runoff … The previously scheduled May 16, 2026 closed federal
  primary was cancelled."

**`7b05300ec0cff83e`** — "When is the statutory qualifying period for the 2026 Fall elections?"
- BEFORE: "…Candidates in the new closed primary (Federal, …) face a completely different, earlier
  qualifying schedule … highly volatile due to litigation."
- AFTER: "For the Nov 3, 2026 open primary — which now includes U.S. House races … — the qualifying
  period opens Wednesday, Aug 5, 2026 and closes Friday, Aug 7, 2026 at 4:30 p.m. The earlier
  split/closed-primary qualifying schedule for U.S. House was cancelled."

(No worker.js change in this group — data only.)

---
## Group C — behavior fixes (commit 3)

### Item 5 — same-turn permission bypass (both layers fixed)
- **(a) Prompt:** MODULE_HARD_CONSTRAINTS #1 now says: if you ask a permission question, STOP — do
  NOT emit the action's tool call in the same turn; ask, then wait. Added a bad/good example.
- **(b) Server-side guard (implemented — it was clean):** in `callGemini`'s response translation, if
  the turn's text contains a permission question (`?` + "would you like / want me to / should i /
  shall i / can i add …") AND the model also emitted a gated write-tool call
  (add_calendar_event/update_task/…/save_note/etc.), the tool_use block(s) are dropped and the
  question is kept, so the client can't execute the offered action. Non-write tools (navigate_to,
  lookup_*, request_web_search) are unaffected.

### Item 6 — affirmation routing
Added `isBareAffirmation()` + `lastAssistantOfferedAction()`. When the latest user message is a bare
affirmation ("yes", "please", "do it", …) AND the most recent assistant message was an offer (a
"would you like me to…?" question), the turn now (a) forces `_chatRoute = 'action'` in `callGemini`
(full toolset available) and (b) bumps a `conversational` classification to `strategic` so the
conversational framing doesn't drop the offer. History is already sent, so Sam sees its own offer +
the "yes" and executes it.

### Item 7 — grounding citation rendering (no vertexaisearch domains)
- `extractGroundingResult` now returns `sources: [{title, uri}]` using `groundingChunks[].web.title`
  (publisher/domain) for display; the vertexaisearch redirect stays as the `uri`.
- `runGroundingSubturn` returns those title+uri pairs plus a render hint, and its systemInstruction
  now says to cite by publisher/domain, never a raw redirect URL.
- Added `scrubGroundingRedirects()` and applied it to the search-route response text in `callGemini`:
  redirect URLs are swapped for the source title and any bare `vertexaisearch.cloud.google.com`
  mention is stripped. Verified with a small logic test (markdown link, bare URL, bare domain all
  cleaned).

### Item 8 — "Done! What would you like to work on next?" bubbles. ROOT CAUSE (frontend).
**Origin: FRONTEND — `app.html` lines 9877–9882**, the branch
`if (!fullText.trim() && confirmations.length === 0) { … 'Done! What would you like to work on
next?' … }`. It appends the generic bubble whenever the backend response had **no user-visible text
AND no action confirmations**. That happens on **tool-call rounds** (a lookup_*/search turn where the
model emitted only a tool_use with no accompanying text — normal, it's awaiting the tool result next
turn) and on read-only turns with no confirmation. There is **no backend source** — worker.js only has
the distinct empty-content fallback "I'm here to help! What would you like to work on?" (callGemini,
different string). Per the instruction, this is documented for the upcoming **frontend job**, not
changed here. Recommended frontend fix: in that branch, do NOT emit the generic bubble for
read-only/lookup/search tool rounds; for action turns, render Sam's own confirmation text instead of
the generic bubble. (Backend note: a text-less response on a tool-call round is expected model
behavior; the frontend shouldn't treat it as a completed action needing a "Done!" acknowledgement.)

**Verification:** `node --check worker.js` + module pass (no pipe); budget guard green (2020/2500);
scrub logic unit-tested.

---
## Group D — morning briefing (commit 4)

### Item 9 — time-of-day greeting
Extracted the 50-state (+DC) timezone map to a module-scoped `STATE_TIMEZONES` and added
`localTimeContext(state)` → `{ tz, hour, timeStr, greeting }` (morning <12, afternoon 12–17, else
evening). The main chat path now references the shared map (no duplication). The morning-brief system
prompt is told the candidate's current local time and to open with the correct greeting, "do NOT
assume it is morning." Verified: 6 PM → "Good evening" (the reported 6:02 PM bug), 6 AM → "Good
morning", 1 PM → "Good afternoon".

### Item 10 — briefing news scoping
- Search queries rewritten to be race/district/state-scoped — `"[district] [state] race news [yr]"`,
  `"[candidate] [state] campaign news [yr]"`, `"[loc] [state] local political news [yr]"`,
  `"[state] [party] state politics news [yr]"` — no bare `"news this week"` / `"local news"` that
  gets geo-localized by the requester IP (the KTLA / Cowboys leak).
- Added to the brief prompt: include ONLY items plausibly relevant to the race, district, or the
  candidate's state politics; exclude national/sports/entertainment/out-of-state; and if the research
  has no relevant items, **say exactly that in one sentence — do not pad**.

### Item 11 — relative-date guidance
Added one line to MODULE_HARD_CONSTRAINTS #7: when the candidate says "next [weekday]" and that weekday
is within the next ~2 days, CONFIRM which date they mean before scheduling ("next Friday" on a
Thursday is ambiguous). Budget still green (HARD_CONSTRAINTS 1014/1050, base 2057/2500).

**Verification:** `node --check worker.js` + module pass (no pipe); budget guard green; greeting logic
unit-tested.

---

## Done — handoff + redeploy

- Refreshed `02_BACKEND_WORKER.txt` and `04_SAM_PROMPT_AND_TOOLS.txt` against the branch (they now
  include the punch-list changes and the new `lib/url_authority.mjs`).
- Root causes documented: **item 1** (state-only `fetchAuthorityForRace`, office-blind — Group A) and
  **item 8** (frontend `app.html` ~9877 empty-response branch — Group C).
- **Single redeploy command for Greg** (backend only — no frontend files changed; item 8 is a separate
  frontend task):
  ```powershell
  wrangler deploy worker.js --name candidate-toolbox-secretary2 --compatibility-date 2026-04-07
  ```
  (The item-4 D1 update is already applied to production; no migration to run.)

