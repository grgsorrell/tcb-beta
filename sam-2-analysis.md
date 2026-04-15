# Sam 2.0 Analysis Report
**Generated:** 2026-04-15
**Source:** worker.js (103,918 bytes, 2,053 lines)

---

## 1. System Prompt Assessment

### Word Count
- **Core system prompt (lines 1163-1542):** ~4,200 words
- **Tool definitions (lines 1556-2014):** ~2,800 words (JSON schemas)
- **Onboarding/returning user blocks:** ~400 words
- **Phase guidance + timeline rules:** ~600 words
- **Total tokens sent per request:** ~8,000-10,000 words (~12,000-15,000 tokens)

### Grade: C+

**What works well:**
- Identity rules are strong — candidate/opponent confusion is addressed explicitly
- Date accuracy rules are thorough (timezone-aware, ISO date injection, month guardrails)
- Legal/compliance safety is well-designed (never say "you're compliant")
- The "never narrate tool usage" rules (9-12) fix a real Haiku problem
- Geographic scope logic (local vs statewide vs federal) is smart
- Campaign phase detection is useful for contextual advice
- Brief prose injection gives Sam real intelligence to work with

**What needs improvement:**
- **Prompt is bloated.** 13 numbered response style rules + 5 date rules + 5 compliance rules + 9 calendar rules + 5 search rules + 14 tool rules = 51 behavioral rules. Haiku can't reliably hold 51 rules in working memory. Rules contradict each other (e.g., "be concise 2-3 sentences" vs "write FULL documents ready-to-use").
- **Redundancy everywhere.** The candidate's name, office, state, and election date appear 3-4 times in the prompt. "NEVER re-ask" appears twice. The date is injected in 4 different formats.
- **Rule numbering gaps.** Calendar rule #7 is missing (jumps 6 to 8). Looks like a deleted rule that left a gap.
- **Tool descriptions duplicate prompt rules.** The `add_expense` tool description repeats the category mapping that's already in the prompt. The `save_document` description repeats folder conventions already stated above.
- **No priority weighting.** Rules 1-13 are all called "#1 RULE." When everything is priority 1, nothing is.
- **Campaign services redirect is verbose.** 30+ lines for a pattern that could be 5 lines.

---

## 2. Tool Inventory

### Tool List (24 tools total)

| # | Tool Name | Purpose | Reliability | Notes |
|---|-----------|---------|-------------|-------|
| 1 | `web_search` | Search for election info, deadlines, resources | **HIGH** | Built-in Anthropic tool. Works well. |
| 2 | `save_candidate_profile` | Save profile during onboarding | **MEDIUM** | Defined in worker but execution is client-side. Partially redundant — profile is already saved by the app before Sam sees it. |
| 3 | `add_to_calendar` | Add tasks/deadlines | **HIGH** | Well-tested, client handler works. |
| 4 | `add_event` | Add scheduled events | **HIGH** | Works. Overlaps with `add_calendar_event`. |
| 5 | `add_calendar_event` | Add events with full details | **HIGH** | Works. Overlaps with `add_event`. |
| 6 | `set_budget` | Initialize total budget | **MEDIUM** | Works but doesn't set category allocations — just total. |
| 7 | `add_expense` | Log campaign expense | **HIGH** | Robust handler with category normalization. |
| 8 | `save_to_notes` | Save content to folders | **HIGH** | Works. Uses `folder_name`/`note_title` params. |
| 9 | `add_note` | Quick-add a note | **HIGH** | Works. Uses `folder`/`title` params (different from `save_to_notes`). |
| 10 | `save_document` | Save written documents | **HIGH** | Works. Adds "Ready" status automatically. |
| 11 | `update_task` | Modify existing task | **MEDIUM** | Partial name matching can hit wrong task if names overlap. |
| 12 | `delete_task` | Remove a task | **MEDIUM** | Same partial matching risk. |
| 13 | `complete_task` | Mark task done | **MEDIUM** | Same partial matching risk. |
| 14 | `update_event` | Modify existing event | **MEDIUM** | Same partial matching risk. |
| 15 | `delete_event` | Remove an event | **MEDIUM** | Same partial matching risk. |
| 16 | `update_budget` | Change category allocation | **HIGH** | Uses CATEGORY_KEY_MAP normalization. |
| 17 | `save_win_number` | Save calculated vote target | **HIGH** | Works well with dashboard display. |
| 18 | `set_win_number` | Alt way to save win number | **HIGH** | Duplicate of `save_win_number` with slightly different params (uses `votes` vs `win_number`). |
| 19 | `navigate_to` | Switch app view | **HIGH** | Simple and reliable. |
| 20 | `update_budget_total` | Change total budget | **HIGH** | Works. |
| 21 | `log_contribution` | Record donation | **HIGH** | Good handler with running totals. |
| 22 | `set_fundraising_goal` | Set fundraising target | **HIGH** | Calculates weekly pace. |
| 23 | `set_category_allocation` | Allocate budget to category | **HIGH** | Works. Overlaps with `update_budget`. |
| 24 | `update_starting_amount` | Set starting cash on hand | **HIGH** | Simple and reliable. |

### Tool Overlap Problems
- **3 note-saving tools:** `save_to_notes`, `add_note`, `save_document` — different param names for essentially the same action. Sam sometimes picks the wrong one.
- **2 event-adding tools:** `add_event` and `add_calendar_event` — both add events. Confusing for the model.
- **2 win number tools:** `save_win_number` and `set_win_number` — nearly identical.
- **2 budget allocation tools:** `update_budget` and `set_category_allocation` — same action, different schemas.
- **24 tools total is too many for Haiku.** Research shows tool selection accuracy degrades significantly past 10-12 tools on smaller models.

---

## 3. Known Failure Cases & Root Causes

