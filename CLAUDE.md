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
- Intel panel: 3 tabs (My Opponents, District Pulse, Threat Assessment)
- About Sam modal: lightbulb pill in topbar (right of the phase pill). HTML
  lives in app.html under the `<!-- ABOUT SAM MODAL -->` block. Open/close via
  openAboutSam() / closeAboutSam(). Copy is the canonical source — update it
  directly in the #about-overlay markup.
- Morning brief: AI-generated daily, background gen on day 1
- Sam 2.0: server-side tool loop, 16 consolidated tools
- All Sam tools executing correctly (10/10 Playwright tests)
- Compliance checkboxes persisting
- Voice TTS and mic STT working
- Intel Ground Truth injected into Sam's system prompt (opponents + pulse)
- ID-based tool targeting for update/delete operations

## Intel Panel Architecture
Tab 1 — My Opponents: user-driven. Input + cards. Backed by D1
  `opponents` table (columns: id, user_id, campaign_id, name,
  data JSON, last_researched_at, created_at). Per-card 72h
  refresh cooldown. Endpoints: /api/opponents/list, /add,
  /refresh, /remove.
Tab 2 — District Pulse: mode:'research' with 'intel_pulse'
  feature. Multi-query VPS search. 72h cache in localStorage
  (ctb_intel_data.pulse).
Tab 3 — Threat Assessment: reads opponents from in-memory
  `intelOpponents`. Sorts by threatLevel desc. No refresh —
  auto-reflects Tab 1 state.

Research cost targets:
- Federal opponent: ~$0.005 (FEC finances + 1 VPS search + Haiku synthesis)
- Non-federal opponent: $0.05-0.07 (Haiku with web_search, max_uses: 3)
- Pulse: ~$0.005 (VPS search + Haiku synthesis)

Feature tags in api_usage: intel_opponent_fec, intel_opponent_anthropic,
intel_pulse_vps, intel_pulse_anthropic.

## Sub-User / Workspace Architecture

TCB runs on a workspace model: an **owner** (the candidate) has a
workspace. They can invite **sub-users** (team members) with their own
credentials who collaborate inside that workspace. Sub-users do not
have private workspaces — they see the owner's data, scoped by
permissions.

### Data model — `workspace_owner_id` vs `user_id`

Every workspace-scoped table (`tasks`, `events`, `opponents`, `notes`,
`folders`, `endorsements`, `contributions`, `briefings`, `api_usage`)
carries two columns:

- `user_id` — who created or last-touched the row. Used for **attribution
  / audit only**. Points to the actual caller's `users.id`, whether
  owner or sub-user.
- `workspace_owner_id` — which owner's workspace the row belongs to.
  Used as the **read and write filter column**. Every read query filters
  on `workspace_owner_id = ctx.ownerId`; every write binds
  `workspace_owner_id = ctx.ownerId`.

Tables with PK `user_id` (`profiles`, `budget`) are keyed to the owner
directly — one row per workspace. `chat_history` keeps `user_id` PK by
design (per-user Sam conversations, not shared).

Sub-user login creates a parallel `users` row with email
`<username>@sub.tcb`. The `sub_users` table links that anchor row back
to the owner via `sub_users.owner_id`. See `worker.js` around the
`getSessionContext` helper.

### Session resolution — `getSessionContext` + `requirePermission`

Every data endpoint calls `getSessionContext(request)` instead of the
older `getUserFromSession`. Returns:

| Caller | Shape |
|---|---|
| Owner | `{ userId, ownerId: userId, isSubUser: false, permissions: null }` |
| Sub-user | `{ userId, ownerId: <owner's users.id>, isSubUser: true, permissions: {...} }` |
| Revoked sub-user | `{ userId, ownerId: null, isSubUser: true, revoked: true }` |
| No valid session | `null` |

`requirePermission(ctx, tab, minLevel)` gates per-tab access:
- Owners always pass.
- Sub-users need `permissions[tab] === 'read'` (or 'full') for `minLevel='read'`,
  or `=== 'full'` for `minLevel='full'`.
- Missing key or revoked ctx → denied.

Standard denials (in `worker.js`):
- `denyPermission(tab)` → 403 `{error:'permission_denied', tab, message}`
- `denyOwnerOnly()` → 403 `{error:'owner_only', message}`
- `denyRevoked()` → 401 `{error:'Access revoked'}`

### Server-enforced permission gates (per endpoint)

**Reads** (require `<tab>/read`):
- `/api/tasks/load`, `/api/events/load` — calendar
- `/api/budget/load`, `/api/contributions/load` — budget
- `/api/notes/load` — notes
- `/api/endorsements/load` — endorsements
- `/api/opponents/list` — intel

