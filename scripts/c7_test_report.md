# C7 — End-to-end test report

Sub-user architecture rebuild, checkpoint 7 of 8. Full test matrix run against the deployed C1–C6 stack.

## Setup

- **Owner A (Alice)** = `greg` (existing beta owner, `users.id = XQCx…gfO7`, Stephanie Murphy / Mayor / FL campaign `r0Fy…rhm`)
- **Owner B (Bob)** = `shannan` (existing beta owner, `users.id = qacL…iE82`)
- **Sub-user (SA)** = `alice-field1` / password `TestPass#1`, `users.id = tJay…kbx4`, `sub_users.id = Nkul…rC6E`, permissions `{calendar: full, budget: read}` (Intel hidden)
- For tests 11/12 Bob seeded with a campaign `geZ7…qQjh` and task `bobtask1` so isolation could be probed.

## Test matrix

| ID | What was tested | Expected | Actual | Pass/Fail |
|---|---|---|---|---|
| 1 | Sub-user `GET /api/campaigns/list` | Returns owner A's campaigns | count=1, owner_id=`XQCx…gfO7` (Alice) | **PASS** |
| 2 | Sub-user `POST /api/tasks/sync` creates a task | Row has user_id=SA, workspace_owner_id=A | `user_id=tJay…kbx4`, `workspace_owner_id=XQCx…gfO7` | **PASS** |
| 3 | Owner `GET /api/tasks/load` includes the sub-user's task | 1 task, named "Task authored by sub-user" | count=1, correct name | **PASS** |
| 4 | Sub-user `GET /api/tasks/load` sees the same task | Same 1 task | count=1, same name | **PASS** |
| 5 | Sub-user `POST /api/budget/save` (Budget=Read) | 403 permission_denied, tab=budget | 403 `{error:"permission_denied", tab:"budget"}` | **PASS** |
| 6 | Sub-user `GET /api/opponents/list` (Intel=Hidden) | 403 permission_denied, tab=intel | 403 `{error:"permission_denied", tab:"intel"}` | **PASS** |
| 7 | Sub-user `POST /api/users/create` (owner-only) | 403 owner_only | 403 `{error:"owner_only"}` | **PASS** |
| 8 | Sub-user `POST /api/campaigns/create` (owner-only) | 403 owner_only | 403 `{error:"owner_only"}` | **PASS** |
| 9 | Sub-user `POST /api/data/reset` (owner-only) | 403 owner_only | 403 `{error:"owner_only"}` | **PASS** |
| 10 | Sub-user `GET /api/tasks/load` returns zero Bob rows | Bob's `bobtask1` NOT in response | Only Alice's tasks present; `leaked bob? False` | **PASS** |
| 11 | Sub-user `POST /api/opponents/add` with Bob's campaignId (after granting Intel=full) | 404 Campaign not found | HTTP 404 `{error:"Campaign not found"}` | **PASS** |
| 12 | Sub-user `POST /api/campaigns/switch` to Bob's campaignId | 404 Campaign not found | HTTP 404 `{error:"Campaign not found"}` | **PASS** |
| 13 | Sub-user `GET /api/data/load-all` returns only Alice's data | profile=Alice's, workspaceMembers has Alice+SA only, isSubUser=true | profile=Stephanie Murphy, members=`{Alice, Alice Tester}`, `isSubUser:true`, `permissions:{calendar:full, budget:read}` | **PASS** |
| 14 | Forged `workspace_owner_id` in `tasks/sync` body — server must ignore | Row lands under SA's real workspace (Alice's), not forged value | Posted with forged `workspace_owner_id=Bob`, `user_id=Bob`; row stored with `workspace_owner_id=XQCx…` (Alice) and `user_id=tJay…` (SA's real id). Bob's tasks/load does NOT see it. | **PASS** |
| 15 | Owner revokes SA, then SA's next API call | 401 (session deleted) | `/api/tasks/load` → HTTP 401 `{error:"Not authenticated"}` | **PASS** |
| 16 | Owner `GET /api/tasks/load` after revoke — SA's task still present | Task still visible to owner | Task "Forged row" still present with `user_id=tJay…` (SA's) | **PASS** |
| 17 | SA's `users` row + historical task rows + revoked sub_users row all persist | 1/1/1 count | users=1, tasks_by_alice=1, sub_user_status_revoked=1 | **PASS** |
| 18 | NULL audit across 9 scoped tables | All scoped tables 0 NULL; api_usage 50 expected (pre-auth) | tasks=0, events=0, opponents=0, notes=0, folders=0, endorsements=0, contributions=0, briefings=0, api_usage=50 (as documented in C2) | **PASS** |
| 19 | No workspace is owned by a `@sub.tcb` users.id | 0 rows | 0 rows | **PASS** |

**Result: 19 / 19 PASS.**

## 403 handling coverage walkthrough

For each tab a sub-user might click into, traced what happens when the server returns 403 on initial load.