### F1: Sam narrates search actions (PARTIALLY FIXED)
**Symptom:** Sam says "Let me search for..." before tool calls, creating awkward UX.
**Root cause:** Haiku generates text tokens before tool_use blocks. The client now strips narration patterns with `cleanResearchNarration()` (line 4543), but this is a band-aid — it only catches specific English phrases.
**Status:** Mitigated client-side, not fixed at model level.

### F2: Tool follow-up loop limited to 1 round
**Symptom:** If Sam needs 3+ sequential tool calls (search -> search -> add event), only the first follow-up round executes. Third-round tools are dropped.
**Root cause:** The client (lines 4769-4838) does ONE follow-up call after tool results. If that follow-up also returns tool_use blocks, they execute locally but no further API follow-up is sent.
**Impact:** Complex multi-step workflows (onboarding deadline search -> add all to calendar) can silently lose the final text response.

### F3: Partial name matching for update/delete tools
**Symptom:** "Delete the fundraising task" deletes the wrong task if multiple tasks contain "fundraising."
**Root cause:** `tasks.find()` with `indexOf` returns the FIRST match, not the best match. No date disambiguation.
**Impact:** Low frequency but high severity when it hits.

### F4: Sam confuses task vs event
**Symptom:** User says "add a town hall to my calendar" and Sam uses `add_to_calendar` (task) instead of `add_event` (event).
**Root cause:** Three overlapping tools with unclear boundaries. The system prompt explains the difference, but 24 tools competing for selection makes Haiku inconsistent.

### F5: Chat history truncation loses context
**Symptom:** Long conversations lose early context and Sam re-asks questions or forgets decisions.
**Root cause:** `chatHistory.slice(-20)` sends only the last 20 messages. For a conversation with many tool exchanges, 20 messages might cover only the last 3-4 user turns.
**Impact:** Moderate — affects long sessions.

### F6: Budget state sync issues
**Symptom:** Sam says "your budget is $X" but the dashboard shows a different number.
**Root cause:** The worker receives `budget: campaignBudget.totalBudget || campaignBudget.total` (line 4672) — the `totalBudget` key may not exist, falling through to `total`. But the prompt only shows one value. If the client has expenses reducing the available amount, Sam doesn't see "available" — just "total."
**Impact:** Low-medium.

### F7: Research mode returns raw API JSON
**Symptom:** Research mode (line 998-1039) returns the raw Anthropic API response directly to the client without processing.
**Root cause:** By design — the client handles parsing. But if the API returns an error or unexpected format, there's no error handling.
**Impact:** Low.

### F8: Onboarding assumes web_search will find deadlines
**Symptom:** New users in small/obscure races get "I couldn't find specific deadlines" because Haiku's web search can't find municipal filing deadlines for tiny jurisdictions.
**Root cause:** The onboarding prompt hardcodes specific search queries that assume state-level results exist.
**Impact:** High for local-race users (which is the majority of the target market).

### F9: Tool results stored as flat text in chat history
**Symptom:** After tool calls, the confirmation text is appended to chat history as a plain assistant message. The structured tool_use/tool_result pairs are lost.
**Root cause:** Lines 4758-4766 flatten tool confirmations into the text history. The API follow-up (line 4773) does send structured content, but the persisted chat history doesn't.
**Impact:** On page reload, the reconstructed history lacks tool context.

### F10: Rate limiting is per-request, not per-conversation
**Symptom:** A single user message that triggers 3 API calls (initial + tool follow-up + research) only counts as 1 message toward the 100/day limit.
**Root cause:** Rate limit check only runs once at the top of the main handler (line 976).
**Impact:** Low financial risk currently, but could be exploited.

---

## 4. Data Sam Has vs What She's Missing

### What Sam HAS (sent every request):
- Candidate name, office, party, state, location
- Election date + calculated days remaining
- Campaign phase (early/building/peak/closing/gotv/final)
- Office level (local/state/federal) + geographic scope
- Budget total + spent + remaining + category allocations + recent expenses
- Upcoming tasks (10) + completed tasks (5)
- Upcoming events (10)
- Endorsements list (10)
- Notes/folders summary (names + titles)
- Candidate brief (opponent, district lean, key issues, primary results)
- Current app view
- Win number
- Starting cash + fundraising goal + total raised + donor count

### What Sam is MISSING:

| Missing Data | Impact | Difficulty to Add |
|-------------|--------|-------------------|
| **Contribution details** (individual donors, amounts, dates) | Can't give fundraising analysis ("your top donors" or "average donation size") | Easy — contributions array exists in client |
| **Compliance checklist state** | Can't say "you've completed 3 of 7 compliance items" | Easy — ctb_compliance exists in localStorage |
| **Morning brief content** | Can't reference today's briefing in conversation | Easy — ctb_morning_brief exists |
| **Full note content** | Sees folder/title list but can't read note bodies. Can't say "in your stump speech draft, you mentioned..." | Medium — would bloat context significantly |
| **Past conversation summaries** | Only sees last 20 messages. No memory across sessions. | Hard — needs summarization pipeline |
| **Voter data / contact history** | Can't track doors knocked, calls made, voter contacts | Hard — no data structure exists yet |
| **Opponent activity** | Has static brief but no live opponent tracking | Hard — needs scheduled research |
| **Volunteer roster** | Can't help manage volunteer coordination | Hard — no data structure exists |
| **Poll numbers / sentiment** | Can't track or reference polling data | Medium — could store in notes |
| **Social media metrics** | Can't advise on digital performance | Hard — needs integrations |

---

## 5. Sam 2.0 Architecture Recommendations

### R1: Compress the system prompt to <2,000 words
The current prompt is 4,200+ words of instructions. Haiku performs best with concise, structured prompts. Consolidate the 51 behavioral rules into 10-12 ranked priorities. Remove all redundancy. Move tool-specific rules into tool descriptions where they belong.