**Reads with NO gate** (available to all authed users):
- `/api/profile/load`, `/api/campaigns/list`, `/api/briefing/load`,
  `/api/chat-history/load`
- `/api/data/load-all` — permission-filtered per sub-query. Hidden tabs
  return empty arrays (never 403 on the composite response).

**Writes** (require `<tab>/full`):

Per-row endpoints (current, use these):
- `/api/tasks/save`, `/api/tasks/delete` — calendar
- `/api/events/save`, `/api/events/delete` — calendar
- `/api/budget/save` — budget
- `/api/contributions/save`, `/api/contributions/delete` — budget
- `/api/folders/save`, `/api/folders/delete` — notes (folder delete
  cascades to child notes server-side)
- `/api/notes/save`, `/api/notes/delete` — notes
- `/api/endorsements/save`, `/api/endorsements/delete` — endorsements
- `/api/opponents/add`, `/refresh`, `/remove` — intel

Deprecated (still live for rollback, remove after a week):
- `/api/tasks/sync`, `/api/events/sync`, `/api/notes/sync`,
  `/api/endorsements/sync`, `/api/contributions/sync` — the original
  full-array-replace shape. Vulnerable to stale-client write races
  (caused the 2026-04-22 note-loss incident); replaced by the per-row
  endpoints above. Frontend no longer calls these.

**Owner-only (block sub-users with `denyOwnerOnly`):**
- `/api/profile/save`, `/api/briefing/save`
- `/api/campaigns/create`, `/archive`, `/delete`, `/api/data/reset`
- All `/api/users/*` (create, list, revoke, update-permissions,
  check-username)

### Write attribution (per-row endpoints)

Every per-row save endpoint uses the same upsert-preserving pattern:
1. `INSERT ... ON CONFLICT(id) DO UPDATE SET <mutable fields only>` —
   `user_id`, `workspace_owner_id`, and `created_at` are omitted from
   the SET clause so existing rows keep their original author on edit.
2. Every DELETE scopes on both the row id AND `workspace_owner_id`:
   `WHERE id = ? AND workspace_owner_id = ?`. A sub-user can't nuke
   rows in another workspace by id-guessing.

Folder delete is atomic cascade:
`DELETE FROM notes WHERE folder_id = ? AND workspace_owner_id = ?`
runs first, then the folder delete with the same workspace guard. No
orphans possible; no cross-workspace leakage.

### Write attribution (deprecated sync endpoints)

The now-deprecated `tasks/sync`, `events/sync`, `endorsements/sync`,
`contributions/sync` used an **upsert-preserving** pattern:
1. `DELETE FROM <table> WHERE workspace_owner_id = ? AND id NOT IN (incoming ids)`
   — removes rows the client dropped.
2. `INSERT ... ON CONFLICT(id) DO UPDATE SET <mutable fields only>` —
   preserves the original `user_id`, `workspace_owner_id`, and
   `created_at` on existing rows so a sub-user's sync doesn't rewrite
   attribution on rows they didn't create.

`notes/sync` was a full DELETE+INSERT (nested folder/note structure made
preservation awkward and notes traffic is low — documented in code;
attribution churn accepted for beta).

### Client permission gating

Three helpers in `app.html` (near `getD1Session`):
- `isSubUser()` — reads `tcb_is_sub_user` localStorage flag
- `canSee(tab)` — owner true; sub-user needs 'read' or 'full'
- `canEdit(tab)` — owner true; sub-user needs 'full'

`applyPermissionVisibility()`:
- Hides Settings nav for sub-users (hardcoded, not permission-gated)
- Hides tab nav buttons where `canSee(tab)` is false
- Routes user to Home if their currently-displayed view becomes
  inaccessible
- Called from `showOnboardedUI`, `loadFromD1`, and the 60-second
  permission poll

Write-action functions (`addDashTask`, `popupAddTask`,
`openAddEventModal`, `saveEvent`, `createNewNote`, `addEndorsement`,
`addOpponentFromInput`) guard with `canEdit(tab)` and show a
`showReadOnlyToast(tab)` if denied.

Read-only banner (`.ro-banner`) renders at the top of any view where
`canSee && !canEdit`. Injected by `renderReadOnlyBanner(viewName)` after
every `showView`.

### 403 handling

`handlePermissionDenied(body)` shows a red toast with the tab name and
routes the user to Home via `showView('dashboard')`.

