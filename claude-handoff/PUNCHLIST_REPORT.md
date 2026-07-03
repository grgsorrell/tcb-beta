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
<!-- Groups appended below as completed. -->