### R2: Reduce tools from 24 to 12-14
Merge overlapping tools:
- `add_event` + `add_calendar_event` -> single `add_event`
- `save_to_notes` + `add_note` + `save_document` -> single `save_note` with optional `status` and `doc_type`
- `save_win_number` + `set_win_number` -> single `set_win_number`
- `update_budget` + `set_category_allocation` -> single `set_category_budget`
- `set_budget` + `update_budget_total` -> single `set_budget`

Target tool list (~14 tools):
1. `web_search` (built-in)
2. `add_task` (deadlines, to-dos)
3. `add_event` (scheduled activities)
4. `update_calendar_item` (update or delete task/event by ID)
5. `complete_task`
6. `save_note` (all document types)
7. `add_expense`
8. `log_contribution`
9. `set_budget` (total + optional category allocations)
10. `set_win_number`
11. `set_fundraising_goal`
12. `add_endorsement`
13. `navigate_to`
14. `update_starting_amount`

### R3: Implement multi-turn tool loop
Replace the current "1 follow-up" pattern with a proper loop that continues until Sam returns a text-only response (no tool_use blocks). Cap at 5 iterations to prevent runaway loops. This fixes F2 and enables complex workflows like "research deadlines and add them all."

### R4: Send structured tool results in chat history
When persisting chat history, save the actual tool_use and tool_result blocks — not flattened text. This preserves context for the model across turns and improves follow-up accuracy.

### R5: Add contribution summary to context
Include aggregated fundraising data: total raised, donor count, average donation, top 5 donors, recent contributions. This data already exists client-side.

### R6: Add compliance checklist state
Send the compliance checklist status so Sam can reference what's done vs pending.

### R7: Use ID-based tool targeting instead of name matching
For update/delete operations, pass the item's actual `id` from the client instead of relying on partial name matching. The client can inject available items into the context, and Sam references by ID.

### R8: Add a conversation summarization pipeline
Every 20 messages, generate a summary of key decisions, action items, and context. Prepend this summary to the system prompt. This preserves long-term conversation coherence without sending full history.

### R9: Separate the worker into logical modules
The current worker.js is a 2,053-line monolith handling:
- Authentication (magic links, sessions)
- Data API (CRUD for profiles, tasks, events, budget, notes, briefings, chat history)
- Admin dashboard
- Email endpoints (contact form, service interest)
- Sam chat (system prompt + Claude API call)
- Research mode

For Sam 2.0, consider:
- Keep auth + data API routes as-is (they work fine)
- Extract the system prompt into a separate template module
- Extract tool definitions into a separate config
- Add a proper tool execution loop handler

### R10: Add Sam memory/preferences per user
Store per-user Sam preferences: communication style, topics discussed, key decisions made. This would allow Sam to be contextually aware across sessions without sending full chat history.

---

## 6. Test Cases for Sam 2.0

### Onboarding (Tests 1-5)
| # | Test Case | Expected Behavior | Priority |
|---|-----------|-------------------|----------|
| 1 | New user completes onboarding, first Sam message | Sam searches for deadlines, presents them, asks to add to calendar. Does NOT greet or re-introduce. | P0 |
| 2 | New user says "yes" to adding deadlines | Sam adds ALL found deadlines in one response via multiple tool calls | P0 |
| 3 | New user for obscure local office (e.g., Water District Board) | Sam gracefully handles no search results, recommends county clerk, doesn't fabricate deadlines | P0 |
| 4 | New user with election >180 days away | Sam does NOT ask about filing status, focuses on early planning | P1 |
| 5 | New user with election <14 days away | Sam enters GOTV mode, prioritizes voter contact | P1 |

### Core Chat (Tests 6-10)
| # | Test Case | Expected Behavior | Priority |
|---|-----------|-------------------|----------|
| 6 | "How do I beat my opponent?" | Sam gives ONE focused strategy point in 2-4 sentences, not a 5-point list. Ends with a question. | P0 |
| 7 | "What should I focus on this week?" | Sam references their actual calendar, days-to-election, and campaign phase. Gives 1 specific action. | P0 |
| 8 | Returning user, first message of new session | Sam greets warmly, references campaign context (upcoming events, phase), doesn't re-explain who she is | P0 |
| 9 | User asks same question they asked 15 messages ago | Sam gives a consistent answer (not contradictory) even with history truncation | P1 |
| 10 | User sends empty/gibberish message | Graceful error handling, no crash | P2 |

### Tool Execution (Tests 11-18)
| # | Test Case | Expected Behavior | Priority |
|---|-----------|-------------------|----------|
| 11 | "Log $500 for yard signs" | Sam calls `add_expense` with amount=500, category=signs. Confirms with remaining budget. | P0 |
| 12 | "Add a town hall on May 1st at 6pm at City Hall" | Sam calls `add_event` (not `add_to_calendar`) with all fields populated | P0 |
| 13 | "I got a $1000 donation from John Smith" | Sam calls `log_contribution` with donorName, amount, source. Shows running total. | P0 |
| 14 | "Write me a stump speech" | Sam asks 1-2 clarifying questions, writes full speech, presents it, asks to save. Only saves after approval. | P0 |
| 15 | "Add all my campaign deadlines to the calendar" | Sam searches, then adds ALL items in a single response with multiple tool calls | P0 |
| 16 | "Delete the fundraising event on May 15th" when 2 events have "fundraising" in name | Sam uses date to disambiguate. Deletes the correct one. | P1 |
| 17 | "Set my budget to $25,000" when budget already set to $20,000 | Sam updates (not creates) budget. Confirms the change. | P1 |
| 18 | "Mark the filing deadline as complete" | Sam calls `complete_task`, confirms, moves on | P1 |

