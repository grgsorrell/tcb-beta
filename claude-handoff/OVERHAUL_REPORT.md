# Sam Overhaul — Execution Report

Branch: `sam-overhaul` (never merged/deployed by this job). One commit per phase.
Source baseline: git HEAD `eea93d0`.

---

## Phase 0 — Recon (read-only)

**0.1 — `sam_engine` distribution** (`SELECT sam_engine, COUNT(*) FROM users GROUP BY sam_engine`):

| sam_engine | users |
|---|---|
| `gemini` | 1 |
| `haiku` | 22 |

→ 22 of 23 users (96%) are on the stale `haiku` default. Since the live chat path always runs
Gemini regardless of this flag, **nearly every user is currently missing the prompt/reference blocks
that are gated to one engine or the other** — exactly the split-brain Phase 1 fixes.

**0.2 — Base system prompt word count** (worker.js 6906–7527): **8,696 words**.

No writes performed in Phase 0.

---
## Phase 1 — Un-fork the prompt (samEngine split-brain)

**Changed (worker.js):** removed all 5 `samEngine` gates on prompt content. Every user now receives
every block:
- 7231 — `${samEngine === 'haiku' ? …}` ternary around the COMPLIANCE / FILING / FINANCE / DONATION
  LIMITS / DONOR RESEARCH hard-constraint blocks → now unconditional literal text.
- 7300 — `${samEngine === 'gemini' ? …}` ternary around VERIFIED-DATA CITATION DISCIPLINE → now
  unconditional (dropped the "(Gemini path)" label).
- 7727 — `if (samEngine === 'gemini')` around the pre-fetch context injection → bare block (always runs).
- 7774 — `if (samEngine === 'gemini')` around the campaign_reference lookup injection → bare block.
- 7909 — `if (samEngine === 'gemini' && category…)` around the GROUNDING MANDATE → dropped the
  `samEngine` clause, kept the category condition.

Syntax: `node --check worker.js` passes.

**Left intact (non-prompt `samEngine` behavior), per instruction — listed here:**
- `getSessionContext` reads/normalizes `sam_engine` and exposes `ctx.samEngine` (195–228).
- `const samEngine = (chatCtx && chatCtx.samEngine) || 'haiku'` read (5699).
- `shadowEnabledForUser(env, userId, samEngineFlag)` shadow-orchestration gate (8902–8907) and its
  call site (11960).
- Validator-regen / dead-code branch `if (samEngine === 'gemini')` (9160) — this is inside the
  `runProductionGeminiTurn` dead path flagged for deletion in Phase 5; left for now.
- Two explanatory comments (9935, 9944).

**Contradiction noted (not "fixed" here — Phase 2 resolves it):** the now-always-on VERIFIED-DATA
CITATION DISCIPLINE says specific facts must trace to "(a) the VERIFIED CAMPAIGN REFERENCE DATA
block or (b) grounding," while the now-always-on COMPLIANCE/FINANCE/LIMITS hard constraints say
"call `lookup_*` FIRST." These were previously mutually exclusive by engine, and the code comment at
7805–7812 explicitly warned they interact badly (forceful precedence language pushed Sam into the
unsupported-deferral path). They are not an *outright* logical contradiction (both forbid
training-data recall), so per instruction I did not rewrite them — but this is exactly the overlap
Phase 2's MODULE_TRUST_LADDER resolves by ranking VERIFIED BLOCKS (rung 2) above LOOKUP TOOLS
(rung 3). Flagged for Phase 2.

**Risk:** un-forking makes the campaign_reference D1 *reads* and the `campaign_reference_lookup_events`
fire-and-forget *telemetry write* execute for all users at runtime once deployed (previously
gemini-only, i.e. ~1 user). Higher D1 read/write volume, but intended. Nothing executed by this job
(no deploy).

---
## Phase 2 — Prompt consolidation (modules + trust ladder)

