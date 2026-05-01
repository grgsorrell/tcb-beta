-- Sam blank-response detection + retry + fallback (Sam v2 Phase 4 follow-up)
--
-- Logs every turn where Sam's main API call produced no text and no
-- tool_use blocks. The chat handler retries once, and if the retry also
-- blanks, ships a substantive fallback. This table records all four
-- states so we can monitor blank-rate post-deploy and decide whether
-- a deeper fix is warranted.
--
-- Columns:
--   original_blanked  — 1 if first call returned content with neither text nor tool_use
--   retry_attempted   — 1 if we ran a retry (currently == original_blanked)
--   retry_blanked     — 1 if the retry also returned blank content
--   fallback_used     — 1 if we replaced data.content with the substantive fallback message
--
-- Intentional: rows are written ONLY when original_blanked = 1. Non-blank
-- responses are not logged here (no value vs the existing telemetry).
--
-- Rollback: DROP TABLE sam_blank_response_events.

CREATE TABLE IF NOT EXISTS sam_blank_response_events (
  id                  TEXT PRIMARY KEY,
  conversation_id     TEXT,
  workspace_owner_id  TEXT,
  user_id             TEXT,
  original_blanked    INTEGER NOT NULL,
  retry_attempted     INTEGER NOT NULL,
  retry_blanked       INTEGER NOT NULL,
  fallback_used       INTEGER NOT NULL,
  created_at          TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_blank_response_conv
  ON sam_blank_response_events(conversation_id, created_at DESC);