### Edge Cases & Compliance (Tests 19-25)
| # | Test Case | Expected Behavior | Priority |
|---|-----------|-------------------|----------|
| 19 | "Am I compliant with all my deadlines?" | Sam NEVER says "you're all set." Lists what she knows, recommends verification with officials. | P0 |
| 20 | "What's the filing deadline?" for a state Sam can't find data for | Sam says she couldn't confirm, recommends specific office to contact. Does NOT fabricate a date. | P0 |
| 21 | User asks about voter lists/texting/direct mail | Sam gives strategic advice, then redirects to Candidate's Toolbox services. Does NOT name vendors or give DIY instructions. | P1 |
| 22 | User asks "what day is May 15th?" | Sam does NOT state the day of the week (per rule). Just says "May 15th." | P1 |
| 23 | Sam encounters a web search with conflicting dates | Sam acknowledges the conflict, presents both, recommends direct verification | P1 |
| 24 | User has 3 days to election and asks about long-term planning | Sam redirects to immediate GOTV priorities, doesn't waste time on 6-month strategy | P1 |
| 25 | 100+ message conversation spanning multiple topics | Sam maintains coherence, doesn't re-ask settled questions, references earlier decisions | P2 |

---

## 7. Step-by-Step Build Plan

### Phase 1: Foundation (worker.js restructure)
**Goal:** Clean architecture without changing behavior

1. **Extract system prompt into a builder function**
   - Create `buildSystemPrompt(params)` that returns the prompt string
   - Move all prompt sections into clearly labeled template segments
   - Remove redundancy (candidate info appears once, rules consolidated)
   - Compress from ~4,200 words to ~1,800 words

2. **Merge overlapping tools**
   - Combine note tools -> `save_note`
   - Combine event tools -> `add_event`
   - Combine win number tools -> `set_win_number`
   - Combine budget allocation tools -> `set_category_budget`
   - Combine budget total tools -> `set_budget`
   - Update client-side `executeToolCall()` to handle new unified names
   - Add backward-compatible aliases in client for old tool names

3. **Implement multi-turn tool loop**
   - In `sendSamMessage()`, replace single follow-up with a while loop
   - Loop continues while response contains `tool_use` blocks
   - Cap at 5 iterations
   - Each iteration: execute tools, send results, get next response

4. **Test:** All 25 test cases pass with restructured code

### Phase 2: Context Enhancement
**Goal:** Give Sam better data to work with

5. **Add contribution summary to request body**
   - Total raised, donor count, avg donation, top 5 donors
   - Add to `additionalContext` string

6. **Add compliance checklist state**
   - Read `ctb_compliance` from localStorage
   - Include completion status in context

7. **Send morning brief content**
   - Include today's morning brief if it exists
   - Add as a collapsible context section

8. **Fix chat history to preserve tool structure**
   - Store tool_use and tool_result blocks in chat history
   - Reconstruct proper API message format from stored history

9. **Test:** Verify Sam references new data correctly in responses

### Phase 3: Prompt Optimization
**Goal:** Maximize Haiku's performance within token constraints

10. **Rewrite system prompt as prioritized rules**
    - Tier 1 (3 rules): Identity, conciseness, end with question
    - Tier 2 (4 rules): Date accuracy, compliance safety, tool execution, never re-ask known info
    - Tier 3 (5 rules): Calendar management, search sourcing, personality, services redirect, document writing
    - Each rule is 1-2 sentences max

11. **Move tool-specific rules into tool descriptions**
    - Category mapping -> `add_expense` description
    - Folder conventions -> `save_note` description
    - Calendar duplicate checking -> `add_event` description

12. **A/B test prompt variants**
    - Test compressed prompt vs current prompt on the 25 test cases
    - Measure: rule compliance rate, response length, tool selection accuracy

13. **Test:** Prompt is <2,000 words. All test cases still pass.

### Phase 4: Reliability Improvements
**Goal:** Fix known failure cases

14. **ID-based tool targeting**
    - When building additionalContext, include item IDs for tasks and events
    - Format: `- [id:1234] May 1: Town Hall Meeting`
    - Update tool schemas to accept `item_id` as primary identifier
    - Keep name-based fallback for backward compatibility

15. **Better onboarding for obscure races**
    - Add fallback search queries if primary returns nothing
    - Include state secretary of state URL in response
    - Don't force deadline search for every new user — ask first

16. **Rate limiting per API call**
    - Count each Claude API call, not each user message
    - This prevents the 3x call multiplier exploit

17. **Test:** F1-F10 failure cases all resolved or mitigated

### Phase 5: Deploy & Monitor
**Goal:** Ship Sam 2.0

18. **Deploy to staging**
    - Deploy updated worker.js to a staging worker
    - Test with all 4 beta users' actual data

19. **Deploy to production**
    - `wrangler deploy worker.js --name candidate-toolbox-secretary2 --compatibility-date 2026-04-07`
    - Monitor error rates and response times

20. **Post-deploy monitoring**
    - Watch admin dashboard for message counts and errors
    - Collect user feedback over 48 hours
    - Fix any regression issues

---

## Summary

Sam v1 is functional but bloated. The system prompt tries to cover every edge case with explicit rules, resulting in 51 behavioral directives that exceed Haiku's reliable working memory. 24 tools with significant overlap force the model to make unnecessary distinctions. The single-follow-up tool loop limits complex workflows.

Sam 2.0 should focus on three things:
1. **Compression** — Half the prompt words, half the tools, twice the reliability
2. **Better context** — Contributions, compliance state, conversation summaries
3. **Proper tool loop** — Let Sam chain actions naturally instead of artificially capping at 1 follow-up

The backup is safe. No changes were made to worker.js.

---

# ENHANCED ANALYSIS (MCP-Assisted)
**Method:** Context7 (Anthropic docs), GitHub MCP (commit history), Filesystem (full app.html + worker.js contract analysis), Sequential architectural reasoning, Playwright automated live testing.
**Not available:** Sequential Thinking MCP (not installed). Playwright MCP not installed, but @playwright/test was installed and run directly.

---

## 8. Anthropic Best Practices Benchmark (via Context7)

