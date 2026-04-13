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

## Deployment
- Frontend: https://tcb-beta.grgsorrell.workers.dev
- Sam Worker: https://candidate-toolbox-secretary2.grgsorrell.workers.dev
- GitHub: https://github.com/grgsorrell/tcb-beta
- Deploy command: wrangler deploy worker.js --name candidate-toolbox-secretary2 --compatibility-date 2026-04-07

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

## Sam Tools (all must stay in worker.js)
add_calendar_event, add_expense, log_contribution,
add_note, add_endorsement, navigate_to,
update_budget_total, set_win_number, save_document,
set_fundraising_goal, set_category_allocation,
update_starting_amount

## Known Working State
- Login system working with session cookies
- Per-user data namespacing working
- Intelligence brief research working
- Morning brief generating daily
- All Sam tools executing correctly
- Compliance checkboxes persisting
- Voice TTS and mic STT working

## When Making Changes
- Always test with localStorage.clear() + fresh onboarding
- Never modify the worker system prompt order
- Never change the Haiku model string
- Always keep CORS headers on all Worker responses
- Budget progress bar shows AVAILABLE not spent
- Days to election always calculated fresh — never cached
