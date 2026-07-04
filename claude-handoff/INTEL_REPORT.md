# Intel Redesign — Execution Report

Branch: `intel-redesign`, branched from **master `da0f9b77b7b0a2460bbc7be8baaaf2121b6d538a`** (the
post-merge SHA — pm-punchlist-2 was fast-forwarded into master and pushed to origin at the start of this
job, reconciling the repo with the deployed worker). Spec saved verbatim at `claude-handoff/INTEL_SPEC.md`.

Hard rules: no deploys; one commit per phase, stop-and-report between phases; only permitted D1 change is
the `voter_contact` table (Phase 1); cost controls preserved (panel renders from CACHED data only — no
model/search on open; 24h/72h cooldowns stay; chips are the only Sam triggers). Navy/gold branding +
mobile-first; logo and Sam avatar untouched.

---

## Phase 0 — RECON (read-only, no code changes)

### Where Intel lives
- **Entirely in `app.html`** (9,923 lines). Backend `worker.js` only serves the data: District Pulse via
  `mode:'research'` (Gemini grounding) and opponents via `/api/opponents/*`.
- Entry: nav button `toggleOverlay('intel')` (app.html:772) → `renderIntelOverlay()` (6264) →
  `renderIntelPanel()` (6266). Container is `#intel-content`; tabs render into `#intel-tab-content`.
- Current structure is **4 tabs** (`renderIntelPanel` 6266): My Opponents / District Pulse / Threat
  Assessment / Opposition Notes. The redesign replaces the tab strip with the hero + three sections
  (Opponents / Money / Today); Threat Assessment + Opposition Notes logic can be retired or folded.

### Cost controls already in place (must preserve)
- Cache: `ctb_intel_data` localStorage via `getIntelCache`/`saveIntelCache` (6243-6248).
  `isIntelStale(tabKey, hours)` defaults 72h (6249).
- **Panel open renders from cache** — `loadIntelTab` (6302) reads `cache.pulse` and only calls
  `fetchPulse()` (a model/search call, 6420) when stale or force-refreshed. Opponents come from D1
  (`loadOpponentsFromD1`, 6510) — no model call on open. So "cached-only on open" is already the
  contract; the redesign must keep it.
- Manual refresh enforces a 72h cooldown (`refreshActiveIntelTab`, 6350). Per-opponent cards enforce
  their own 72h cooldown (6754-6764).

### Data shapes (client-side)
- **intelContext → Sam** (built app.html 9615-9630, sent 9657): `{ opponents: intelOpponents.map(...),
  pulseItems: cache.pulse.data.items }`. Worker reads `intelContext.opponents` / `.pulseItems`.
- **District Pulse**: `cache.pulse.data = { items: [{ headline, summary, relevance, source_url,
  sentiment, date, category }] }`. Citation link render (6817-6821): gold `<a>` with `↗ hostname`,
  validates `^https?://`, `target=_blank rel=noopener`. `timeAgo(ts)` helper (6255) is available for
  "relative time." **Phase 5 reuses this block unchanged.**
- **Opponents**: `/api/opponents/list` → `intelOpponents = [{ id, name, last_researched_at, data:{...} }]`.
  `data` (`d`) carries: `party`, `threatLevel` (0-10), `office`, `bio`, `background`, `recentNews`,
  `campaignFocus`, `finances:{ cash_on_hand, total_raised, debts, last_report, last_report_year }`,
  `keyRisk`, `source` (`'fec_vps'` | web), `subScores`. **No `endorsements` field today** — Phase 3
  omits it unless present (per spec "endorsements if present").
- **Win number**: `campaignData.winNumber` (+ `winNumberData`); persisted to D1 profile `win_number`
  (loaded app.html 2286, saved 1708). Rendered as "Win Target" (2567). Guard at 1236 nulls truncated
  values (< 500).
- **Election date / days out**: `campaignData.electionDate`; `calcDaysToElection()` (2459) and
  `daysUntil(ds)` (1921).

