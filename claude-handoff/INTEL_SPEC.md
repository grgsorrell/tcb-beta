=== INTEL REDESIGN SPEC ===
The Intel panel becomes the candidate's daily situational hub, organized around "am I on track to win?" Layout top to bottom: a Reality Check hero (always visible, not a tab), then three sections: Opponents, Money, Today. Core principle: EVERY card ends in a verb — one or two action chips that open the Sam chat panel with a pre-filled, context-loaded message. Intel that doesn't end in an action is just news.

HARD RULES: no deploys; one commit per phase, stop and report between phases; INTEL_REPORT.md maintained throughout; only permitted D1 change is the voter_contact table in Phase 1; preserve all cost controls (24h intel refresh cooldown stays law; the redesigned panel renders from CACHED data only — no model or search calls on panel open; chips are the only Sam triggers, on tap, inside the existing rate limit); match existing premium branding (navy/gold, existing fonts) and mobile-first patterns; do not modify the logo or Sam avatar assets.

PHASE 0 — RECON (read-only): map the current Intel implementation — which frontend file(s) render it, the shape of intelContext, the district pulse data structure and citation links, opponent research data, where win number and election date live client-side, and how the Sam panel is opened programmatically. If no function exists to open Sam with a pre-filled message, note it — Phase 2 builds one.

PHASE 1 — VOTER CONTACT PRIMITIVE (backend):
1. D1 table voter_contact (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, date TEXT, doors INTEGER DEFAULT 0, calls INTEGER DEFAULT 0, texts INTEGER DEFAULT 0, created_at TEXT). Migration file + apply remote.
2. Endpoints: POST /api/voter-contact/log (upsert today's row, additive), GET /api/voter-contact/summary (total contacts, last-21-day weekly average, per-week history).
3. New Sam tool log_voter_contact { doors, calls, texts, date? } — description: "Log the candidate's voter contact numbers when they report door-knocking, phone-banking, or texting activity, e.g. 'I knocked 40 doors today'. Additive to any numbers already logged for that date. Confirm the totals back to the candidate." Same upsert.
4. PACE MATH (single shared documented function): contact_target = win_number; weeks_remaining = max(1, days_until_election/7); weekly_needed = (contact_target − total_contacts)/weeks_remaining; pace_status = on_pace if last-21-day weekly avg >= weekly_needed, else behind; not_started if no contacts; no_target if no win number. projected_total = total_contacts + weekly_avg × weeks_remaining.
5. Inject a compact PACE block into Sam's per-turn Ground Truth (target, logged, weekly needed, status).

PHASE 2 — REALITY CHECK HERO (frontend):
1. Build openSamWithPrompt(text): opens the Sam panel and sends the message as the user through the normal send path (rate limit, history).
2. Hero card at top of Intel, always visible: three stat tiles (Win number; Days out; Pace — green On pace / amber Behind / neutral Not started), progress bar (total_contacts/contact_target), one plain-language pace sentence with rounded numbers ("At this pace you reach ~14,800 of 26,000 by election day — staying on track means ~180 doors or 420 calls per week").
3. Quick-log row: Doors/Calls/Texts inputs + "Log today" → POST, refresh hero without full reload.
4. One chip: behind → "Ask Sam how to catch up" → openSamWithPrompt("I'm behind on my voter contact pace. Build me a catch-up plan for the next 4 weeks using my calendar."); on pace → "Ask Sam what's next".
5. Empty states INSTRUCTIONAL, never blank: no win number → "Ask Sam to calculate your win number — it anchors everything on this page" + chip that does it; no contacts → "Log your first day of doors or calls and Sam starts tracking your pace."

PHASE 3 — OPPONENTS: one card per opponent from existing intel data (name, role/status, money raised with source label when known — omit rather than guess, latest cached pulse mention with source+date, endorsements if present). Chips: "Draft contrast message" / "Where are they weak?" → openSamWithPrompt with the opponent's name. Empty state: "No opponents tracked yet. Tell Sam who you're running against and he'll start building their file." + chip.

PHASE 4 — MONEY: stat tiles from Ground Truth (Raised, Goal, comparison ratio ONLY when opponent data exists — never invent). Chips: federal → "Build my call list" (FEC data prompt); non-federal → network/past-donors prompt; pick by office_level. Empty state instructional + setup chip.

PHASE 5 — TODAY (pulse): reuse cached district pulse items and gold citation links unchanged; add source + relative time per item, chips "Draft response" / "Why it matters" with the headline in the prompt. Keep existing refresh button + 24h cooldown UX exactly. Empty state: existing refresh affordance.

PHASE 6 — POLISH + MOBILE + FOLDED-IN FRONTEND FIXES:
1. Full-screen mobile consistent with other panels; hero tiles wrap at phone width; thumb-sized chips; accessibility labels on quick-log inputs and chips.
2. Verify no model/search calls fire on panel open (cached only) — state how verified.
3. Fix phantom "Done! What would you like to work on next?" bubbles (app.html ~9877, text-less tool-call branch): suppress for read-only turns; for action turns let Sam's own confirmation stand.
4. Fix "Campaign Document" copy-block wrapping ordinary conversational replies — wrap only genuine documents (drafts, scripts, briefs, op-eds).
5. Folders/Notes restructure per Shannan: Folders is the top-level concept, Notes becomes a default folder; "save to X folder" creates/saves to the right place; existing saved notes migrate safely into the default folder.

WHEN DONE: INTEL_REPORT.md ends with a manual test checklist for Greg covering: quick-log updates hero; "I knocked 40 doors today" to Sam reflects in hero; pace flips with volume; every chip opens Sam with the right pre-filled message and real context; all three empty states on a fresh account; mobile width; zero model calls on panel open; the three frontend fixes verified; folders migration didn't lose any notes. Do not merge, do not deploy.
=== END SPEC ===
