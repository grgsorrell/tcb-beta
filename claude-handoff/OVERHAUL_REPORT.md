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
<!-- Phases appended below as completed. -->
