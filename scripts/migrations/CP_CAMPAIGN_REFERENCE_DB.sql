-- CP_CAMPAIGN_REFERENCE_DB.sql
-- 2026-05-09
--
-- Verified-fact reference database for Sam's pre-fetch context assembly.
-- Phase 1: schema + lookup endpoint (this migration).
-- Phase 2 (separate): wire lookupCampaignReference into pre-fetch logic.
--
-- Idempotent re-import via deterministic id (sha256 of state+question, 16
-- chars) plus ON CONFLICT(id) DO UPDATE in import_campaign_reference.mjs.
-- Re-running the same JSON file updates rows in place; never duplicates.
--
-- import_batch_id stamped per-import for batch-level rollback:
--   DELETE FROM campaign_reference WHERE import_batch_id = '<batch>';

CREATE TABLE IF NOT EXISTS campaign_reference (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL,                -- two-letter state code, uppercased
  office_level TEXT NOT NULL,         -- JSON array as TEXT, e.g. '["state","district","county"]'
  category TEXT NOT NULL,             -- ballot_access | finance_ethics | voter_interaction | election_dates | residency | filing_requirements | redistricting | runoff_rules | recall_rules | candidate_eligibility
  question TEXT NOT NULL,
  question_variants TEXT,             -- JSON array as TEXT, optional
  answer TEXT NOT NULL,
  source_url TEXT NOT NULL,
  source_name TEXT,
  last_verified_date TEXT NOT NULL,   -- ISO YYYY-MM-DD
  update_frequency TEXT NOT NULL,     -- static | per_cycle | volatile
  verification_method TEXT NOT NULL,  -- official_source_direct | secondary_source | statute_citation
  scope TEXT,
  import_batch_id TEXT,               -- groups rows from a single import for rollback
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_campaign_reference_state_category ON campaign_reference(state, category);
CREATE INDEX IF NOT EXISTS idx_campaign_reference_state ON campaign_reference(state);
CREATE INDEX IF NOT EXISTS idx_campaign_reference_category ON campaign_reference(category);
CREATE INDEX IF NOT EXISTS idx_campaign_reference_update_freq ON campaign_reference(update_frequency);
CREATE INDEX IF NOT EXISTS idx_campaign_reference_batch ON campaign_reference(import_batch_id);
