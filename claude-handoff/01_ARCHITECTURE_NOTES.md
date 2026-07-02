# 01 — Architecture Notes (sam-overhaul branch)

How the backend behaves **after the Sam overhaul (Phases 0–6)**, on the `sam-overhaul` branch
(not deployed). Line references are to the branch's `worker.js`. See `OVERHAUL_REPORT.md` for the
per-phase changelog and `CLAUDE.md` (rewritten) for the working guide.

> This supersedes the pre-overhaul version of this file. The big shift: the prompt is now modular,
> there's a `request_web_search` escape hatch, structured output everywhere, a per-turn trace table,
> and PBKDF2 password hashing. Sam runs on **Gemini 2.5 Flash**.

## 1. Model + generation config
Single model: **`gemini-2.5-flash`** (REST `generateContent`, no streaming).
- **Main chat** (`callGemini`, formerly `callClaude`): `temperature 0.4`, `maxOutputTokens 2000`,
  **`thinkingBudget 512`** (Phase 4 — the only call with a thinking budget), 4× `BLOCK_ONLY_HIGH`
  safety. Tools are `[{googleSearch:{}}]` on the search route XOR `[{functionDeclarations}]` on the
  action route. It still translates Gemini → Anthropic-shape `content` blocks (kept, with its comment).
- **Router** (`routeUserIntent`) and **classifier** (`classifyUserQuestion`): `temp 0`,
  `thinkingBudget 0`, **`responseMimeType:'application/json'` + `responseSchema`** (enum) — no more
  substring parsing.
- **Grounding sub-turn** (`runGroundingSubturn`, the escape hatch): `temp 0.2`, `maxOutputTokens 2000`,
  `[{googleSearch:{}}]`, `thinkingBudget 0`.
- All grounding call sites now use `googleSearch` (camelCase) — the snake_case straggler was
  normalized.

## 2. Router — now a soft optimizer (capability cliff fixed)
`routeUserIntent` still returns `'search'` vs `'action'` (now via `{route: enum}` JSON). The key
change: **the action path is fully capable.** When an action turn needs live data, Sam calls
`request_web_search`; `callGemini` runs a grounding-only sub-call server-side, feeds `{excerpt,
sources}` back as a `functionResponse`, and re-calls **with the full function toolset intact** (capped
at 2 grounding calls/turn). So a router misclassification costs one hop, not a broken turn. Per-turn
capability statements are appended to the prompt telling Sam what it has this turn. `request_web_search`
is omitted on conversational and opponent-research turns (grounding would re-leak masked opponents).

## 3. Error handling + reliability (Phase 5)
- Every main chat turn writes one row to **`sam_turn_trace`** (route, tools_called, gemini_error,
  was_blank, did_retry, `validator_result`, input/output tokens, latency) — fire-and-forget from
  `buildSafeResponse`, the single response chokepoint, so **error and blank turns are captured too**.
- On a Gemini error, `maybeSendFailureAlert` counts errors in the last 60 min; **≥5 → one Resend email
  to Greg**, rate-limited to once per 6h (state = a `route='__alert__'` sentinel row; no second table).
- Blank path: one retry, then a **jurisdiction-neutral** fallback (Phase 5 — templates the candidate's
  state, no state-specific URL; the old FL/Orange-County text is gone).
- The intended Gemini→Haiku regen fallback (`runProductionGeminiTurn` / `logGeminiFailure` /
  `geminiCallSam`) is **still present and reachable** for gemini-engine + shadow-allowlist users — the
  earlier "dead code" label was inaccurate; nothing was deleted (Phase 5 assessment).

## 4. System prompt — modular (Phase 1 + 2)
The former 8,700-word single literal is gone. The prompt is assembled from **module constants** in
`lib/sam_prompt_modules.mjs`, stable-first for Gemini implicit prefix caching:
`MODULE_IDENTITY → MODULE_TRUST_LADDER → MODULE_HARD_CONSTRAINTS → MODULE_TOOL_GUIDANCE →`
*(per-turn volatile: candidate line, GROUND TRUTH, RACE TYPE, RESEARCH SCOPE, VERIFIED blocks,
calendar, tool memory)*. Base assembly ≈ **1,886 words** (was 8,696); per-module budgets enforced by
`scripts/check_prompt_budget.mjs` (fails loudly). The split-brain `samEngine` prompt gates were
removed in Phase 1 — every user now gets every discipline block. `MODULE_IDENTITY` carries a
`// TODO: Shannan-authored example exchanges.` placeholder.

