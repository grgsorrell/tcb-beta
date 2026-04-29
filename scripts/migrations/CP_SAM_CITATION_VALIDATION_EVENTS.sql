-- Citation Validator events (Phase 5a)
--
-- Built 2026-04-29 as the catch-all post-generation validator.
-- Runs AFTER all per-fact-class validators (geographic, compliance A,
-- compliance B finance, donation, opponent). Detects specific factual
-- claims that aren't supported by Ground Truth, Intel data, tool memory,
-- or user-provided messages this conversation.
--
-- Two action paths:
--   high_stakes (dollar / date / phone / url / address / person / statute)
--     → STRIPPED (sentence-level removal + footer note)
--   soft (percentage / statistic / benchmark / electoral_history /
--         organizational_characterization)
--     → TAGGED (inline "(unverified)" appended to the claim)
--
-- action_taken values: 'passed' | 'tagged' | 'stripped'
--
-- Only 'stripped' rows count toward Safe Mode threshold via
-- getValidatorFiringBreakdown — that helper filters
-- action_taken IN ('regenerated','stripped'). Tagged events are
-- visible-to-user uncertainty signals, not reliability degradations,
-- so they do not contribute to Safe Mode activation.
--
-- sam_unverified_claims is the JSON {high_stakes:[...], soft:[...]}
-- detected by the audit Haiku.
-- claim_categories is JSON with counts per bucket — for analytics
-- queries; the audit Haiku doesn't sub-categorize beyond high/soft.
--
-- Rollback: DROP TABLE sam_citation_validation_events.

CREATE TABLE IF NOT EXISTS sam_citation_validation_events (
  id                          TEXT PRIMARY KEY,
  conversation_id             TEXT,
  workspace_owner_id          TEXT,
  user_id                     TEXT,
  action_taken                TEXT NOT NULL,
  sam_unverified_claims       TEXT,
  claim_categories            TEXT,
  original_response_excerpt   TEXT,
  final_response_excerpt      TEXT,
  created_at                  TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_citation_val_conv
  ON sam_citation_validation_events(conversation_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_citation_val_workspace
  ON sam_citation_validation_events(workspace_owner_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_citation_val_action
  ON sam_citation_validation_events(action_taken, created_at DESC);