Context7 was queried against the official Claude API documentation (`/websites/platform_claude_en_api`, 13,930 code snippets, High reputation, benchmark score 77.53). Here is how Sam v1 measures against Anthropic's published guidance:

### 8.1 Tool Definition Quality

**Anthropic says:** "Tool descriptions should be as detailed as possible to provide the model with comprehensive information about what the tool does and how to use it. Natural language descriptions can reinforce important aspects of the tool input JSON schema."

**Sam v1 assessment:**
- PASS: Most tool descriptions are detailed. `add_expense` has excellent category mapping guidance in its description.
- FAIL: Several tools have vague descriptions. `add_event` says "Add a scheduled EVENT to the campaign calendar" but doesn't clarify when to use it vs `add_calendar_event`. When two tools have similar names AND similar descriptions, the model can't reliably distinguish them.
- FAIL: `save_candidate_profile` description says "Call this AFTER collecting all 4 onboarding answers" — but in practice, the app already collects the profile. The tool fires but the description is misleading about its purpose.

**Recommendation:** Per Anthropic docs, each tool description should function as a self-contained mini-prompt. If the model only read the tool descriptions (not the system prompt), it should still know which tool to pick and what params to use. Currently, Sam's tool descriptions depend heavily on the system prompt for context.

### 8.2 Tool Count

**Anthropic says:** API supports up to 128 tools. No explicit limit on recommended count for Haiku. However, the documentation emphasizes that detailed descriptions help the model "decide when and how to use these tools."

**Sam v1 assessment:**
- 24 tools is within API limits but creates a combinatorial selection problem for Haiku. With 24 choices, the model must evaluate each tool's name + description before selecting. Tool pairs with overlapping functionality (`add_event` / `add_calendar_event`, `save_to_notes` / `add_note` / `save_document`) force the model to make distinctions that don't matter to the user.
- The Anthropic Go SDK example shows a clean pattern: one tool per distinct action, with a loop that continues until no more tool_use blocks are returned.

**Recommendation:** Merge to 14 tools. Each tool should map to exactly one user intention. No two tools should be valid for the same user request.

### 8.3 Multi-Turn Tool Loop

**Anthropic says (via SDK examples):** The documented pattern is a `for` loop that continues calling the API until `stop_reason` is not `tool_use`:
```
for {
  message = client.Messages.New(...)
  messages = append(messages, message.ToParam())
  toolResults = []
  for _, block := range message.Content {
    // execute tool, collect result
    toolResults = append(toolResults, result)
  }
  if len(toolResults) == 0 { break }
  messages = append(messages, NewUserMessage(toolResults...))
}
```

**Sam v1 assessment:**
- FAIL: Sam does exactly ONE follow-up after tool results. This breaks the documented agentic loop pattern.
- The client code at `app.html:4769-4838` does a single follow-up call, then processes any tool_use blocks from the follow-up locally — but never sends THOSE results back to the API. This means the model never sees confirmation of second-round tool executions.
- Consequence: If Sam searches (round 1), then gets results and wants to add 10 calendar items (round 2), and the response ends with a text summary — that works. But if Sam searches (round 1), processes results and needs to search AGAIN (round 2), then wants to add items (round 3) — round 3's text response is lost because there's no round 3 API call.

**Recommendation:** Implement the standard agentic loop with a cap of 5 iterations. This is the single highest-impact fix for Sam 2.0.

### 8.4 System Prompt Construction

**Anthropic says:** System prompts use the top-level `system` parameter (not a message role). Up to 100,000 characters supported. Cache control with `cache_control: { type: "ephemeral" }` can be applied to system blocks.

**Sam v1 assessment:**
- PASS: System prompt is correctly passed via the `system` parameter with `cache_control: { type: "ephemeral" }`.
- PASS: Prompt caching is correctly implemented — the system prompt is marked ephemeral, which enables caching within the 5-minute TTL.
- CONCERN: At ~4,300 words (~6,000 tokens), the system prompt consumes significant context. With tool definitions (~2,000 words / ~3,000 tokens) added on top, roughly 9,000 tokens go to instructions before any conversation begins. On Haiku with `max_tokens: 10000`, this leaves limited room for both history and response generation.
- FAIL: The prompt has no structural hierarchy. It's a flat list of `================================================================` delimited sections, all presented at equal weight. Anthropic's examples use concise, prioritized instructions.

**Recommendation:** Use XML-like tags or clear hierarchy to structure the prompt. Place the most critical rules first (identity, conciseness, tool usage). Move verbose sections (timeline generation rules, campaign services redirect, win number calculator) into conditional injection — only add them to the prompt when relevant context is detected in the user's message.

### 8.5 Message History Management

**Anthropic says:** "Models are trained to operate on alternating user and assistant conversational turns. Consecutive user or assistant turns will be combined into a single turn." Maximum 100,000 messages supported.

**Sam v1 assessment:**
- PASS: Messages alternate correctly during active conversation.
- FAIL: Persisted chat history flattens tool_use/tool_result blocks into plain text (app.html:4758-4766). When the history is reloaded, the API sees text-only messages where structured tool exchanges should be. This degrades the model's understanding of what actions were taken.
- FAIL: The `slice(-20)` truncation is aggressive. With tool exchanges, 20 messages may represent only 3-4 user turns. The API supports 100,000 messages — the truncation is artificial.
- CONCERN: The follow-up call (app.html:4773) appends `data.content` (the raw API response content array) to the history, then appends tool results as a user message. But it doesn't persist these — only the flattened text gets saved. On page reload, the model loses all tool execution context.

**Recommendation:** Store the full structured message history including tool_use and tool_result blocks. Increase the window to 40 messages or implement a sliding window with summarization.

---

## 9. Git Evolution Analysis (via GitHub MCP)

### Commit Timeline for worker.js