| Tab | Client-side gate | Server 403 surface | Handler |
|---|---|---|---|
| Home (dashboard) | always visible | n/a — dashboard doesn't hit permission-gated endpoints | n/a |
| Calendar | `canSee('calendar')` hides nav button if denied; `showView` reroutes to dashboard on entry if lost mid-session | tasks/load + events/load return 403 — but frontend only calls them via data/load-all, which returns empty arrays for hidden tabs. Direct calls to these endpoints don't exist in current frontend. | No direct 403 handler needed; data/load-all silent-empty is the path. |
| Budget | same client-side pattern | budget/load → 403; contributions/load → 403 | Same — only reached via data/load-all, silent-empty. If the UI ever adds a direct-fetch refresh, should add handler. |
| Notes | same | notes/load → 403 | Same — silent-empty via data/load-all. |
| Toolbox | same | toolbox is a static view (no fetch) | n/a |
| Intel (overlay) | `canSee('intel')` hides button; `toggleOverlay` shows read-only toast if called | **opponents/list → 403** — this one IS called directly from `loadOpponentsFromD1` when Intel panel opens | **Wired:** `handlePermissionDenied(body)` fires, red toast, routes to dashboard |
| Endorsements (overlay) | same pattern | endorsements/load → 403 | Only reached via data/load-all, silent-empty |
| Folders (overlay) | same | folders/notes — silent-empty via data/load-all | n/a |
| Settings | hardcoded hidden for sub-users (not permission-gated) | owner-only endpoints 403 on user_list/user_create/user_revoke/update_permissions | Sub-user never gets here since nav button is hidden and showView reroutes; not reachable |

**Gaps flagged:** None blocking for beta.

**Minor future hardening (not blocking):**
- If any future code path adds a direct `fetch('/api/tasks/load')` etc. separate from `data/load-all`, it should add the same `if (r.status === 403)` check that `loadOpponentsFromD1` has. Easy to extend via a fetch wrapper later. For now, every direct-fetch path that could hit 403 (only opponents/list) is handled.
- A centralized `apiFetch(url, opts)` wrapper would be a cleaner long-term solution. Currently each call site handles 401/403 explicitly. Not urgent — consistency is good across the handful of endpoints that matter.

## Cross-workspace isolation — critical security findings

### Read isolation (tests 10, 13)
- Sub-user's `GET /api/tasks/load` returned ONLY Alice's workspace tasks. Bob's `bobtask1` (same session's D1 row, real data) was filtered out. Filter happens via `WHERE workspace_owner_id = ctx.ownerId` where `ctx.ownerId` is resolved from `sub_users.owner_id` via the session's `users.email` lookup. The sub-user's browser cannot see any of Bob's data by any read path.
- `GET /api/data/load-all` returned only Alice's profile, campaigns, tasks, events, budget, folders, notes, briefing, endorsements, contributions. `workspaceMembers` included only Alice + sub-user (no Bob). `ownerUserId` correctly set to Alice's id.

### Write isolation via campaign_id reference (tests 11, 12)
- With Intel=full granted, sub-user attempted to attach an opponent to Bob's campaign (`geZ7…qQjh`). Server's `/api/opponents/add` does `SELECT id FROM campaigns WHERE id = ? AND owner_id = ?` bound to `ctx.ownerId` (Alice's id). Bob owns the campaign → no match → `HTTP 404 Campaign not found`.
- Sub-user attempted to switch active campaign to Bob's. Same `owner_id` check in `/api/campaigns/switch`. 404.

### Forged-body attack (test 14) — the one that would catch middleware bugs
- Sub-user sent `POST /api/tasks/sync` with a forged payload: `{"tasks":[{"id":"forged1", …, "workspace_owner_id":"<Bob's id>", "user_id":"<Bob's id>"}]}`.
- Server's sync endpoint **does not read `workspace_owner_id` or `user_id` from the request body.** It derives both from `ctx = await getSessionContext(request)`:
  - `user_id = ctx.userId` (SA's real id)
  - `workspace_owner_id = ctx.ownerId` (Alice's id, resolved from SA's sub_users row)
- Row stored with `user_id=tJay…kbx4` (SA) and `workspace_owner_id=XQCx…gfO7` (Alice) — **not** the forged Bob values.
- Bob's session reading `/api/tasks/load` does NOT see `forged1`. Confirmed with `bob sees: ['bobtask1']` — the forged row is invisible to Bob's workspace.

### Architectural claim verified
The write endpoints bind scope values from `ctx` (derived from the session token via the `users → sub_users` lookup chain), never from the request body. This means:
1. A sub-user with a valid session cannot escalate to another workspace by crafting body fields.
2. A sub-user with a stolen session still only writes to their owner's workspace.
3. Revocation (flipping `sub_users.status = 'revoked'`) immediately makes the session return `ownerId: null, revoked: true` from `getSessionContext`, which triggers `denyRevoked() → 401` on every endpoint.

**Cross-workspace isolation: verified at every layer tested.**

## Cleanup
Test artifacts deleted after test run: forged task row, Bob's test campaign + task, revoked sub-user record.
