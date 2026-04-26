-- Per-turn forensic log of Sam's tool invocations + final response.
--
-- Built in response to the lookup_jurisdiction-was-ignored bug
-- (2026-04-25): Sam's `executeToolCall`-side activity is invisible to
-- the worker, so when she calls a tool but disregards its output we
-- have no server-side record of what happened. Manual visual testing
-- caught the bug; this table catches the next instance automatically.
--
-- One row per chat turn (a turn = the user's message + Sam's full
-- multi-round response). Client posts the log fire-and-forget after
-- the turn completes; logging failure must not block UX.
--
-- Columns:
--   id                — random; PK
--   user_id           — anchor row id of the caller (sub-user or owner)
--   workspace_owner_id — workspace billing/scope key
--   created_at        — server-side timestamp
--   user_message      — the user's prompt (first 500 chars, for context)
--   tool_calls        — JSON array of {name, input_summary, output_summary}
--                       output_summary is truncated at ~400 chars for storage;
--                       full content is reconstructible from per-tool caches
--                       (jurisdiction_lookups, etc.) when needed
--   response_excerpt  — Sam's final text response (first 800 chars)
--
-- Query pattern for finding "tool fired but result ignored" cases:
--   SELECT user_message, tool_calls, response_excerpt
--   FROM sam_turn_logs
--   WHERE tool_calls LIKE '%lookup_jurisdiction%'
--     AND response_excerpt LIKE '%<suspect city>%'
--
-- Cleanup: rows accumulate; sweep manually or wire a cron later.
-- Cheap to keep — text-only, ~1KB/row average. 10K turns/year = 10MB.
--
-- Rollback: DROP TABLE sam_turn_logs.

CREATE TABLE IF NOT EXISTS sam_turn_logs (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT,
  workspace_owner_id  TEXT,
  created_at          TEXT DEFAULT (datetime('now')),
  user_message        TEXT,
  tool_calls          TEXT,
  response_excerpt    TEXT
);

CREATE INDEX IF NOT EXISTS idx_sam_turn_logs_workspace_time
  ON sam_turn_logs(workspace_owner_id, created_at DESC);
