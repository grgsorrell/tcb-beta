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
<!-- Phases appended below as completed. -->
