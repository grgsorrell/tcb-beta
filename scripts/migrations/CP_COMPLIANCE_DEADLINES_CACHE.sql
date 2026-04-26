-- Compliance deadlines cache.
--
-- Caches the result of lookup_compliance_deadlines tool calls so a
-- given race profile only burns external lookups once per cache TTL.
-- Cache key: (state_code, office_normalized, race_year, jurisdiction_name).
--
-- Status field semantics (matches tool API):
--   'found'       — verified deadlines from authoritative source
--   'partial'     — some deadlines known, others NULL
--   'unsupported' — no deadline data; authority contact still populated
--
-- Authority fields are ALWAYS populated, even for unsupported lookups,
-- so Sam can always defer with a contact instead of inventing dates.
-- This is the deferral-as-feature principle.
--
-- Source priority (when populating): Ballotpedia → state SOS → fall
-- through to authority-only stub. This checkpoint stubs Ballotpedia
-- and SOS paths; all lookups currently produce status='unsupported'.
--
-- TTL: 90 days (filing deadlines are stable within a race year).
-- Refresh by deletion if a user reports stale data.
--
-- Rollback: DROP TABLE compliance_deadlines_cache.

CREATE TABLE IF NOT EXISTS compliance_deadlines_cache (
  id                              TEXT PRIMARY KEY,
  state_code                      TEXT NOT NULL,
  office_normalized               TEXT NOT NULL,
  race_year                       INTEGER NOT NULL,
  jurisdiction_name               TEXT,
  status                          TEXT NOT NULL,
  qualifying_period_start         TEXT,
  qualifying_period_end           TEXT,
  qualifying_period_end_time      TEXT,
  petition_deadline               TEXT,
  filing_fee                      TEXT,
  authority_name                  TEXT,
  authority_phone                 TEXT,
  authority_url                   TEXT,
  authority_notes                 TEXT,
  authority_jurisdiction_specific TEXT,
  source                          TEXT,
  last_updated                    TEXT,
  created_at                      TEXT DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_compliance_deadlines_lookup
  ON compliance_deadlines_cache(state_code, office_normalized, race_year, jurisdiction_name);

CREATE INDEX IF NOT EXISTS idx_compliance_deadlines_status
  ON compliance_deadlines_cache(status, created_at DESC);
