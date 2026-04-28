-- Campaign finance reports cache (Compliance Class B).
--
-- Backs lookup_finance_reports — same architecture as
-- compliance_deadlines_cache (Class A): keyed on race profile,
-- 90-day TTL, status field semantics, authority always populated.
--
-- Status values:
--   'found'       — verified report schedule from authoritative source
--   'partial'     — some reports known, others NULL
--   'unsupported' — no report data; authority contact still populated
--
-- Source priority (when populating):
--   FEC for federal races → state SOS for state-level → unsupported
--
-- This checkpoint stubs all source paths. Every lookup currently
-- returns status='unsupported'. Real FEC reporting-calendar
-- integration is deferred; the existing TCB research service
-- exposes candidate finance totals, not reporting dates.
--
-- reports_json shape (when populated):
--   {
--     "quarterly_schedule": [
--       {"report_name": "Q1 2026", "coverage_period": "...",
--        "due_date": "2026-04-15", "filing_window_close": "..."},
--       ...
--     ],
--     "pre_election_special": [{"report_name": "Pre-Primary", ...}, ...],
--     "post_election": {"report_name": "Post-General", "due_date": "..."}
--   }
--
-- Rollback: DROP TABLE finance_reports_cache.

CREATE TABLE IF NOT EXISTS finance_reports_cache (
  id                TEXT PRIMARY KEY,
  state_code        TEXT NOT NULL,
  office_normalized TEXT NOT NULL,
  race_year         INTEGER NOT NULL,
  jurisdiction_name TEXT,
  status            TEXT NOT NULL,
  reports_json      TEXT,
  authority_json    TEXT,
  source            TEXT,
  last_updated      TEXT,
  created_at        TEXT DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_finance_cache_key
  ON finance_reports_cache(state_code, office_normalized, race_year, COALESCE(jurisdiction_name, ''));

CREATE INDEX IF NOT EXISTS idx_finance_cache_updated
  ON finance_reports_cache(last_updated DESC);
