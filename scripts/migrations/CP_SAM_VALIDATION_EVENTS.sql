-- Per-validation log of Sam's lookup_jurisdiction post-processing.
--
-- Built 2026-04-25 after THREE prompt iterations failed to stop Sam
-- from recommending Altamonte Springs (Seminole County) for an Orange
-- County, FL race. Haiku 4.5 has a hard ceiling on prompt-following
-- for this class of fact — her training-data priors about "Orlando
-- metro area" beat any rule we wrote.
--
-- The fix: server-side validator that intercepts Sam's responses
-- BEFORE delivery to the user. If she mentions a place not in the
-- authorized lookup_jurisdiction result, regenerate with explicit
-- feedback (Option B) or strip the offending sentences (Option A
-- fallback). This table logs every validation event so we can:
--   - Measure how often the validator fires (Sam's prompt-compliance
--     rate going up or down over Haiku versions)
--   - Confirm regeneration usually succeeds vs. needs strip-fallback
--   - Audit the rare "stripped" cases for false positives
--
-- Rollback: DROP TABLE sam_validation_events.

CREATE TABLE IF NOT EXISTS sam_validation_events (
  id                          TEXT PRIMARY KEY,
  workspace_owner_id          TEXT,
  user_id                     TEXT,
  created_at                  TEXT DEFAULT (datetime('now')),
  jurisdiction_name           TEXT,
  authorized_count            INTEGER,
  sam_mentioned_locations     TEXT,    -- JSON array of all places Sam mentioned
  unauthorized_locations      TEXT,    -- JSON subset that triggered validation
  action_taken                TEXT,    -- 'passed' | 'regenerated' | 'stripped'
  original_response_excerpt   TEXT,    -- first 600 chars of Sam's first response
  final_response_excerpt      TEXT     -- first 600 chars of what was actually delivered
);

CREATE INDEX IF NOT EXISTS idx_sam_validation_workspace_time
  ON sam_validation_events(workspace_owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sam_validation_action
  ON sam_validation_events(action_taken, created_at DESC);
