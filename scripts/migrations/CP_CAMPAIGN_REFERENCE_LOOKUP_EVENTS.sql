-- CP_CAMPAIGN_REFERENCE_LOOKUP_EVENTS.sql
-- 2026-05-09
--
-- Phase 2 of campaign_reference: telemetry for the pre-fetch hook.
--
-- Logged on every chat turn where classifyForReferenceLookup runs
-- (whether or not it fires a lookup). Lets us answer:
--   - What % of turns trigger a lookup?
--   - State extraction success rate?
--   - Category detection accuracy?
--   - When lookup fires, what's the average rows_returned?
--   - Which row IDs surface most often (signals about coverage gaps)?
--   - How often do we get state-detected-but-no-category-match
--     (signals about classifier signal-word coverage gaps — V2 input)?
--
-- Decoupled from sam_citation_validation_events because pre-fetch is a
-- pre-Sam-call event, not a post-Sam validation event.

CREATE TABLE IF NOT EXISTS campaign_reference_lookup_events (
  id TEXT PRIMARY KEY,
  conversation_id TEXT,
  user_id TEXT,
  workspace_owner_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),

  user_message_excerpt TEXT,           -- first 500 chars
  classifier_decision TEXT NOT NULL,   -- 'lookup_fired' | 'lookup_fired_no_matches' | 'no_state' | 'no_specific_category_match' | 'empty_message' | 'error' | 'skipped_non_gemini'
  state_extracted TEXT,                -- 2-letter code, NULL if state extraction failed
  category_extracted TEXT,             -- enum value, NULL if no category detected OR no lookup
  rows_returned INTEGER NOT NULL DEFAULT 0,
  row_ids TEXT,                        -- JSON array of matched ids (for debug)
  raw_classifier_output TEXT           -- JSON of full classifier result (for forensic)
);

CREATE INDEX IF NOT EXISTS idx_camp_ref_lookup_user_time ON campaign_reference_lookup_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_camp_ref_lookup_state ON campaign_reference_lookup_events(state_extracted);
CREATE INDEX IF NOT EXISTS idx_camp_ref_lookup_decision ON campaign_reference_lookup_events(classifier_decision);