**What changed:**
- New file `lib/sam_prompt_modules.mjs` exports four static module constants:
  `MODULE_IDENTITY`, `MODULE_TRUST_LADDER` (verbatim as specified), `MODULE_HARD_CONSTRAINTS`,
  `MODULE_TOOL_GUIDANCE`.
- worker.js: the former 624-line base literal (`let systemPrompt = \`…\``) was replaced by a single
  template assembling `MODULE_IDENTITY → MODULE_TRUST_LADDER → MODULE_HARD_CONSTRAINTS →
  MODULE_TOOL_GUIDANCE` (stable prefix) followed by the **volatile per-turn ground-truth block reused
  verbatim by index** (candidate line, GROUND TRUTH, RACE TYPE, RESEARCH SCOPE, CURRENT STATUS,
  VERIFIED blocks, calendar, tool memory). Volatile data now comes LAST for implicit prefix caching.
- New guard `scripts/check_prompt_budget.mjs` enforces per-module budgets and the 2,500-word base
  ceiling, exiting non-zero on breach (replaces the stale `sed | wc -w` "under 800 words" check).
- Two per-turn category appends (FACTUAL framing, GROUNDING MANDATE) were repointed from the removed
  "SMART DEFERRAL TEMPLATES" block to the FACT TRUST LADDER rung 5.

**Word budgets (guard output):** IDENTITY 355/450 · TRUST_LADDER 314/500 · HARD_CONSTRAINTS 916/1050 ·
TOOL_GUIDANCE 301/600 · **BASE TOTAL 1,886 / 2,500** (down from 8,696 — 78% reduction).

**Verification:** `node --check` passes on worker.js and the module file (both confirmed with no
output pipe, after discovering a pipe-masked false pass — see Risks). An isolated runtime build test
with stubbed volatile vars confirmed `systemPrompt` assembles, contains all four modules + the
ground-truth block, and orders them correctly (identity < ladder < constraints < tool-guidance <
GROUND TRUTH).

### Rule-by-rule MAPPING TABLE (nothing silently dropped)

