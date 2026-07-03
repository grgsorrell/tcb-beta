# Post-Merge Punch List 2 — Execution Report

Branch: `pm-punchlist-2` (from `master`, which already contains the merged safe-mode fix). No deploys
(Greg redeploys). `node --check` run with NO pipe on every changed file. One commit per group.

---

## Group A — deferral-without-search + banner ghost + machinery leaks (commit 1)

### Item 1 — fall-through not firing (the priority). Confirmed with production trace data.

**How Safe Mode is scoped (hypothesis a groundwork).** `safeModeActive` is derived per-turn from
`getValidatorFiringBreakdown(conversation_id)`, which counts `action_taken='stripped'` rows across the
six validator tables **for that `conversation_id`, within a rolling 45-minute window** (the decay added
in the safe-mode fix). `conversation_id` comes from `body.conversation_id` — client-supplied, **one per
chat thread**. So Safe Mode is **per-conversation, not per-user/workspace**, and it is skipped entirely
when `conversation_id` is null. A user-wide trip was therefore not possible.

**What the trace actually shows.** I pulled `sam_turn_trace` for the tester's window. The two reported
turns:

| ts (2026-07-03) | route | tools_called | followed by |
|---|---|---|---|
| 21:30:35 | action | `["lookup_finance_reports"]` | text-only turn 21:30:53, `tools=[]` |
| 21:32:04 | action | `["lookup_jurisdiction"]` | text-only turn 21:32:08, `tools=[]` |

Earlier in the same session the same shape repeats for `lookup_compliance_deadlines` (21:01:15) and
`lookup_donation_limits` (21:12:15): the lookup fires, returns empty, and the **next** turn answers with
**no `request_web_search` call**. (Lookups execute client-side and feed their result back as a fresh
turn, so the fall-through decision is made on that follow-up turn.)

**Hypotheses, resolved:**
- **(c) toolset gating — REJECTED.** Every one of these turns was `route=action`, so `request_web_search`
  was in the toolset (it's only omitted on conversational or opponent-research turns). The tool was
  available and simply not called.
- **(a) Safe Mode was active — NOT confirmed by data.** In the 45-minute window before those turns there
  were only **2 strip events** (both citation) — below the threshold of **5**. Safe Mode was **off**.
  So Safe Mode did not cause this instance. **However**, the *defensive* concern is valid and was fixed
  anyway (see below): the Safe Mode prompt block said "defer per the FACT TRUST LADDER" without
  reinforcing search-first, so if it *had* been active it would have biased toward deferral.
- **(b) instruction coverage — CONFIRMED for `lookup_jurisdiction`, and it's the door-knocking root
  cause.** The `lookup_jurisdiction` tool description had **no fall-through** and said "recommend ONLY
  locations from the returned list … There are no exceptions to this rule." When the list comes back
  empty, that instruction guarantees a bare deferral. The finance/donation/compliance descriptions *do*
  carry the fall-through (added in punch-list 1), so their bare-deferrals are **model non-compliance
  with an existing prose instruction**, not a missing instruction.

**Net root cause.** Two distinct problems: (1) a real instruction gap in `lookup_jurisdiction`; and
(2) the empty-lookup → search fall-through, though present in prose for the other tools, was not being
followed on the *follow-up* turn where the empty result lands — the instruction lived in the tool
description (read when deciding to *call* the tool) and the static system prompt, neither of which is
salient at the moment the empty result comes back. Safe Mode was not the cause here, but its wording
could have compounded it.

**The invariant enforced:** lookup empty → search official sources → cite → advise confirming. A bare
deferral is acceptable **only** after a search was attempted and came back empty.

**Fixes:**
- **(a) Safe Mode block** (worker.js ~7177) rewritten: it now states explicitly that the caution
  narrows only what Sam may *assert from memory* and **"does NOT restrict searching, and must NEVER
  cause you to skip a search"** — when a source is missing, `request_web_search` FIRST, defer only if
  the search is empty. Safe Mode can no longer read as "don't search."
- **(b) `lookup_jurisdiction` description** (worker.js ~7811) now has the same fall-through as the other
  lookup tools: empty list → `request_web_search` for the official municipality/precinct list, cite,
  advise — bare deferral only after a search.
- **Decision-point lever** (worker.js ~8088): the action-route `turnCapability` string — injected fresh
  on **every** action turn, including the post-lookup follow-up turn — now says: *"If a lookup tool this
  turn (or the one you just ran) returned no verified data, you MUST call request_web_search … do NOT
  end the turn on a bare deferral, and do NOT merely say you will search: actually call it now."* This
  puts the fall-through instruction exactly where the empty result is read.
- **Ladder invariant** (MODULE_TRUST_LADDER rung 3): tightened to "If ANY of these tools returns no
  verified data (finance, jurisdiction — all of them, no exceptions), do NOT bare-defer … A bare
  deferral is acceptable ONLY after a search was attempted and came back empty."

### Item 2 — banner ghost (history imitation)

Confirmed as history-imitation: deployed code no longer emits any banner (the subsystem was deleted in
the safe-mode fix), and a fresh conversation is banner-free — but old threads contain assistant turns
that were prepended one of six legacy banner strings, and Gemini imitates that boilerplate from the
30-message history window.

**Fix (server-side history assembly).** Added `LEGACY_SAFE_MODE_BANNERS` (the exact six strings,
recovered from the pre-removal commit, each ending `\n\n---\n\n`) plus `stripLegacyBannersFromHistory()`,
applied to the history **right where the 30-message cap is applied** (worker.js ~9680:
`stripLegacyBannersFromHistory(history.slice(-30))`). It strips a leading legacy banner from historical
**assistant** messages only — string content or the first text block of array content — leaving user
messages, clean assistant messages, and tool blocks untouched (unit-tested: 5/5). Plus one
MODULE_IDENTITY line: *"Never open with a disclaimer, boilerplate caveat, or '---' separator, and don't
imitate a disclaimer pattern from an earlier turn — lead with the substance."*

### Item 3 — machinery leaks

Sam cited "(Source: lookup_compliance_deadlines tool result)", said a tool "is not fully implemented,"
and pasted the literal "(my read — verify before acting)" tag. Fixes in the prompt modules:
- **MODULE_IDENTITY**: extended the never-mention-internal-state rule to include **tool names**, and
  added "never cite a tool as a source — cite the AUTHORITY it named (e.g. 'the FEC'), not 'the lookup
  tool' or a backticked internal."
- **MODULE_TRUST_LADDER** rung 3: "Cite the authority NAMED IN the result, never the tool itself." Rung
  5: "Signal uncertainty in your OWN words … NEVER paste a literal tag like '(my read — verify before
  acting)' … those describe the meaning to convey, not text to copy."
