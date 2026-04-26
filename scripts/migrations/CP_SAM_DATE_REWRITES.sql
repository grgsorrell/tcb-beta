-- Server-side relative-date preprocessor telemetry.
--
-- Each row captures one user message that contained a relative-date
-- phrase (e.g., "next Saturday", "tomorrow", "two weeks from now").
-- The preprocessor rewrites the message before it's sent to Anthropic
-- by appending an absolute date in parentheses after each phrase.
-- This table records what was rewritten so we can:
--   - Measure which phrases users actually use (telemetry for which
--     patterns matter, vs. which we built speculatively)
--   - Audit Sam's responses against the rewritten input ("did Sam
--     still drift even after we handed her the absolute date?")
--   - Evaluate the preprocessor's coverage when new failure modes
--     surface (which phrases passed through unrewritten)
--
-- Lifecycle:
--   write — chat handler, fire-and-forget, only when patterns_matched
--     is non-empty (no row for messages with no relative dates)
--   no purge endpoint — these are forensic-only, no UI side effects
--
-- Storage notes:
--   original_message and rewritten_message capped at 2000 chars each
--   (typical user message is ~50-150 chars; cap is defensive against
--   pasted-document edge cases)
--
-- Rollback: DROP TABLE sam_date_rewrites.

CREATE TABLE IF NOT EXISTS sam_date_rewrites (
  id                  TEXT PRIMARY KEY,
  conversation_id     TEXT,
  workspace_owner_id  TEXT,
  user_id             TEXT,
  original_message    TEXT,
  rewritten_message   TEXT,
  patterns_matched    TEXT,
  created_at          TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sam_date_rewrites_conv_time
  ON sam_date_rewrites(conversation_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_sam_date_rewrites_workspace_time
  ON sam_date_rewrites(workspace_owner_id, created_at DESC);