**Currently wired: only `/api/opponents/list`.** That's the only
direct-fetch endpoint the frontend calls on a permission-gated tab.
Every other gated endpoint is only reached via `/api/data/load-all`,
which returns empty arrays for hidden tabs (no 403 to handle) — or via
write actions that are blocked client-side by `canEdit`.

See "Future hardening" below for when this needs extending.

### Attribution display

Server: `/api/data/load-all` returns `workspaceMembers: {user_id → name}`
and `ownerUserId`. Row-level load responses (tasks, events,
endorsements, contributions, notes, folders) include `user_id`.

Client: `workspaceMembers` and `workspaceOwnerUserId` are cached in
memory via `loadFromD1`. The `attributionBadge(userId)` helper returns
`''` for owner-authored or unknown-user rows, or a small gold pill
`<span class="attribution-tag">by Jane Smith</span>` for rows created
by a sub-user.

**Currently wired at one render site: `renderSidebarAgenda`** (the
dashboard's "today" list). Other renderers can opt in by inserting
`+ attributionBadge(item.user_id)` into their templates. No sub-user
authored data exists yet, so nothing visible renders today.

### Billing attribution

`api_usage.workspace_owner_id` captures the owner so costs roll up to
the billing workspace. `api_usage.user_id` records the actual caller
(sub-user or owner) for audit. Rate limiting (`usage_logs`) stays
per-`user_id` — each collaborator gets their own 100-message/day quota.

### Unified login endpoint

`POST /api/auth/login` handles both owners and sub-users in one
handler. `/auth/subuser-login` is kept as a pathname alias for
back-compat (old endpoint URL still works). Flow:

1. Rate-limit gate: count `success=0` rows in `login_attempts` for
   the lowercased+trimmed username in the last 15 minutes. If ≥5 →
   `429 too_many_attempts` with `retryAfterMinutes`.
2. Try `users` table (owners). If row exists with `password_hash` and
   hash matches → owner success, 30-day session.
3. If no owner match, try `sub_users` (without status filter — need
   to distinguish revoked from not-found).
4. Sub-user match + correct password + active → create/reuse
   `@sub.tcb` anchor in `users`, 30-day session, return full response
   including `isSubUser: true, permissions, ownerUserId,
   mustChangePassword`.
5. Sub-user match + correct password + revoked → `401 {error:
   'revoked', message: '...'}`. Anchor not created, no session.
6. No match anywhere → generic `401 invalid credentials`. Same error
   for wrong password as unknown username (no info leak about which
   usernames exist).

**Response fields added for sub-users:** `isSubUser, name, role,
permissions, ownerUserId, mustChangePassword`. Owner responses omit
sub-user fields but include `isSubUser: false` for clarity.

**Forced password-change takeover (`mustChangePassword: true`):**
Sub-users created via `/api/users/create` get `must_change_password =
1` by default. On login, the response flag is stored as
`localStorage['tcb_must_change_password']`. `initApp()` in `app.html`
checks this at the top and renders a full-screen takeover
(`renderForcedPasswordChange`) that blocks all other UI until the
user POSTs to `/api/auth/change-password`. Two-way sync via the 60s
verify-session poll handles mid-session changes across devices.

**Password rules (change-password endpoint):** ≥8 chars, must include
one number or symbol (`/[0-9\W_]/`), must differ from current hash.
Enforced both client-side (for UX) and server-side (authoritative).

### Future hardening

These are known gaps / deferred work, not bugs. Capture them here so
they aren't rediscovered:

1. **403 handler coverage.** Only `/api/opponents/list` is wired
   because it's the only direct-fetch gated path today. If the frontend
   ever adds a direct refresh-from-server call on Calendar, Budget,
   Notes, or Endorsements (separate from `data/load-all`), wrap the
   response with the same `if (r.status === 403) { return
   r.json().then(b => { handlePermissionDenied(b); throw … }); }`
   pattern. Longer-term a centralized `apiFetch(url, opts)` wrapper
   would be cleaner — not urgent.

2. **Billing integration for sub-users.** Pricing is $19.99/month per
   seat once Stripe goes active. The architecture is ready: seat count
   = `SELECT COUNT(*) FROM sub_users WHERE owner_id = ? AND status =
   'active'`. Wire into the Stripe subscription flow (quantity =
   seats + 1 for the owner, or seats as add-on line items — TBD when
   billing activates). **Do NOT surface pricing in the beta UI** —
   sub-user creation must stay free-looking until billing lives.

3. **"Usage by user" Settings view.** Data is already logged
   (`api_usage.user_id` + `workspace_owner_id` populated on every
   request). UI view deferred — when asked, build it as a Settings
   subview that queries `SELECT user_id, SUM(estimated_cost) FROM
   api_usage WHERE workspace_owner_id = ? GROUP BY user_id` and
   joins the names from `workspaceMembers`. Maybe 30 minutes of work.

4. **Attribution visibility.** Only the sidebar agenda renders the "by
   [Name]" badge today. Extend to calendar day modal, task lists in
   popups, note cards, endorsement cards as usage patterns demand.
   Call site is trivial — `+ attributionBadge(item.user_id)` inside
   each template's name line.

5. **Sub-user Settings UX.** Sub-users can't reach Settings at all
   right now (Settings is the only place to edit profile + team +
   reset data, all of which are owner-only). If a sub-user ever needs
   to do something self-service (change their own password, adjust
   notification prefs), that needs its own pared-down view.

6. **Per-IP login rate limiting.** Today `/api/auth/login` gates on
   per-username only (5 failures in 15 min → 15 min lockout, via the
   `login_attempts` table). Per-username doesn't catch distributed
   attackers trying many usernames from one IP. Add a second check
   with a tighter per-IP threshold (e.g. 15 failed attempts from one
   IP in an hour → IP block). Use `CF-Connecting-IP` from the request
   headers. Per-username+IP combo is the strictest layer and can be
   added if the other two aren't sufficient.

7. **login_attempts cleanup cron.** Table grows unbounded (fine at
   beta scale; plan for prod). Add a Cloudflare Cron Trigger running
   `DELETE FROM login_attempts WHERE attempted_at < datetime('now',
   '-30 days')` daily when Cron Triggers infra is set up.

8. **Owner password-change flow.** The current
   `/api/auth/change-password` is sub-user-only. Owners would need a
   separate flow (probably requiring currentPassword and landing in
   the Settings view, not a takeover). Out of scope until asked.

9. **Weak-password denylist.** Current rule is 8+ chars + at least
   one number or symbol. Add a denylist of top-1000 breached passwords
   (or the full HIBP check via k-anonymity) before non-beta.

10. **Server-side enforcement of mustChangePassword.** Today a
    motivated sub-user could bypass the client-side takeover by
    grabbing their session token from localStorage and hitting API
    endpoints directly — their new password wouldn't be set yet but
    they could still read/write workspace data. For stricter posture,
    every authed endpoint could check the flag via getSessionContext
    and 403 until it's cleared. Overkill for beta.

11. **Session revocation on password change.** Current behavior: the
    user's current session stays valid after they change password.
    Other active sessions (e.g. another device) also stay valid.
    Stricter posture: invalidate all sessions except the current one
    when a password is changed. Appropriate for a post-compromise
    change flow — not today.

12. **Expense rows need their own D1 table.** Expenses currently live
    in `campaignBudget.expenses` (localStorage only) — `saveBudget`
    only persists `total` and `categories` to D1. Consequences:
      - A user clearing browser cache loses all expense history.
      - Expenses don't sync across devices for the same user.
      - Sub-users can't see expenses logged by the owner (or vice
        versa) on a different device — the per-user permission model
        breaks down because the data never reaches the workspace.
      - No FEC-grade audit trail; no aggregate "spent by category"
        query is possible server-side, blocking analytics, exports,
        and Sam's Take spent-figures being server-authoritative.
      - Donations tab integration (matching contributions to
        expenditures, computing burn rate, etc.) is gated on this.
    Solution sketch: new `expenses` table with workspace_owner_id
    scoping + per-row save/delete endpoints (mirroring the pattern
    item 5 of the redesign already uses for events/tasks/notes/etc).
    Migrate existing localStorage entries to D1 on first load,
    flagged via a `tcb_expenses_migrated` localStorage marker.
    Larger than a checkpoint — separate effort.

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
- Always deploy BOTH backend AND frontend (see Deployment above)

## Search Architecture
Primary: VPS search (self-hosted, $0/call)
  - SearXNG + Trafilatura on Hetzner VPS
  - Auth: X-Search-Key: tcb-search-2026
  - 15 second timeout
  - REQUIRES HTTPS — set env.VPS_SEARCH_URL to HTTPS endpoint
  - Setup: domain with SSL pointing to 178.104.115.66:8889
    OR Cloudflare Tunnel to proxy the connection
Fallback: Anthropic built-in web_search (~$0.14/call)
All research calls try VPS first, Anthropic on failure.
Feature logged as: feature_vps or feature_anthropic in api_usage.

## Playwright Testing
- NEVER run Playwright tests against the live production site
- Tests must only run against local dev server or be skipped
- To run locally: `wrangler dev` then `npx playwright test`
- During active development: skip tests unless specifically asked
- Manual testing by Greg is preferred over automated tests hitting live
