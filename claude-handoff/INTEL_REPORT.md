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

**STOP — awaiting go-ahead for Phase 1.**
