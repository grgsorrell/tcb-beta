-- Donation limits cache (Compliance Class B donation-limit variant).
--
-- Backs lookup_donation_limits — same architecture as
-- compliance_deadlines_cache (Class A) and finance_reports_cache
-- (Class B finance reports): keyed on race profile, 90-day TTL,
-- status field semantics, authority always populated.
--
-- Status:
--   'found'       — verified contribution limits from authoritative source
--   'partial'     — some fields known (e.g., per-election known but
--                   counts-separately unknown)
--   'unsupported' — no limit data; authority contact still populated
--
-- Source priority (when populating):
--   FEC for federal → state election commission → unsupported
--
-- This checkpoint stubs all source paths — every lookup currently
-- returns status='unsupported'. Real FEC contribution-limits
-- integration is deferred (the FEC API has /v1/contribution-limits/
-- but it's a separate endpoint from the existing TCB FEC integration).
--
-- limits_json shape (when populated):
--   {
--     "individual_per_election": "$1,000",
--     "individual_per_cycle": "$2,000",
--     "counts_primary_and_general_separately": true,
--     "notes": "..."
--   }
--
-- Scope explicitly excludes PAC limits, party committee limits,
-- self-fund rules, and aggregate limits. Those are separate fact
-- classes for future checkpoints.
--
-- Rollback: DROP TABLE donation_limits_cache.

CREATE TABLE IF NOT EXISTS donation_limits_cache (
  id                TEXT PRIMARY KEY,
  state_code        TEXT NOT NULL,
  office_normalized TEXT NOT NULL,
  race_year         INTEGER NOT NULL,
  jurisdiction_name TEXT,
  status            TEXT NOT NULL,
  limits_json       TEXT,
  authority_json    TEXT,
  source            TEXT,
  last_updated      TEXT,
  created_at        TEXT DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_donation_cache_key
  ON donation_limits_cache(state_code, office_normalized, race_year, COALESCE(jurisdiction_name, ''));

CREATE INDEX IF NOT EXISTS idx_donation_cache_updated
  ON donation_limits_cache(last_updated DESC);
