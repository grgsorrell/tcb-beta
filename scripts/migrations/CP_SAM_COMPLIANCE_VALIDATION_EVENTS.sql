-- Per-event log of compliance-date validator firings.
--
-- Built parallel to sam_validation_events (the geographic validator).
-- Same shape, same purpose: forensic record of every Sam response that
-- mentioned a compliance deadline and the validator's verdict on
-- whether her dates matched authoritative data.
--
-- Validator pipeline (post-generation):
--   1. Detect compliance signals in Sam's draft response (filing
--      deadline, qualifying period, petition deadline, ballot access)
--   2. If signals found, locate the most recent
--      lookup_compliance_deadlines result in this conversation
--      (sam_tool_memory) or by candidate profile
--      (compliance_deadlines_cache)
--   3. Cheap Haiku audit call extracts dates Sam claimed
--   4. Cross-check against authoritative dates from the lookup
--   5. action_taken:
--        'passed'      — no drift, or Sam deferred with authority contact
--        'regenerated' — Sam stated an unverified date; regen with feedback
--        'stripped'    — regen also failed; offending sentences removed
--
-- Query pattern for measuring deferral quality:
--   SELECT final_response_excerpt FROM sam_compliance_validation_events
--   WHERE action_taken = 'passed'
--     AND sam_claimed_dates = '[]'
-- shows messages where Sam correctly deferred with no specific date.
--
-- Rollback: DROP TABLE sam_compliance_validation_events.

CREATE TABLE IF NOT EXISTS sam_compliance_validation_events (
  id                          TEXT PRIMARY KEY,
  conversation_id             TEXT,
  workspace_owner_id          TEXT,
  user_id                     TEXT,
  action_taken                TEXT NOT NULL,
  sam_claimed_dates           TEXT,
  authoritative_dates         TEXT,
  unauthorized_dates          TEXT,
  original_response_excerpt   TEXT,
  final_response_excerpt      TEXT,
  created_at                  TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sam_compliance_val_conv
  ON sam_compliance_validation_events(conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sam_compliance_val_workspace
  ON sam_compliance_validation_events(workspace_owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sam_compliance_val_action
  ON sam_compliance_validation_events(action_taken, created_at DESC);
