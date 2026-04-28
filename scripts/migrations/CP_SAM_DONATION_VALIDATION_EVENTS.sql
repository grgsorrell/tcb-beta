-- Per-event log of donation-limit validator firings.
--
-- Architectural twin of sam_compliance_validation_events (Class A)
-- and sam_finance_validation_events (Class B). Same shape, dollar-
-- amount semantics instead of date semantics.
--
-- action_taken values:
--   'passed'      — no drift, or Sam deferred with authority contact
--   'regenerated' — Sam stated unverified amount/URL; regen succeeded
--   'stripped'    — regen also failed; offending sentences removed
--
-- fabrication_type categorizes which class triggered the action:
--   'amount' | 'url' | 'both' | 'none'
--
-- Note: amount semantics differ from date semantics — the audit
-- Haiku must disambiguate "donation limits" amounts from "budget"
-- or "fundraising totals" amounts in Sam's response. The validator
-- prompt is scoped to dollar amounts presented as contribution
-- limits or maximum donations specifically.
--
-- Rollback: DROP TABLE sam_donation_validation_events.

CREATE TABLE IF NOT EXISTS sam_donation_validation_events (
  id                          TEXT PRIMARY KEY,
  conversation_id             TEXT,
  workspace_owner_id          TEXT,
  user_id                     TEXT,
  action_taken                TEXT NOT NULL,
  sam_claimed_amounts         TEXT,
  authoritative_amounts       TEXT,
  unauthorized_amounts        TEXT,
  sam_claimed_urls            TEXT,
  unauthorized_urls           TEXT,
  fabrication_type            TEXT,
  original_response_excerpt   TEXT,
  final_response_excerpt      TEXT,
  created_at                  TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_donation_val_conv
  ON sam_donation_validation_events(conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_donation_val_workspace
  ON sam_donation_validation_events(workspace_owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_donation_val_action
  ON sam_donation_validation_events(action_taken, created_at DESC);