### Opening Sam programmatically — the Phase 2 primitive
- `openSam()` (8323) opens the panel (adds `.open` to `#sam-panel`). `sendSamMessage()` (9486) is the
  **normal send path** — reads `#sam-input`, enforces rate limit + writes history.
- **`sendSamChip(text)` (8576) already does exactly what Phase 2 needs**: sets `#sam-input`, calls
  `openSam()`, then `sendSamMessage()`. `askSamAbout(q)` (8582) wraps it with a context suffix.
- **There is NO function named `openSamWithPrompt`.** Per spec, Phase 2 builds one — it will be a thin,
  well-named formalization over the existing `sendSamChip` → `sendSamMessage` path (so all chips route
  through the rate-limited, history-writing send path). The primitive effectively exists; Phase 2 names
  it and hardens it (guards for empty input, panel-already-open, etc.).

### Backend hooks for Phase 1
- **Ground Truth PACE injection point**: worker.js GROUND TRUTH block (~7192-7199, the `Budget: … | Win
  Number: …` region). Phase 1 item 5 adds a compact PACE block here.
- Migrations live in `migrations/` (e.g. `003_authority_urls.sql`); D1 name `candidates-toolbox-db`.
  Existing per-row endpoints show the auth pattern (`getSessionContext`, `Bearer` token, workspace
  scoping). Sam tool declarations are the `const tools = [...]` array in worker.js; client-executed
  tools are acknowledged/handled in `app.html`'s Sam response loop.

### Phase 6 fix locations (confirmed, deep-dive deferred to Phase 6)
- **Phantom "Done!" bubble**: app.html **9877** — branch `if (!fullText.trim() && confirmations.length
  === 0) { … 'Done! What would you like to work on next?' … }`. Fires on text-less tool-call rounds
  (read-only lookup/search rounds). Fix: suppress for read-only turns; for action turns let Sam's own
  confirmation stand.
- **"Campaign Document" over-wrap**: `isDocumentContent(text)` (app.html **9299**). False-positive clause
  is `text.length > 800 && hasMultipleParagraphs` — wraps any long conversational reply. Used at 9731,
  9839, 9862; title via `extractDocTitle` (9308, default "Campaign Document"). Fix: only wrap genuine
  documents (drafts/scripts/briefs/op-eds).
- **Folders/Notes restructure**: `ctb_folders` (folders array, 1248) + `ctb_notes`; `renderFoldersOverlay`
  (6181). Shannan wants Folders top-level, Notes as a default folder, "save to X folder" correct,
  existing notes migrate safely. Deep-dive in Phase 6.

### Branding / mobile
- Locked CSS vars (navy `--n1..n5`, `--gold`, etc.), `--font-d` Playfair / `--font-b` DM Sans. Reusable
  card class `.intel-card` (+ threat variants), `.intel-score`, `.intel-party-pill`, `.intel-relevance`.
  Overlays are full-screen panels (`toggleOverlay`) — the hero/sections inherit that. Logo (`icon512.png`)
  and Sam avatar (`samavatar.png`) are not touched.

### Recon conclusion
The redesign is achievable within the existing architecture with **one new D1 table** (`voter_contact`,
Phase 1) and **one new client primitive** (`openSamWithPrompt`, Phase 2, formalizing `sendSamChip`).
Cached-render-on-open already holds. Nothing in the redesign requires touching the model/search cost path
except the new Phase-1 endpoints (which are DB-only, no model calls).

### Phase plan (per spec)
- **Phase 1** — `voter_contact` table + `/api/voter-contact/log` & `/summary` + `log_voter_contact` Sam
  tool + shared pace-math function + PACE block in Ground Truth. (backend, commit 2)
- **Phase 2** — `openSamWithPrompt` + Reality Check hero (tiles, progress, pace sentence, quick-log,
  catch-up chip, instructional empty states). (frontend, commit 3)
