-- Sam v2 Phase 1 — User-as-authority + onboarding extension
--
-- Adds five columns to profiles to capture user-supplied identity data:
--   candidate_site_url          — campaign website URL entered during onboarding
--   candidate_site_content      — fetched HTML stripped to text (max 10,000 chars)
--   candidate_site_fetched_at   — ISO timestamp of last fetch (for "Last updated" UI)
--   candidate_bio_text          — fallback bio when no URL provided (max 1,000 chars)
--   early_voting_start_date     — date string (YYYY-MM-DD) for "Early Voting Begins" calendar event
--
-- All five are nullable. Profile rows pre-existing this migration get NULL on each.
-- Application enforces caps (10K site content, 1K bio); DB stores TEXT with no
-- column-level cap, so migrations adjusting cap don't require schema changes.
--
-- Rollback: ALTER TABLE profiles DROP COLUMN <name>; (run for each column).

ALTER TABLE profiles ADD COLUMN candidate_site_url TEXT;
ALTER TABLE profiles ADD COLUMN candidate_site_content TEXT;
ALTER TABLE profiles ADD COLUMN candidate_site_fetched_at TEXT;
ALTER TABLE profiles ADD COLUMN candidate_bio_text TEXT;
ALTER TABLE profiles ADD COLUMN early_voting_start_date TEXT;
