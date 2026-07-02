-- Phase 5 of the sam-overhaul: per-turn reliability trace.
-- One row per main Sam chat turn on the live path, including error and blank
-- turns. validator_result holds the JSON-serialized _validatorFailOpens
-- accumulator (Phase 4) plus per-turn validator outcomes.
--
-- Applied to production D1 (candidates-toolbox-db) via:
--   wrangler d1 execute candidates-toolbox-db --remote --file migrations/001_sam_turn_trace.sql
--
-- The route='__alert__' sentinel rows double as the failure-alert rate-limit
-- state (last-alert timestamp), so no second table is needed.

CREATE TABLE IF NOT EXISTS sam_turn_trace (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        TEXT,
  ts             TEXT,
  route          TEXT,
  tools_called   TEXT,
  gemini_error   TEXT,
  was_blank      INTEGER,
  did_retry      INTEGER,
  validator_result TEXT,
  input_tokens   INTEGER,
  output_tokens  INTEGER,
  latency_ms     INTEGER
);

CREATE INDEX IF NOT EXISTS idx_sam_turn_trace_ts ON sam_turn_trace(ts);
CREATE INDEX IF NOT EXISTS idx_sam_turn_trace_error_ts ON sam_turn_trace(ts) WHERE gemini_error IS NOT NULL;
