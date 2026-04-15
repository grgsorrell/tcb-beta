# The Candidate's Toolbox — Claude Code Context

## What This Is
TCB is an AI-powered political campaign management 
platform. Single-page app with an AI campaign manager 
named Sam powered by Claude Haiku.

## File Structure
- index.html — Marketing website + login page
- app.html — The full TCB application (single file)
- worker.js — Cloudflare Worker (Sam AI backend)
- icon512.png — App logo
- samavatar.png — Sam avatar image
- CLAUDE.md — This file

## Deployment — TWO COMMANDS REQUIRED
Every change requires TWO separate deploys.
Never deploy one without the other.

- Frontend: https://tcb-beta.grgsorrell.workers.dev
- Sam Worker: https://candidate-toolbox-secretary2.grgsorrell.workers.dev
- GitHub: https://github.com/grgsorrell/tcb-beta

```bash
# 1. Deploy backend (Sam/Worker)
wrangler deploy worker.js --name candidate-toolbox-secretary2 --compatibility-date 2026-04-07

# 2. Deploy frontend (app.html + static assets)
wrangler deploy --name tcb-beta --assets . --compatibility-date 2026-04-07

# 3. Push to GitHub
git add . && git commit -m "description" && git push
```

NEVER declare a fix complete without running both deploy commands.
Playwright tests must run against the live site after BOTH deploys.

## Design System (LOCKED — never change these)
CSS Variables:
--n1:#0B1120  --n2:#111827  --n3:#16213e
--n4:#1E3A5F  --n5:#2A5298
--gold:#d4a574  --red:#e87070  --green:#82b386
--blue:#6b9cd8  --purple:#9b8ec4
--t1:#e8e8e8  --t2:#94A3B8  --t3:#64748B
--font-d:'Playfair Display'  --font-b:'DM Sans'

## Beta Users
Usernames: greg, shannan, cjc, jerry
Password: Beta#01
Session: 30 days (remember me) / 8 hours

## Critical Rules — Never Break These
1. Sam model must always be claude-haiku-4-5-20251001
2. All localStorage keys must use storageKey() wrapper
   for per-user data namespacing
3. No hardcoded candidate names anywhere in UI
4. Worker system prompt order is critical:
   1. Identity rule (candidate name first)
   2. Brief injected as prose
   3. Sam intro
   4. Campaign data
   5. Response style (max 12 rules)
5. Research mode (mode:'research') bypasses Sam persona
   and enables web_search — never change this
6. Design system CSS variables are locked

## Key localStorage Keys (all use storageKey())
ctb_campaign, ctb_events, ctb_notes, ctb_expenses,
ctb_contributions, ctb_endorsements, ctb_chatHistory,
ctb_candidate_brief, ctb_morning_brief, ctb_compliance,
ctb_finance_setup, ctb_day1_brief, ctb_budget

Global keys (no namespacing):
tcb_session, tcb_current_user, samVoiceEnabled

## Sam 2.0 Tools (all defined in worker.js)
web_search, add_calendar_event (tasks+events),
update_task, delete_task, complete_task,
update_event, delete_event, add_expense,
log_contribution, set_budget (merged),
set_category_allocation, save_note (merged),
add_endorsement, navigate_to, save_win_number,
save_candidate_profile

Server-side tool loop (up to 10 rounds).
Tool calls returned in data.toolCalls for
client-side execution in app.html.

## Known Working State
- Login system working with session cookies
- Per-user data namespacing working
- Intelligence brief research working (4-tab Intel panel)
- Morning brief: AI-generated daily, background gen on day 1
- Sam 2.0: server-side tool loop, 16 consolidated tools
- All Sam tools executing correctly (10/10 Playwright tests)
- Compliance checkboxes persisting
- Voice TTS and mic STT working
- Intel Ground Truth injected into Sam's system prompt
- ID-based tool targeting for update/delete operations

## Anti-Bloat Rule (check before every deploy)
- System prompt: MUST be under 800 words (currently 623)
- Rules: MUST be 15 or fewer (currently 15)
- Tools: MUST be 16 or fewer (currently 16)
- Never add a new rule without removing or merging one
- Never add a new tool without removing or merging one
- Quick check: `sed -n '/let systemPrompt/,/\`;$/p' worker.js | wc -w`

## When Making Changes
- Always test with localStorage.clear() + fresh onboarding
- Never modify the worker system prompt order
- Never change the Haiku model string
- Always keep CORS headers on all Worker responses
- Budget progress bar shows AVAILABLE not spent
- Days to election always calculated fresh — never cached
- Budget key is `total` only — never use `totalBudget`
- Run `npx playwright test sam-tests.spec.js` after changes
- Always deploy BOTH backend AND frontend (see Deployment above)