- **MODULE_TOOL_GUIDANCE**: "When you genuinely have nothing after searching, say plainly 'I don't have
  verified data on that' — never explain your tooling or say a tool is 'not implemented'; the candidate
  never needs to hear how the machinery works."

### Item 4 — announced-but-not-executed search

**Prompt:** MODULE_TOOL_GUIDANCE now says: *"Never ANNOUNCE or promise a search ('I'll look that up,'
'let me search,' 'I'll initiate a web search'). Either call request_web_search THIS turn and report what
it returns, or don't mention searching at all — a promised-but-uncalled search is a dead end."*

**Escape-hatch loop verification + guard.** Confirmed the loop *could* end a turn on narrated intent:
it only re-loops when the model emits an actual `request_web_search` functionCall; a text-only "I'll
search" with no call falls straight through to the return. Added a **bounded one-shot guard** (worker.js,
main generate loop): on the action route, if the model's text matches a search-promise pattern and it
emitted no tool call, feed back one nudge ("You said you would search but did not call
request_web_search … call it now or answer without mentioning searching") and re-loop. Guarded by
`_searchNudged` (fires at most once) and the existing 2-call grounding cap, so it can't loop
unboundedly.

### Item 5 — Louisiana terminology (parishes)

MODULE_TOOL_GUIDANCE: *"LOCAL TERMINOLOGY: use the candidate's own state's terms for local divisions —
parishes in Louisiana, boroughs in Alaska, townships where they apply — not a blanket 'county.' When
unsure of the exact term, say 'local elections office.'"*

### Verification (Group A)
- `node --check worker.js` → exit 0 (no pipe). `node --check lib/sam_prompt_modules.mjs` → exit 0.
- Prompt budget guard green: IDENTITY 439/450, TRUST_LADDER 477/500, HARD_CONSTRAINTS 1014/1050,
  TOOL_GUIDANCE 450/600, base 2380/2500.
- Banner-strip helper unit-tested (5/5): assistant string + array-first-text stripped; user messages,
  clean assistant messages, and tool blocks untouched.

---
<!-- Group B appended below. -->
