-- C1: Sub-user architecture rebuild — schema prep.
-- Adds workspace_owner_id column + index to every data table that needs to
-- route reads/writes through an owner's workspace instead of the raw session
-- user_id. Column is nullable at this stage. No Worker code reads it yet;
-- that flips in C4 (reads) and C5 (writes). Backfill happens in C2.
--
-- Tables touched: tasks, events, opponents, notes, folders, endorsements,
-- contributions, briefings, api_usage (9 tables).
--
-- Not touched: campaigns (already uses owner_id), sub_users, sessions,
-- users, auth_tokens, password_resets, subscriptions, invoices,
-- payment_methods, usage_logs, activity_log. profiles + budget + chat_history
-- are handled separately in C2 per their per-user PK semantics.

ALTER TABLE tasks         ADD COLUMN workspace_owner_id TEXT;
ALTER TABLE events        ADD COLUMN workspace_owner_id TEXT;
ALTER TABLE opponents     ADD COLUMN workspace_owner_id TEXT;
ALTER TABLE notes         ADD COLUMN workspace_owner_id TEXT;
ALTER TABLE folders       ADD COLUMN workspace_owner_id TEXT;
ALTER TABLE endorsements  ADD COLUMN workspace_owner_id TEXT;
ALTER TABLE contributions ADD COLUMN workspace_owner_id TEXT;
ALTER TABLE briefings     ADD COLUMN workspace_owner_id TEXT;
ALTER TABLE api_usage     ADD COLUMN workspace_owner_id TEXT;

CREATE INDEX IF NOT EXISTS idx_tasks_workspace         ON tasks(workspace_owner_id);
CREATE INDEX IF NOT EXISTS idx_events_workspace        ON events(workspace_owner_id);
CREATE INDEX IF NOT EXISTS idx_opponents_workspace     ON opponents(workspace_owner_id);
CREATE INDEX IF NOT EXISTS idx_notes_workspace         ON notes(workspace_owner_id);
CREATE INDEX IF NOT EXISTS idx_folders_workspace       ON folders(workspace_owner_id);
CREATE INDEX IF NOT EXISTS idx_endorsements_workspace  ON endorsements(workspace_owner_id);
CREATE INDEX IF NOT EXISTS idx_contributions_workspace ON contributions(workspace_owner_id);
CREATE INDEX IF NOT EXISTS idx_briefings_workspace     ON briefings(workspace_owner_id);
CREATE INDEX IF NOT EXISTS idx_api_usage_workspace     ON api_usage(workspace_owner_id);