- **Phase 3** — Opponents section (cards + contrast/weakness chips + empty state). (commit 4)
- **Phase 4** — Money section (tiles from Ground Truth, office-level chips, empty state). (commit 5)
- **Phase 5** — Today/pulse (reuse cached items + gold links, source + relative time, chips). (commit 6)
- **Phase 6** — polish/mobile + the three folded-in frontend fixes + folders migration + Greg's manual
  test checklist. (commit 7)

---

## Phase 1 — VOTER CONTACT PRIMITIVE (backend, commit 2)

### 1. D1 table (the one permitted D1 change — applied to remote)
`migrations/004_voter_contact.sql` — `CREATE TABLE voter_contact (id INTEGER PK AUTOINCREMENT, user_id
TEXT, date TEXT, doors/calls/texts INTEGER DEFAULT 0, created_at TEXT)` + `CREATE UNIQUE INDEX
idx_voter_contact_user_date ON (user_id, date)`. Applied via `wrangler d1 execute … --remote --file`
(2 queries, 3 rows written = schema objects; **purely additive, no existing data touched**). The unique
index is the conflict target for the additive upsert (the spec's "upsert today's row" requires
per-(user,date) uniqueness). **Scoping:** `user_id` holds the **workspace owner id** (matching the
profiles/budget one-row-per-workspace pattern) so the candidate and every field-team sub-user
contribute to ONE campaign pace. Verified the additive upsert against the live table with a throwaway
id: doors 40 then +10 → 50, calls → 25; row deleted after.

### 2. Endpoints
- `POST /api/voter-contact/log` — auth via `getSessionContext`, additive upsert to today's row (or
  `body.date`), returns `{ today, total, weeklyAvg }`.