## 5. The FACT TRUST LADDER (single citation system)
`MODULE_TRUST_LADDER` replaced **five** overlapping citation systems (STOP–FACTUAL DISCIPLINE,
CITATION FORMAT, CONFIDENCE SIGNALS, CITATION DISCIPLINE, VERIFIED-DATA DISCIPLINE) plus the redundant
NEWS/SEARCH parts and the FL-specific URL-routing table. Five rungs, answer from the highest that has
the fact: (1) ground truth, (2) verified blocks, (3) lookup tools, (4) live search
(`request_web_search`), (5) model memory — allowed only for concepts/strategy/benchmarks, never for
the fact classes at the top. "Never emit a state-specific URL from memory."

## 6. Tools (22 declarations)
15 action/persistence tools (client-executed), 5 verified-fact `lookup_*` tools (server-executed →
ladder rung 3), `request_web_search` (escape hatch), and the legacy Anthropic `web_search` (stripped
before Gemini sees the array). Function tools and native grounding are mutually exclusive per Gemini
call — the reason for the escape hatch.

## 7. Structured output + validators (Phase 4/5)
Router, classifier, and **all five validators** (opponent, donation, citation, compliance-date,
finance) use `responseSchema`; the `match(/\{…\}/)` regex extraction is gone. Validator **fail-opens**
(verifier infra errors) are recorded to a turn-scoped `_validatorFailOpens` accumulator, persisted
into `sam_turn_trace.validator_result`. The three "confidence" buckets etc. are unchanged downstream.
**Not merged** into one post-pass call (different triggers/schemas/tables — deferred, noted).

## 8. Conversation history
`history.slice(-30)` (Phase 5) caps the server-side prompt at the last 30 messages before building
geminiContents — bounds token blow-out / injection surface regardless of client behavior. Still
converted via `toGeminiHistory` and persisted per-user in `chat_history`.

## 9. Auth / passwords (Phase 6)
- **PBKDF2**: `pbkdf2$210000$<saltB64>$<hashB64>` (per-user 16-byte salt, 210k iters, SHA-256).
  `verifyPassword(pw, stored)` handles both formats; on a successful **legacy** SHA-256 verify the row
  is **transparently rehashed** to PBKDF2. New signups / resets / sub-user creates always write the
  new format. Legacy logins are preserved until every row migrates. (Crypto validated standalone:
  round-trip, wrong-password rejection, legacy verify+flag all pass.)
- Beta accounts are now identified by **`users.plan === 'beta'`** for the rate-limit bypass (the
  hardcoded username allowlist was removed).

## 10. Stripe (unchanged by the overhaul)
As before: `workspaceHasActiveAccess(ownerId)` (beta plan OR active subscription) gates the Sam chat
endpoint; webhook handles `checkout.session.completed` / `customer.subscription.*` /
`invoice.payment_succeeded` with `subscription_data[metadata][userId]` propagation. See the Stripe
section of the prior notes / worker.js `/api/billing/*`.

## 11. Still on the worry list / open follow-ups
- **URL-acceptance whitelist** (`V2_KNOWN_AUTHORITY_DOMAINS`, ~9785) is FL/TX-centric and strips
  correct non-FL/TX state URLs — full investigation + recommendation in `OVERHAUL_REPORT.md` (Phase 5,
  folded item 2). **Ruled a Phase 7 follow-up; not fixed here.**
- Compliance-date/finance validators converted, but the broader validator subsystem still has
  FL-domain examples in regen prompts (kept because they're whitelist-coupled).
- `runProductionGeminiTurn`/`geminiCallSam` kept (reachable) but represent a confusing legacy Haiku
  path; worth a dedicated cleanup once `samEngine` is fully retired.
- Live-verify items for Greg: PBKDF2 login (existing password), password reset, and the failure-alert
  email. Full checklist in `OVERHAUL_REPORT.md`. (The Gemini functionResponse round-trip —
  `scripts/test_gemini_functionresponse.mjs` — has already been run live and **PASSED**.)