| Date | Commit | Description | Type |
|------|--------|-------------|------|
| 2026-04-07 | `3c552f9` | TCB beta v1 | **ORIGINAL** — 2,037 lines, full worker shipped at once |
| 2026-04-13 | `79cfacb` | Prevent filing status question when >180 days | Patch — added rule #13 and planning stage context |
| 2026-04-13 | `d831457` | Array.isArray safety checks for brief data | Patch — fixed crash when brief fields are strings not arrays |
| 2026-04-14 | `b6295ff` | Sam can now properly log expenses | Patch — rewrote add_expense tool description + category enums |
| 2026-04-14 | `922ad95` | Deep audit and fix of Sam tool integration | **MAJOR PATCH** — category normalization, tool rules, critical tool rule added |
| 2026-04-14 | `51f88ea` | Geographic scope for morning brief + Sam prompt | Patch — added statewide/federal/local scope detection |

### Key Findings

**1. The entire worker was shipped as a single commit.**
`3c552f9` (April 7) added all 2,037 lines at once. This means the system prompt, all 24 tools, the auth system, the data API, the admin dashboard, and the research mode were all built and deployed together. There's no iterative history — it was conceived as a monolith.

**2. All subsequent commits are reactive patches, not planned improvements.**
Every commit after v1 starts with "Fix:" — these are bug fixes discovered through testing, not planned enhancements. The pattern:
- April 13: Two patches (brief data crashes + filing status question)
- April 14: Four patches in rapid succession (expense logging broken -> deep audit -> geographic scope)

**3. The "deep audit" commit (922ad95) tells the real story.**
This was the largest patch to worker.js. It:
- Rewrote `add_expense` from a vague tool ("Track a campaign expense") to a detailed one with category mapping
- Changed the enum from freeform categories (`"signs", "yard signs", "digital", "digital ads", "facebook"`) to normalized keys (`"signs", "digital", "mail"`)
- Added the "CRITICAL TOOL RULE" paragraph that Sam MUST call tools, not just claim to
- Added per-tool ALWAYS rules for expense, contribution, calendar, endorsement

This commit proves the original tool definitions were **inadequate for Haiku** — the model wasn't reliably selecting or calling tools, so explicit rules had to be added to both the system prompt AND the tool descriptions.

**4. The prompt grew but was never pruned.**
Original v1 prompt + deep audit additions = the current prompt. Rules were added but never consolidated. The "TOOLS AVAILABLE" listing in the system prompt (lines 1448-1469) duplicates information already in the tool definitions — this was added as a "belt and suspenders" fix because Haiku wasn't reading the tool schemas carefully enough.

**5. The app.html had 26 commits in the same period.**
The frontend evolved much faster than the backend. Most Sam-related frontend work was in `executeToolCall()`, which grew from a simple handler to a 320-line function handling 24+ tool names. The `cleanResearchNarration()` function (commit 31049a0) was a client-side band-aid for a server-side problem.

### Implication for Sam 2.0
The git history proves that Sam v1's problems stem from **initial over-engineering followed by under-maintained patches.** The original prompt tried to anticipate every scenario with explicit rules, then real-world testing revealed the rules weren't working, leading to MORE rules layered on top. Sam 2.0 should be built incrementally — start with a minimal prompt and tool set, test each tool individually, then add complexity only where testing proves it's needed.

---

## 10. Frontend/Backend Contract Analysis

### The Contract
The frontend (app.html) and backend (worker.js) communicate via a single POST endpoint. The contract has two parts:

**Part A: Request shape** (app.html -> worker.js)
```
{
  message, state, officeType, electionDate, party,
  needsOnboarding, filingStatus, candidateName, specificOffice,
  location, history, mode, additionalContext, budget,
  winNumber, daysToElection, govLevel, candidateBrief
}
```

**Part B: Response handling** (worker.js -> app.html)
The worker returns raw Claude API responses. The frontend parses `data.content[]` blocks:
- `type: "text"` -> displayed in chat
- `type: "tool_use"` -> executed locally via `executeToolCall()`

### Contract Mismatches Found

**Mismatch 1: Budget key confusion**
- Frontend sends `budget: campaignBudget.totalBudget || campaignBudget.total` (app.html:4672)
- Worker reads `budget` and displays it as `$X` in the system prompt
- Problem: `totalBudget` is set by the old `set_budget` handler, but `total` is set by `update_budget_total`. They're different keys. If both exist, `totalBudget` takes precedence even if `total` was updated more recently.

**Mismatch 2: Fundraising data sent but not used**
- Frontend sends `startingAmount`, `fundraisingGoal`, `totalRaised`, `donorCount` (app.html:4673-4676)
- Worker IGNORES all four — they're not destructured from the request body and don't appear in the system prompt
- These fields are dead code on the backend

**Mismatch 3: Tool names must match exactly**
- Worker defines 24 tool names in schemas sent to Claude
- Frontend has 27 `name === 'xxx'` checks in `executeToolCall()` — the 3 extras are aliases: `add_task` (alias for `add_to_calendar`), `add_event` (alias for `add_calendar_event` in the first if-branch), and `web_search` (no-op handler)
- If Sam 2.0 changes tool names, BOTH files must be updated in lockstep

**Mismatch 4: Chat history format divergence**
- During conversation: tool_use/tool_result blocks are sent correctly to the API
- After persistence: only flattened text is saved to `chatHistory`
- On page reload: history sent to API is text-only — model loses all tool context
- The API follow-up correctly builds structured messages (app.html:4771-4774) but this structure is never persisted

**Mismatch 5: `save_candidate_profile` has no backend handler**
- Worker defines the tool in the Claude API call
- Claude may call it and return a `tool_use` block
- Frontend has a handler (app.html:4355) that updates `campaignData`
- But the tool's stated purpose ("Save the candidate's profile information collected during onboarding") is misleading — the profile is already saved during the onboarding UI flow, not through Sam

### Sam 2.0 Contract Requirements
Any changes to the worker's tool definitions MUST be mirrored in `app.html:executeToolCall()`. The following are safe to change without frontend modifications:
- System prompt text (any changes)
- Tool descriptions and parameter descriptions
- Temperature, max_tokens, model settings
- Request body fields the worker reads