| Original block (old worker.js) | New home |
|---|---|
| `${aboutCandidateBlock}` bio prefix | VOLATILE tail (kept, moved after modules) |
| TEMPORAL ANCHOR (verbose) | DROPPED — absorbed into TRUST_LADDER rungs 4–5 + the GROUND TRUTH date line |
| STOP — FACTUAL DISCIPLINE (citation sys #1) | MODULE_TRUST_LADDER (replaced) |
| CITATION-FIRST / WHEN TO CALL WEB_SEARCH | TRUST_LADDER rung 4 + TOOL_GUIDANCE (when/when-not to search) |
| STATE-SPECIFIC URLs — HARD CONSTRAINT | TRUST_LADDER rung 5 ("never emit a state-specific URL from memory…") |
| MUNICIPAL RACES — HARD CONSTRAINT | HARD_CONSTRAINTS #3 |
| ILLEGAL CONTRIBUTIONS — HARD CONSTRAINT | HARD_CONSTRAINTS #2 |
| CALENDAR — HARD CONSTRAINT | HARD_CONSTRAINTS #1 |
| BUDGET — HARD CONSTRAINT | HARD_CONSTRAINTS #4 |
| CITATION FORMAT REQUIREMENT (citation sys #2) | TRUST_LADDER rung 4 (clickable markdown links) — replaced |
| CONFIDENCE SIGNALS (citation sys #3) | TRUST_LADDER rung 5 (benchmark / "my read" tags) + IDENTITY (no HIGH/MED/LOW) — replaced |
| SMART DEFERRAL TEMPLATES (deferral rules) | TRUST_LADDER rung 5 (generic deferral) |
| URL ROUTING table (FL-specific domains) | **Intentionally DROPPED** — Florida hardcoding; superseded by ladder rung 5's generic "Search '[State] [resource type]'". De-Floridifies the base prompt. (Validator regen prompts still list these domains — see Risks / Phase 4.) |
| SMART DEFERRAL sample deferrals (FL examples) | **Intentionally DROPPED** — FL-specific worked examples, redundant with ladder |
| ENTITY MASKING | MODULE_IDENTITY (NAMES paragraph) |
| NAMESAKE RULE | MODULE_IDENTITY (NAMES) + HARD_CONSTRAINTS #9 (opponents) |
| BANNED HEDGING WORDS | TRUST_LADDER rung 5 (forbidden for the fact classes) — absorbed |
| COMPLIANCE / DEADLINES / LEGAL | TRUST_LADDER rung 3 + TOOL_GUIDANCE — absorbed |
| GEOGRAPHIC TARGETING — HARD CONSTRAINT | HARD_CONSTRAINTS #8 |
| COMPLIANCE/FILING + FINANCE + DONATION LIMITS + DONOR RESEARCH constraints (P1 un-forked) | TRUST_LADDER rung 3 (call lookup_* FIRST, cite authority) + TOOL_GUIDANCE. Verbose per-status branches (found/partial/web_search_fallback/unsupported) **condensed** to one tool-guidance line |
| VERIFIED-DATA CITATION DISCIPLINE (citation sys #5) | TRUST_LADDER rung 2 — replaced |
| CITATION DISCIPLINE — HARD CONSTRAINT (citation sys #4) | TRUST_LADDER — replaced |
| NEWS QUERIES — HARD CONSTRAINT | HARD_CONSTRAINTS #5 (kept, trimmed) + ladder rung 4 |
| SEARCH CAPABILITY — HARD CONSTRAINT | TOOL_GUIDANCE ("you DO have live search…") + ladder rung 4 |
| HISTORICAL ELECTION DATA (Ballotpedia pattern) | HARD_CONSTRAINTS #6 |
| WIN NUMBER — MANDATORY BEHAVIOR (multi-member/turnout) | HARD_CONSTRAINTS #6 |
| EPISTEMIC HONESTY (A/B/C categories) | TRUST_LADDER (rungs 1–2 verified, rung 5 benchmarks/deferred). A/B/C enumeration **dropped** as redundant with the ladder |
| META-TRANSPARENCY — HARD CONSTRAINT | TOOL_GUIDANCE (final bullet) |
| CLAIM-INFLATION GUARD — HARD CONSTRAINT | HARD_CONSTRAINTS #10 |
| USER AS AUTHORITY — HARD CONSTRAINT | HARD_CONSTRAINTS #10 (merged w/ claim-inflation) + ladder rung 1 |
| OPPONENT FACTS — HARD CONSTRAINT | HARD_CONSTRAINTS #9 |
| Sam persona (7467) | MODULE_IDENTITY |
| "You work for ${candidateName}…" | VOLATILE tail (kept) |
| GROUND TRUTH / RACE TYPE / RESEARCH SCOPE / CURRENT STATUS / VERIFIED blocks / calendar / tool memory | VOLATILE tail (kept verbatim) |
| RULE 1 (tool before confirming) | TOOL_GUIDANCE |
| RULE 2 (don't re-ask Ground Truth) | TRUST_LADDER rung 1 + HARD_CONSTRAINTS #4 |
| RULE 3 (dates; no day-of-week; no relative dates; YYYY-MM-DD) | HARD_CONSTRAINTS #7 |
| RULE 4 (never say "compliant/all set") | TOOL_GUIDANCE (compliance posture) |
| RULE 5 (search proactively; don't narrate) | TOOL_GUIDANCE + IDENTITY (don't narrate) |
| RULE 6 (geographic research scope) | VOLATILE RESEARCH SCOPE line (kept) |
| RULE 7 (Intel Ground Truth authoritative) | HARD_CONSTRAINTS #9 + ladder rung 1 |
| RULE 8 (budget category keys) | TOOL_GUIDANCE (budget category mapping) |
| RULE 9 (services redirect) | MODULE_IDENTITY |
| RULE 10 (confirm briefly after calendar add) | TOOL_GUIDANCE |
| RULE 11 (write full documents) | MODULE_IDENTITY |
| RULE 12 (calendar dup-check; task vs event defs) | HARD_CONSTRAINTS #1 (permission core kept); dup-check + task/event definitions **condensed/dropped** |
| RULE 13 (win number: primary system first) | HARD_CONSTRAINTS #6 |
| RULE 14 (2-3 sentence responses) | MODULE_IDENTITY |
| RULE 15 (end with a recommendation) | MODULE_IDENTITY |

### Risks / notes
- **Pipe-masking bug caught mid-phase.** A first surgery attempt wrote real newlines inside
  double-quoted separators (`"\n\n"` mangled through a heredoc). `node --check worker.js` returned 0
  because an earlier check was piped to `head` (so `$?` was head's exit) AND the broken lines sat
  inside a template that balanced file-wide. Caught it via an isolated-fragment `node --check`
  (exit 1), reverted to the Phase 1 commit (re-verified clean, no pipe), and redid the surgery with a
  single template literal + real blank-line separators. **All syntax checks in this phase were re-run
  without a pipe.** Going forward every phase's check is `node --check <file>` on its own line.
- **Validator-side "smart-deferral" references remain** (worker.js ~9610–11140): the post-generation
  citation-validator regen prompts still name the removed SMART DEFERRAL block and hardcode FL
  domains (dos.fl.gov, fec.gov, sos.state.tx.us…). These are validator infrastructure, not the base
  prompt; left intact and flagged for **Phase 4** (validator restructure) to reconcile with the
  de-Floridified trust ladder.
- **Category-framing appends retained** (STRATEGIC/COMPLIANCE/PREDICTIVE/CONVERSATIONAL/FACTUAL) still
  say "web_search" and the COMPLIANCE one still lists FL URLs. The `web_search`→`request_web_search`
  rewrite is **Phase 3, step 5**; the FL-URL overlap with the ladder is noted for a future trim.
- `MODULE_IDENTITY` carries the placeholder `// TODO: Shannan-authored example exchanges.` as
  specified — no new voice content was invented.

---
## Phase 3 — request_web_search escape hatch (kills the router capability cliff)

**What changed (worker.js only):**
1. Added `request_web_search { query, reason }` to the tools array with the specified description.
   Gated to omit on conversational turns AND opponent-research turns (see correctness fix below).
2. `callClaude` restructured: the single `generateContent` call is now a bounded loop. When the model
   emits a `request_web_search` functionCall, a **grounding-only Gemini sub-call** runs server-side
   (`runGroundingSubturn`: systemInstruction as specified, `tools:[{googleSearch:{}}]`, temp 0.2,
   maxOutputTokens 2000), the result is extracted via `extractGroundingResult`, and `{excerpt, sources}`
   is fed back as a `functionResponse`; the loop re-calls with the full function toolset intact.
   Logged as `sam_grounding_subturn`.
3. **Cap of 2** grounding calls per turn; beyond that the functionResponse says the search budget is
   exhausted (answer from data or defer). Outer loop bound of 5 rounds as a safety net.
4. Router demoted to optimizer: `routeUserIntent` kept, but per-turn capability statements are now
   appended to a local `turnSystemPrompt` — the SEARCH-route and ACTION-route statements verbatim as
   specified ("THIS TURN: you have live Google Search grounding but NOT your save/calendar/budget
   tools…" / "THIS TURN: you have your full toolset. For live information, call request_web_search…").
5. Converted remaining prompt-facing `web_search` references to `request_web_search`: STRATEGIC,
   COMPLIANCE, CONVERSATIONAL category appends; the Safe Mode append; the opponent-research-gate text;
   the three `lookup_*` "do not substitute" clauses; and two validator regen instructions.

**"More invasive than described" — noted per the hard rule:** the spec said "in callClaude's tool
loop," but there was **no server-side tool loop** — `callClaude` did a single call and returned
tool_use blocks to the client for execution. So I *added* a server-side grounding sub-loop inside
`callClaude` (the only correct place to keep function tools available while fetching live data). This
is a real behavioral addition, not just a handler in an existing loop. It's self-contained inside
`callClaude` and does not touch the outer demask/validator pipeline.

**Correctness fix caught during the phase:** my first cut gated `request_web_search` only on
`_isConversational`, which would have re-opened live web search on **opponent-research** turns —
violating the OPPONENT FACTS constraint (no web_search for opponents, since grounding re-leaks masked
identities). Fixed to gate on `(opponentResearchGate || _isConversational)`, mirroring `web_search`.

**Verification:** `node --check worker.js` passes (no pipe). The `callClaude` function was also
extracted and syntax-checked in isolation (exit 0) — the same isolated-fragment test that caught the
Phase 2 corruption. Wiring confirmed: tool decl present, `runGroundingSubturn` defined+called,
`sam_grounding_subturn` logged, 2-call cap present, both capability statements present, both
`web_search`/`request_web_search` gated on opponent+conversational.

### Requested verification — six rules confirmed surviving the Phase 2 consolidation

| Rule | Where it lives now | Confirming text (quoted from the module) |
|---|---|---|
| (a) Win-number: Ballotpedia search pattern + multi-member lowest-placed-winner + presidential→midterm turnout adjustment | **MODULE_HARD_CONSTRAINTS #6** | "search the pattern '[State] [Office] District [N] [Year] election results Ballotpedia'… single-winner → the winner's total; multi-member district → the **LOWEST-PLACED WINNER's total**; adjust presidential-year turnout down **25–40% for a midterm**." — all three components intact. |
| (b) Illegal contributions: definitive NO + jurisdiction-matched enforcement agency | **MODULE_HARD_CONSTRAINTS #2** | "respond with a **definitive NO — not a hedge** — and name the SPECIFIC enforcement agency for that jurisdiction (LA City → LA City Ethics Commission; CA state → FPPC; federal → FEC…)". |
| (c) Calendar permission gate + explicit-instruction exception | **MODULE_HARD_CONSTRAINTS #1** | "Never add, update, or delete a calendar item without explicit permission. Only proceed directly when the candidate says 'add this,' 'put it on my calendar,' 'schedule it,' 'remind me to,' or a clear paraphrase; otherwise ask first." |
| (d) Municipal-vs-state primary constraint | **MODULE_HARD_CONSTRAINTS #3** | "Never apply a state's primary system (e.g., California's top-two) to a city or county race. Charter cities and counties set their own rules…" |
| (e) Never emit state-specific URLs from memory | **MODULE_TRUST_LADDER, rung 5** | "**Never emit a state-specific URL or agency name from memory; a wrong-state URL is worse than no URL.**" |
| (f) COMPLIANCE/FILING lookup-tool-first (un-forked in Phase 1) | **MODULE_TOOL_GUIDANCE** (and mirrored in TRUST_LADDER rung 3) — **confirmed in MODULE_TOOL_GUIDANCE** | "lookup_compliance_deadlines (filing/qualifying deadlines)… For those fact classes, **call the tool FIRST** and cite its authority field; on status 'unsupported'/'unavailable,' defer with the authority contact in the tool result — do not substitute training data or a state-specific URL from memory." |

### Risks / notes
- **Co-emitted action tools deferred one round.** If the model emits `request_web_search` *and* an
  action tool (e.g. `save_note`) in the same response, the action gets an "acknowledged — re-issue
  after search" functionResponse (to satisfy the API contract) and the model re-issues it the next
  round. In practice the model searches-then-acts sequentially, so this is a rare edge; documented.
- **functionResponse role.** The grounding result is fed back as `{role:'user', parts:[{functionResponse}]}`
  — the Gemini REST-accepted shape. Worth confirming against a live turn in Greg's manual test.
- **One descriptive validator `web_search` mention left** (worker.js ~10729, a confidence-tag
  description, not an actionable instruction) — left for the Phase 4 validator restructure, along with
  the smart-deferral validator references noted in Phase 2.

---
## Phase 4 — Generation config + structured output

**4.1 — thinkingBudget.** Main Sam turn only: `thinkingBudget 0 → 512` (in callClaude's generate
loop). Router, classifier, validators, and the grounding sub-turn stay at 0. Verified: `thinkingBudget: 512`
appears exactly once; `thinkingBudget: 0` appears 18×.

**4.2 — Router + classifier → responseSchema.** Both now use `responseMimeType:'application/json'` +
`responseSchema` with an enum, and parse JSON — the substring `.includes('search')` and the
`replace(/[^a-z]/g,'')` normalize guessing are gone.
- `routeUserIntent` → `{ route: enum['search','action'] }`; fail-safe to `'action'` on parse error.
- `classifyUserQuestion` → `{ category: enum['factual','strategic','compliance','predictive','conversational'] }`;
  fail-open to `'factual'`.

**4.3 — The three named validators → responseSchema.** Regex extraction (`match(/\{[\s\S]*\}/)`)
removed; each now emits schema-validated JSON parsed directly:
- opponent validator → `{ claims: string[] }`
- donation validator → `{ amounts: string[] }`
- citation verifier → `{ high_stakes: string[], medium: string[], low: string[] }`
Fail-open is preserved **only** for verifier infra errors (parse/HTTP), and every fail-open is now
recorded to a turn-scoped `_validatorFailOpens` accumulator via `_noteValidatorFailOpen(name, reason)`.
**Phase 5's `sam_turn_trace` insert will serialize this accumulator into the `validator_result`
column** (the accumulator is declared now; the DB write lands in Phase 5 to avoid a forward table
dependency).

**4.4 — Validator merge: NOT done (too invasive — noted).** The three validators have different
triggers (opponent-claim detection vs donation-limit signals vs all-factual), different schemas,
different D1 tables (`sam_{opponent,donation,citation}_validation_events`), and different downstream
strip/regen dispatch. Merging into one post-pass call with a single schema is a significant redesign
with real regression risk on an untestable path. Per the spec's "if invasive, leave them separate but
schema-ified and note it," they are left separate and schema-ified.

**4.5 — googleSearch key normalization.** The one snake_case call site (`tools:[{ google_search:{} }]`
in the dormant `geminiCallSam`) → `googleSearch`, matching the live callClaude path. The stale comment
that claimed snake_case was canonical was corrected. All grounding call sites now use `googleSearch`.

**Folded-in Phase 4 items:**
- The descriptive `web_search` mention in the citation-verifier prompt (former ~10729) → "a live
  search."
- The validator regen prompts (compliance validator + the strip-fallback critic) that referenced the
  **removed** "SMART DEFERRAL TEMPLATES" block now reference the **FACT TRUST LADDER**, and I added a
  generic ladder fallback ("Search '[State] [resource type]'") so a non-FL/TX candidate isn't pushed
  toward a wrong-state URL.
  - **FL/TX domains retained as examples on purpose:** those same domains (`dos.fl.gov`, `fec.gov`,
    `sos.state.tx.us`, …) are entries in the validator's functional **URL-acceptance whitelist**
    (worker.js ~9768) — the re-audit accepts a regenerated citation only if its host is whitelisted.
    Stripping the domains from the regen prompts without also reworking that whitelist would make the
    validator reject valid FL/TX citations. Full de-Floridification of the whitelist is a coupled
    change and is **flagged as a separate follow-up**, not done here.

**Verification:** `node --check worker.js` passes (no pipe). 5 `responseSchema` sites (router +
classifier + 3 validators); accumulator declared once with 3 fail-open call sites; budget guard still
green.

**Risks / notes:**
- Router and classifier now **hard-depend** on Gemini honoring `responseSchema` (JSON out). Both keep
  fail-safe/fail-open defaults on parse failure, so a schema regression degrades gracefully — but this
  should be confirmed on a live turn in Greg's manual test.
- **Not converted (out of the named scope):** the compliance-date auditor and the finance validator
  also regex-extract JSON (`match(/\{…\}/)`), structurally identical to the three converted. They use
  the separate `sam_{compliance,finance}_validation_events` tables and were not in the named set;
  flagged as an easy follow-up applying the same pattern.

---
<!-- Phases appended below as completed. -->
