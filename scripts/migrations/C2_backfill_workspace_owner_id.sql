-- C2: Sub-user architecture rebuild — backfill workspace_owner_id.
-- Steps M2 + M3 + M5 from the plan. M4 is an audit run out-of-band.
--
-- M2: For every owner-created row (user_id points to a real users row
--     whose email does NOT end @sub.tcb), set workspace_owner_id = user_id.
--     Each owner IS their own workspace, so the backfill is trivial.
--
-- M3: For every sub-user-created row (user_id points to a users row whose
--     email ends @sub.tcb), resolve the owner via sub_users and set
--     workspace_owner_id = sub_users.owner_id. Should hit 0 rows in
--     current prod DB — no sub-user has ever done real work — but runs
--     correctly for any future orphans.
--
-- M5: Delete sub-user rows in profiles/budget (user_id ends @sub.tcb).
--     These represent attempted private onboarding/budget by a sub-user
--     that will never be reachable again under the new architecture.

-- =================== M2: Owner-created rows ===================
UPDATE tasks SET workspace_owner_id = user_id
WHERE workspace_owner_id IS NULL
  AND user_id IN (SELECT id FROM users WHERE email NOT LIKE '%@sub.tcb');
UPDATE events SET workspace_owner_id = user_id
WHERE workspace_owner_id IS NULL
  AND user_id IN (SELECT id FROM users WHERE email NOT LIKE '%@sub.tcb');
UPDATE opponents SET workspace_owner_id = user_id
WHERE workspace_owner_id IS NULL
  AND user_id IN (SELECT id FROM users WHERE email NOT LIKE '%@sub.tcb');
UPDATE notes SET workspace_owner_id = user_id
WHERE workspace_owner_id IS NULL
  AND user_id IN (SELECT id FROM users WHERE email NOT LIKE '%@sub.tcb');
UPDATE folders SET workspace_owner_id = user_id
WHERE workspace_owner_id IS NULL
  AND user_id IN (SELECT id FROM users WHERE email NOT LIKE '%@sub.tcb');
UPDATE endorsements SET workspace_owner_id = user_id
WHERE workspace_owner_id IS NULL
  AND user_id IN (SELECT id FROM users WHERE email NOT LIKE '%@sub.tcb');
UPDATE contributions SET workspace_owner_id = user_id
WHERE workspace_owner_id IS NULL
  AND user_id IN (SELECT id FROM users WHERE email NOT LIKE '%@sub.tcb');
UPDATE briefings SET workspace_owner_id = user_id
WHERE workspace_owner_id IS NULL
  AND user_id IN (SELECT id FROM users WHERE email NOT LIKE '%@sub.tcb');
-- api_usage: same pattern, but pre-auth anonymous rows (user_id '' or
-- NULL, or pointing to a deleted users row) will stay NULL and that's
-- OK — they're billing history with no workspace to attribute to.
UPDATE api_usage SET workspace_owner_id = user_id
WHERE workspace_owner_id IS NULL
  AND user_id IS NOT NULL AND user_id != ''
  AND user_id IN (SELECT id FROM users WHERE email NOT LIKE '%@sub.tcb');

-- =================== M3: Sub-user-created rows ===================
UPDATE tasks SET workspace_owner_id = (
  SELECT s.owner_id FROM sub_users s
  JOIN users u ON u.email = s.username || '@sub.tcb'
  WHERE u.id = tasks.user_id
)
WHERE workspace_owner_id IS NULL
  AND user_id IN (SELECT id FROM users WHERE email LIKE '%@sub.tcb');
UPDATE events SET workspace_owner_id = (
  SELECT s.owner_id FROM sub_users s
  JOIN users u ON u.email = s.username || '@sub.tcb'
  WHERE u.id = events.user_id
)
WHERE workspace_owner_id IS NULL
  AND user_id IN (SELECT id FROM users WHERE email LIKE '%@sub.tcb');
UPDATE opponents SET workspace_owner_id = (
  SELECT s.owner_id FROM sub_users s
  JOIN users u ON u.email = s.username || '@sub.tcb'
  WHERE u.id = opponents.user_id
)
WHERE workspace_owner_id IS NULL
  AND user_id IN (SELECT id FROM users WHERE email LIKE '%@sub.tcb');
UPDATE notes SET workspace_owner_id = (
  SELECT s.owner_id FROM sub_users s
  JOIN users u ON u.email = s.username || '@sub.tcb'
  WHERE u.id = notes.user_id
)
WHERE workspace_owner_id IS NULL
  AND user_id IN (SELECT id FROM users WHERE email LIKE '%@sub.tcb');
UPDATE folders SET workspace_owner_id = (
  SELECT s.owner_id FROM sub_users s
  JOIN users u ON u.email = s.username || '@sub.tcb'
  WHERE u.id = folders.user_id
)
WHERE workspace_owner_id IS NULL
  AND user_id IN (SELECT id FROM users WHERE email LIKE '%@sub.tcb');
UPDATE endorsements SET workspace_owner_id = (
  SELECT s.owner_id FROM sub_users s
  JOIN users u ON u.email = s.username || '@sub.tcb'
  WHERE u.id = endorsements.user_id
)
WHERE workspace_owner_id IS NULL
  AND user_id IN (SELECT id FROM users WHERE email LIKE '%@sub.tcb');
UPDATE contributions SET workspace_owner_id = (
  SELECT s.owner_id FROM sub_users s
  JOIN users u ON u.email = s.username || '@sub.tcb'
  WHERE u.id = contributions.user_id
)
WHERE workspace_owner_id IS NULL
  AND user_id IN (SELECT id FROM users WHERE email LIKE '%@sub.tcb');
UPDATE briefings SET workspace_owner_id = (
  SELECT s.owner_id FROM sub_users s
  JOIN users u ON u.email = s.username || '@sub.tcb'
  WHERE u.id = briefings.user_id
)
WHERE workspace_owner_id IS NULL
  AND user_id IN (SELECT id FROM users WHERE email LIKE '%@sub.tcb');
UPDATE api_usage SET workspace_owner_id = (
  SELECT s.owner_id FROM sub_users s
  JOIN users u ON u.email = s.username || '@sub.tcb'
  WHERE u.id = api_usage.user_id
)
WHERE workspace_owner_id IS NULL
  AND user_id IN (SELECT id FROM users WHERE email LIKE '%@sub.tcb');

-- =================== M5: Clean per-user-PK tables ===================
-- profiles and budget are keyed by user_id as PK. Under the new model,
-- these become per-workspace (owner-only edit surface). Delete any rows
-- keyed to a sub-user — they were private onboarding/budget attempts
-- and will never be reachable once reads switch over.
DELETE FROM profiles
WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@sub.tcb');
DELETE FROM budget
WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@sub.tcb');