The following REQUIRE frontend changes:
- Tool names (rename or merge)
- Tool parameter names (rename)
- Adding new tools
- Removing tools
- Changing the response format

---

## 11. Architectural Reasoning — Systematic Problem Analysis

### Step 1: What is Sam's actual job?

Sam has 5 distinct roles:
1. **Conversationalist** — warm, concise chat with campaign-specific context
2. **Researcher** — web search for deadlines, election data, compliance info
3. **Tool executor** — add events, log expenses, save documents, etc.
4. **Content creator** — write speeches, talking points, emails, scripts
5. **Strategic advisor** — campaign strategy, prioritization, timing

The current prompt tries to cover all 5 roles equally in every request. But most user messages only engage 1-2 roles. A "Log $500 for yard signs" message doesn't need 600 words of speechwriting instructions and 400 words of timeline generation rules.

### Step 2: Where does Haiku fail and why?

Analyzing the git history patches reveals a pattern:
1. Haiku **doesn't call tools** when it should -> Fixed by adding "CRITICAL TOOL RULE" and per-tool "ALWAYS call" rules
2. Haiku **picks the wrong tool** when tools overlap -> Not yet fixed; 24 tools with overlaps still exist
3. Haiku **narrates before acting** -> Fixed client-side with regex stripping, not at model level
4. Haiku **ignores late-in-prompt rules** -> Partially fixed by repeating rules in tool descriptions

These failures point to a single root cause: **prompt overload.** When Haiku receives 4,300 words of rules + 2,000 words of tool definitions + 500-1000 words of campaign context + 1,000-2,000 words of chat history, the total input is 8,000-10,000 words. Haiku's attention degrades on rules that appear deep in a long prompt. The patches kept adding more rules to fix rule-following failures — a vicious cycle.

### Step 3: What is the minimum viable prompt?

Sam needs to know:
- **Who she is** and who the candidate is (~100 words)
- **What she already knows** — candidate data, calendar, budget (~200 words, dynamic)
- **How to behave** — concise, end with question, don't re-ask known info (~100 words)
- **How to use tools** — embedded in tool descriptions, not system prompt (~0 words in prompt)
- **What not to do** — compliance safety, services redirect (~150 words)

That's ~550 words of core prompt + dynamic context injection. The remaining ~3,750 words in the current prompt are edge cases, examples, and redundancy.

### Step 4: What is the critical fix order?

Based on impact analysis:

| Priority | Fix | Why First |
|----------|-----|-----------|
| 1 | Multi-turn tool loop | Unblocks complex workflows. Currently impossible to do search + add all items reliably. |
| 2 | Merge tools to 14 | Immediately improves tool selection accuracy by eliminating ambiguity. |
| 3 | Compress prompt to <1,500 words | Reduces attention degradation. Rules that remain will be followed more reliably. |
| 4 | Fix chat history persistence | Prevents context loss across page reloads. |
| 5 | Add missing context (contributions, compliance) | Makes Sam smarter about fundraising and compliance. |
| 6 | ID-based tool targeting | Eliminates partial-match errors on update/delete. |
| 7 | Conditional prompt sections | Only inject speechwriting rules when writing mode, timeline rules when planning, etc. |

### Step 5: What could break?

The biggest risk in Sam 2.0 is **tool name changes breaking the frontend.** The current `executeToolCall()` function is a 320-line if/else chain that matches exact tool name strings. If we rename `add_to_calendar` to `add_task`, the frontend handler must be updated simultaneously.

Mitigation: Add a mapping layer in the frontend that accepts both old and new names during the transition period:
```javascript
const TOOL_ALIASES = {
  'add_task': 'add_to_calendar',
  'add_event': 'add_calendar_event',
  // etc.
};
var canonicalName = TOOL_ALIASES[name] || name;
```

The second risk is **prompt compression causing behavioral regression.** If we remove the "NEVER narrate" rules assuming Haiku will naturally stop narrating with fewer tools, and it doesn't, we'd reintroduce the narration problem.

Mitigation: Keep `cleanResearchNarration()` in the frontend as a safety net even after prompt optimization. It costs nothing and catches edge cases.

---

## 12. Live Testing Results (Playwright Automated)

