-- Per-event log of finance-report validator firings (Class B).
--
-- Architectural twin of sam_compliance_validation_events (Class A).
-- Same shape, same purpose: forensic record of every Sam response
-- that mentioned a finance-report deadline and the validator's
-- verdict on whether her dates/URLs matched authoritative data.
--
-- action_taken values:
--   'passed'      — no drift, or Sam deferred with authority contact
--   'regenerated' — Sam stated unverified date/URL; regen succeeded
--   'stripped'    — regen also failed; offending sentences removed
--
-- fabrication_type categorizes which class triggered the action:
--   'date' | 'url' | 'both' | 'none'
--
-- Rollback: DROP TABLE sam_finance_validation_events.

CREATE TABLE IF NOT EXISTS sam_finance_validation_events (
  id                          TEXT PRIMARY KEY,
  conversation_id             TEXT,
  workspace_owner_id          TEXT,
  user_id                     TEXT,
  action_taken                TEXT NOT NULL,
  sam_claimed_dates           TEXT,
  authoritative_dates         TEXT,
  unauthorized_dates          TEXT,
  sam_claimed_urls            TEXT,
  unauthorized_urls           TEXT,
  fabrication_type            TEXT,
  original_response_excerpt   TEXT,
  final_response_excerpt      TEXT,
  created_at                  TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_finance_val_conv
  ON sam_finance_validation_events(conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_finance_val_workspace
  ON sam_finance_validation_events(workspace_owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_finance_val_action
  ON sam_finance_validation_events(action_taken, created_at DESC);