- `GET /api/voter-contact/summary` — returns `{ total, weeklyAvg, weeklyHistory[], pace }`. Reads
  `win_number` + `election_date` from the workspace `profiles` row to compute pace server-side (see
  #4). No per-tab permission gate — field activity is campaign-wide; any authed workspace member logs.

### 3. Sam tool `log_voter_contact { doors, calls, texts, date? }`
Declaration added to the `tools` array with the exact spec description ("Log the candidate's voter
contact numbers … Additive … Confirm the totals back to the candidate."). **Executed server-side** in
`callGemini`'s tool loop (a dedicated block before the request_web_search escape hatch): it runs the
same `upsertVoterContact` helper, then feeds the updated totals back as a `functionResponse` with an
instruction to confirm them — so "I knocked 40 doors today" works end-to-end with no client wiring, and
never produces a client-side action bubble. Shares the identical upsert logic with the endpoint.

### 4. Pace math — single shared documented function
`computeVoterContactPace({ winNumber, daysToElection, totalContacts, weeklyAvg })` in worker.js is the
**one** implementation, called by both `/summary` and the Ground Truth block. Rules per spec:
`contact_target = win_number` **(commented `v1 — multiplier to be tuned by Shannan`, the tuning knob)**;
`weeks_remaining = max(1, days/7)`; `weekly_needed = (target − total)/weeks_remaining`; `on_pace` when
last-21-day weekly avg ≥ weekly_needed else `behind`; `not_started` when no contacts; `no_target` when
no win number; `projected_total = total + weekly_avg × weeks_remaining`. `getVoterContactData` computes
`total`, the last-21-day `weeklyAvg` (21-day sum ÷ 3), and per-week history. Unit-tested: all five
status branches, `weekly_needed = 1200` and `projected = 10000` for the worked example, and the
`weeks_remaining ≥ 1` floor.

### 5. PACE block in Ground Truth
Injected right under the Win Number line (worker.js ~7373), **3 compact lines** (target/logged/recent/
needed + status/projected), or one line for `no_target`. Built from `computeVoterContactPace` with the
turn's `winNumber` + `effectiveDays` and a `getVoterContactData(chatOwnerId)` read. Wrapped in
try/catch → empty block on any failure, never blocks a chat turn.

### Verification (Phase 1)
- `node --check worker.js` → exit 0 (no pipe).
- **Prompt budget guard GREEN — BASE ASSEMBLY 2380 / 2500, unchanged.** (The PACE block lives in
  per-turn Ground Truth, not in the four budgeted module constants, so it doesn't affect the guard.)
- Additive upsert validated against the live remote table (then cleaned up); pace math unit-tested
  against the spec rules.
- Cost controls untouched: the new endpoints are DB-only (no model/search calls); the server-side tool
  does a DB write only.

### Deferred to the final phase
Handoff dumps `02_BACKEND_WORKER.txt` / `04_SAM_PROMPT_AND_TOOLS.txt` will be refreshed once in Phase 6
(rather than every phase) to keep per-phase diffs focused.

### Endorsed design decisions (Phase 1, confirmed by Greg)
- **`user_id` = workspace owner id** in `voter_contact` — pace is a campaign-wide metric; the candidate
  and every field-team sub-user roll into one picture. (Not per-caller.)
- **`log_voter_contact` executes server-side** in the callGemini loop (not client-executed like the
  other action tools) — the tool only writes to D1, so handling it server-side makes it work end-to-end
  with no client wiring and produces no client action bubble.

---

## Phase 2 — REALITY CHECK HERO (frontend, commit 3)

### 1. `openSamWithPrompt(text)` — the chip primitive
Added to app.html: opens the Sam panel (`openSam()`), sets `#sam-input`, and calls `sendSamMessage()` —
the **normal send path**, so every chip goes through the existing rate limit + chat-history write.
`sendSamChip()` now delegates to it (single implementation). Chip prompts are stored as constants
(`RC_PROMPTS`) and dispatched by key (`rcChip('catchup'|'next'|'winnum')`) so the exact spec prompt text
(with apostrophes) lives in a JS constant and needs no inline-onclick quote-escaping.

### 2. Hero — always visible, above the tabs
`renderIntelPanel()` now renders `#reality-check-hero` above the tab strip and calls
`loadRealityCheckHero()`. The hero:
- **Three stat tiles** (wrap at phone width via `flex-wrap`): **Win Number** (`campaignData.winNumber`),
  **Days Out** (`calcDaysToElection()`), **Pace** — green "On pace" / amber "Behind" / neutral "Not
  started" (`.rc-pace-on/behind/idle`), with logged-contacts subtext.
- **Progress bar** `total_contacts / contact_target` (navy→gold gradient fill, capped 100%).
- **Pace sentence — exact spec copy, aggressively rounded**: "At this pace you reach ~X of Y by election
  day — staying on track means ~N doors or M calls per week." Projected rounded to nearest 100, target
  as-is, weekly to nearest 10; `rcFmt` guarantees no unrounded decimals anywhere.

### 3. Quick-log row
Doors / Calls / Texts number inputs + "Log today" → `logVoterContactToday()` POSTs to
`/api/voter-contact/log` (with the client's local date) and on success calls `loadRealityCheckHero()` to
re-fetch the summary and re-render the hero in place — **no full panel reload**. Inputs and button carry
`aria-label`s; button is thumb-sized (`min-height:38px`).

### 4. Chip
- **behind** → "Ask Sam how to catch up" → the specced catch-up prompt.
- **on pace** → "Ask Sam what's next" → focus prompt.
Both via `rcChip(...)` → `openSamWithPrompt`.

### 5. Instructional empty states (never blank)
- **no win number** (`no_target`) → tiles + "Ask Sam to calculate your win number — it anchors
  everything on this page." + a chip that sends the calculate-win-number prompt.
- **no contacts** (`not_started`) → tiles + progress bar + "Log your first day of doors or calls and Sam
  starts tracking your pace." + the quick-log row (the affordance).

### Cost-control note (important for Phase 6 verification — do NOT false-flag)
The hero reads **`GET /api/voter-contact/summary` on panel open and after each quick-log POST**. This is
a **cheap D1 read, NOT a model or web-search call**. The "no calls on panel open" cost rule governs
**model + search spend only** (the pulse/opponent research paths). Panel open still fires **zero
model/search calls** — the pulse renders from the `ctb_intel_data` cache and opponents from D1 as
before. Phase 6's cost verification should confirm "no *model/search* calls on open," and the
`voter-contact/summary` read is expected and exempt.

### Open copy decision flagged for Shannan
The pace sentence's doors-vs-calls figures use a v1 **1:1 ratio** (`RC_CALLS_PER_DOOR = 1` in
`renderRealityCheckHero`), so "N doors or M calls" currently shows the same number — honest to the
equal-weight pace math. The spec's illustrative example (~180 doors / 420 calls) implies Shannan may
want calls to require more volume than doors; the constant is the single, commented hook to set that
ratio when she decides. Mirrors the `contact_target` "v1 — tuned by Shannan" pattern.

### Verification (Phase 2)
- All inline `<script>` blocks in app.html parse cleanly (`new Function` over each block) — validates the
  new functions and onclick quoting.
- No backend change this phase; worker budget guard unaffected.
- Branding: navy/gold, `--font-d`/`--font-b`, reused `.intel-*` idioms + new `.rc-*` classes; logo and
  Sam avatar untouched. Mobile: tiles + quick-log wrap; chips/buttons thumb-sized.

## Phase 3 — OPPONENTS SECTION (frontend, commit 4)

### Layout transition
`renderIntelPanel()` now renders the redesigned **stacked-sections** layout — hero +
`#intel-opponents-section` + (empty) `#intel-money-section` + `#intel-today-section` — **replacing the
old 4-tab strip**. Money fills in Phase 4, Today/pulse in Phase 5. The header refresh button belongs to
the Today section and is hidden until then. (District Pulse returns as the Today section in Phase 5;
this is an unmerged, undeployed branch, so the interim absence of the pulse view between Phases 3–5 is
expected.) The old tab renderers (`renderPulseTab` etc.) remain defined — Phase 5 reuses `renderPulseTab`
unchanged; dead ones get cleaned up in Phase 6.

### Opponent cards (from cached data — no model/search calls)
`loadOpponentsSection()` renders from the D1-backed `intelOpponents` (already loaded on panel open) and
cross-references the **cached** `ctb_intel_data.pulse` items — **zero new model/search calls on render**.
Each `renderOpponentSectionCard`:
- **Name + role/status** (`o.name`, `data.office`) + party pill.
- **Money raised with source label** — `Raised $… · Cash $…  (FEC|web)` from `data.finances` +
  `data.source`. **Omitted entirely when finances are unknown** (omit-rather-than-guess).
- **Latest cached pulse mention** — `findLatestPulseMention` scans the cached pulse items for the newest
  one naming the opponent (full name or last name ≥4 chars), rendered as "In the news: [headline] ↗
  [host] · [date]" with the existing gold source-link treatment. Omitted when none.
- **Two Sam chips** (every card ends in a verb): "Draft contrast message" / "Where are they weak?" →
  `oppChip(id, kind)` → `openSamWithPrompt` with the opponent's name. Chips **dispatch by opponent id**
  (not name) so apostrophe names (O'Brien) never break the inline onclick; the name is looked up from
  `intelOpponents` and only ever travels as data through the send path.

### No endorsements line — and why (per Greg's note)
The opponent research `data` has **no endorsements field**. Per the spec's omit-rather-than-guess rule,
the card simply **renders no endorsements line** — nothing is improvised. **Adding endorsements to
opponent research is a future backend item** (opponent-add/refresh would need to capture and store
them), not done here. A code comment marks the spot.

### Preserved functionality (no regression)
The add-opponent input (→ `addOpponentFromInput` → `/api/opponents/add` FEC research) is preserved as a
section footer, and subtle per-card **refresh** (respecting the **72h cooldown** cost control) + **remove**
controls are kept. The add/refresh/remove handlers' 7 re-render calls were repointed from
`renderIntelTabContent('opponents', …)` (old tab target) to `renderOpponentsSection()`. All write
controls stay gated by `canEdit('intel')`.

### Empty state (instructional)
No opponents → "No opponents tracked yet. Tell Sam who you're running against and he'll start building
their file." + a chip (`rcChip('addopp')`) that opens Sam. **Note:** Sam has no add-opponent *tool*
today, so the chip starts the conversation while the actual research still runs through the add-input;
a future `add_opponent` Sam tool would close that loop (logged as a follow-up, not built here).

### Verification (Phase 3)
- All inline `<script>` blocks parse cleanly; no leftover `renderIntelTabContent('opponents'…)` calls;
  new section functions present.
- Unit-tested: pulse-mention matching (newest match, `www.` stripped, no-match → null, short last name
  not over-matched), chip-prompt building (incl. an apostrophe name), and money-omit-when-unknown.
- Branding/mobile: reused `.intel-card` + new `.intel-section`/`.rc-chip-sm`; chips wrap; controls
  thumb-sized; aria-labels on refresh/remove/add. Navy/gold; logo/avatar untouched.

### Folded-in mitigation (Phase 3 follow-up, per Greg)
Opponents empty-state copy is now honest about both add paths: **"No opponents tracked yet. Add them by
name below, or tell Sam about them and he'll start building their file."** — naming the add-input
(rendered right below) alongside the Sam chip. (The `add_opponent` Sam tool remains a logged test-day
watch item / likely fast-follow, not built here.)

---

## Phase 4 — MONEY SECTION (frontend, commit 5)

`renderMoneySection()` renders `#intel-money-section` from **client Ground Truth only** — `contributions`
(summed) and `campaignBudget.fundraisingGoal`. **No network calls** (cost-safe on open).

- **Stat tiles**: **Raised** (`$` sum of contributions), **Goal** (`campaignBudget.fundraisingGoal`, or
  "— / not set"), and a progress bar `raised/goal` when a goal exists. Values via `rcFmt` (rounded, no
  decimals).
- **Comparison ratio — only when opponent finance data actually exists**: `getLeadingOpponentRaised()`
  returns the max `data.finances.total_raised` across `intelOpponents`, or **null** when no opponent has
  real finance data. The "vs Top Opp" tile (`1.4×`, subtext "their $X") renders **only** when that is
  non-null and both sides are > 0 — **never invented**. Unit-tested: null for no opponents and for
  opponents lacking finances; picks the max when present. Because opponent finances aren't known until
  the async opponents load completes, the opponents-load callback also re-runs `renderMoneySection()` so
  the ratio appears once the data lands.
- **Chip picked by office_level** (`isFederalRace()` — `officeType/govLevel === 'federal'`, with an
  office-string fallback for "Congress/US House/US Senate/President"): federal → "Build my call list"
  (FEC-data prompt), non-federal → "Build my call list" (personal-network / past-donors prompt). Both via
  `rcChip(...)`. Unit-tested: federal by level, US House by string, state senate / mayor → non-federal.
- **Empty state** (no goal and nothing raised): "Set a fundraising goal and log your contributions so Sam
  can track your money against the race." + a setup chip (`rcChip('moneysetup')`).

### Verification (Phase 4)
- All inline `<script>` blocks parse cleanly.
- Money logic unit-tested (ratio-only-when-opponent-data, office_level chip pick).
- No backend change; no model/search calls on render (client globals only). Navy/gold tiles reuse the
  `.rc-tile`/`.rc-bar` idioms; chips thumb-sized; logo/avatar untouched.

**STOP — awaiting go-ahead for Phase 5 (Today / pulse section).**