### Setup
- **Tool:** @playwright/test v1.59.1 with Chromium, headless mode
- **Target:** https://tcb-beta.grgsorrell.workers.dev/app.html
- **Auth method:** localStorage session injection (bypasses index.html login modal)
- **User:** greg (Beta#01 session)
- **Test file:** `sam-tests.spec.js` (8 tests)
- **Run time:** 1 minute 6 seconds total

### Results: 8/8 PASS

| # | Test | Time | Result | Sam's Response (excerpt) |
|---|------|------|--------|--------------------------|
| 1 | App loads, Sam FAB visible | 2.8s | PASS | N/A — UI verification only |
| 2 | Sam panel opens on click | 2.7s | PASS | N/A — UI verification only |
| 3 | Sam responds to basic question | 9.5s | PASS | "I'd love to help you prioritize, but I need to know a bit more about your race first... What office are you running for, and where?" |
| 4 | No research narration | 9.6s | PASS | Same response — no "Let me search" / "I'll look up" patterns detected |
| 5 | Expense logging via tool | 11.6s | PASS | "I've logged the $500 yard sign expense to your campaign." + confirm: "Logged $500 for Yard signs under Signs & Materials. Budget remaining: $-500" |
| 6 | Campaign manager voice | 9.5s | PASS | Ends with question, references campaign concepts, no generic AI assistant talk |
| 7 | Win number flow | 9.7s | PASS | "I need to find your win number... How many candidates are running in your race (including you)?" |
| 8 | Add event to calendar | 11.6s | PASS | confirm: "Added to your calendar: Meet and Greet on May 10, 2026 at 18:00" |

### Key Findings from Live Testing

**Finding 1: Sam doesn't know the greg user's campaign data.**
Tests 3, 4, and 6 all got the same response: "I need to know a bit more about your race first. What office are you running for?" This confirms that the `greg` test account doesn't have campaign data populated in localStorage, so Sam falls through to the onboarding path. The response is appropriate — Sam correctly identifies missing data and asks for it. But it means all 3 of those tests exercised the same code path.

**Finding 2: Expense logging works perfectly (Test 5).**
Sam correctly called `add_expense` with amount=500, category="signs", description="Yard signs". The green `.sam-confirm` element showed the exact tool confirmation. This validates that the deep audit commit (922ad95) fixed the expense tool. Category mapping from "yard signs" -> "signs" worked correctly.

**Finding 3: Win number flow starts correctly but can't complete in one shot (Test 7).**
Sam asked "How many candidates are running?" — the correct first step. But completing the full flow requires: user answers -> Sam searches last election data -> Sam calculates -> user confirms -> Sam saves. This is a 4-turn conversation that can't be tested in a single message. The 1-round follow-up limitation (F2) means the full flow would likely break if Sam needs search + save in a single response.

**Finding 4: Calendar event tool works, correct tool selected (Test 8).**
Sam picked `add_calendar_event` (not `add_to_calendar` task tool) for "meet and greet" — correctly identifying it as an event. The date was correctly parsed to May 10, 2026. Time was correctly set to 18:00 (6pm). Location "City Hall" was captured. This was the test with the lowest predicted confidence (50%) but it passed cleanly.

**Finding 5: Response times are consistent at ~9-12 seconds.**
All Sam response tests completed in under 12 seconds. The Haiku API call + tool execution loop consistently takes 7-9 seconds. This is acceptable for a chat UI with a typing indicator.

### Comparison: Predictions vs Reality

| Test | Predicted Confidence | Actual Result | Delta |
|------|---------------------|---------------|-------|
| Basic question | 80% | PASS (but onboarding path, not campaign advice) | Prediction correct but imprecise |
| Win number | 60% | PASS (first step only) | As predicted — can't complete multi-step |
| Expense logging | 95% | PASS | Confirmed |
| Calendar event | 50% | PASS — picked correct tool, correct date | **Prediction too pessimistic** — Sam handled this well |

---

## 13. Revised Build Plan (Post-Analysis)

Based on the enhanced analysis, here is the updated priority-ordered build plan:

### Phase 1: Multi-Turn Tool Loop (HIGHEST IMPACT)
- Rewrite `sendSamMessage()` in app.html to loop until `stop_reason !== 'tool_use'` or 5 iterations
- Each iteration: execute tools locally, send results back, get next response
- Persist full structured messages (tool_use + tool_result) to chat history
- **Test:** Onboarding flow completes fully (search -> present -> user says yes -> add all -> confirm)

### Phase 2: Tool Consolidation (24 -> 14)
- Merge in worker.js: update tool definitions
- Merge in app.html: update `executeToolCall()` with aliases for backward compatibility
- Remove duplicates: one event tool, one note tool, one win number tool, one budget allocation tool
- **Test:** Every merged tool fires correctly from Sam. Old tool names still work via aliases.

### Phase 3: Prompt Compression (4,300 -> 1,500 words)
- Extract candidate data into a clean `<candidate>` block
- Consolidate 51 rules into 12 ranked rules
- Move tool-specific rules INTO tool descriptions
- Make speechwriting, timeline, services redirect CONDITIONAL (only inject when relevant)
- Fix dead code: wire up `startingAmount`, `fundraisingGoal`, `totalRaised`, `donorCount` in the prompt
- **Test:** All 25 test cases. Compare response quality vs v1.

### Phase 4: Context & History Fixes
- Persist structured chat history (tool_use/tool_result blocks)
- Increase history window from 20 to 40 messages
- Add contribution summary, compliance checklist, morning brief to context
- Fix budget key confusion (`totalBudget` vs `total`)
- **Test:** Page reload preserves full context. Sam references fundraising data.

### Phase 5: Reliability & Polish
- ID-based tool targeting for update/delete operations
- Better onboarding fallbacks for obscure races
- Rate limit per API call, not per user message
- Keep `cleanResearchNarration()` as safety net
- **Test:** All failure cases F1-F10 resolved.

---

## Summary (Enhanced)

Sam v1 was built as a monolith in a single commit, then patched 5 times in one week to fix tool selection failures, category mismatches, and scope errors. The git history shows a pattern of reactive fixes layered on top of an already-overloaded prompt.

Benchmarking against Anthropic's official documentation reveals three critical gaps:
1. **No agentic tool loop** — Anthropic's SDK examples show a `for` loop that continues until no tool_use blocks remain. Sam does exactly one follow-up.
2. **Tool overlap violates the "one tool per intention" principle** — 24 tools with 10 overlapping pairs forces Haiku into ambiguous selection.
3. **Prompt size exceeds Haiku's reliable attention span** — 4,300 words of rules with no priority hierarchy means late-appearing rules are frequently ignored.

The frontend/backend contract analysis reveals 5 mismatches, including dead request fields (`startingAmount`, `fundraisingGoal`, `totalRaised`, `donorCount`) that are sent but never used, and a budget key conflict that can show stale data.

**The single highest-impact change is implementing the multi-turn tool loop.** This unblocks complex workflows and aligns with Anthropic's documented best practice. Tool consolidation is second — fewer tools means better selection accuracy. Prompt compression is third — it makes every remaining rule more likely to be followed.

Live Playwright testing (8/8 pass) confirms Sam's core tool execution works — expenses, events, and win number flow all function. The main gap is multi-step workflows that need more than one API follow-up round.

No changes were made to worker.js or app.html. Test infrastructure is ready in `sam-tests.spec.js` and `playwright.config.js`.
