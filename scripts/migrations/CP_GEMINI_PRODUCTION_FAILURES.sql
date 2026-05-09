-- CP_GEMINI_PRODUCTION_FAILURES.sql
-- 2026-05-08
--
-- Failure log for the Gemini production path. Whenever
-- runProductionGeminiTurn falls back to Haiku (due to timeout, rate
-- limit, auth error, 5xx, malformed response, or unhandled exception),
-- the failure is logged here. Read by manual queries during Phase 1-4
-- to spot trends; alert if rate exceeds ~1% over any 1-hour window.
--
-- Decoupled from sam_turn_logs because the failure may happen before
-- a turn fully completes (Haiku fallback path takes over and produces
-- the user-facing response). This table is failure-specific telemetry.
--
-- Cleanup: rows accumulate; manual sweep or future cron when the table
-- grows. Cheap to keep — text-only, ~500 bytes/row average.
--
-- Rollback: DROP TABLE gemini_production_failures.

CREATE TABLE IF NOT EXISTS gemini_production_failures (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT,
  workspace_owner_id  TEXT,
  conversation_id     TEXT,
  created_at          TEXT DEFAULT (datetime('now')),

  -- Failure classification. One of:
  --   'timeout'      — geminiCallSam's 15s AbortSignal fired
  --   'rate_limit'   — HTTP 429 from Google
  --   'auth'         — HTTP 401/403 (missing/invalid API key)
  --   '5xx'          — HTTP 5xx (Google upstream)
  --   'malformed'    — response parsed but no candidates/text/usage
  --   'unhandled'    — outer try/catch caught an unexpected exception
  failure_mode        TEXT,

  status_code         INTEGER,    -- HTTP status if applicable, NULL otherwise
  error_message       TEXT        -- truncated 500 chars for triage
);

CREATE INDEX IF NOT EXISTS idx_gemini_failures_time
  ON gemini_production_failures(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_gemini_failures_user_time
  ON gemini_production_failures(user_id, created_at DESC);
