-- Beta-account rate-limit bypass log (dev infra)
--
-- Beta accounts (greg, shannan, cjc, jerry) bypass the 100/day chat
-- rate limit so iterative testing doesn't hit the cap mid-debug session.
-- The bypass IS audited — every time a beta account would have hit the
-- 100-cap and was waved through, we log a row here. call_count_today
-- captures the user's actual usage at the moment of bypass (so a beta
-- account at 100/day shows 100; at 250 shows 250).
--
-- Production accounts continue to receive 429 at 100/day. The bypass
-- is gated on username match against the BETA_USERNAMES allowlist in
-- worker.js — adding a new beta account requires both a code change
-- and acknowledgment of the bypass.
--
-- Rollback: DROP TABLE sam_rate_bypass_events.

CREATE TABLE IF NOT EXISTS sam_rate_bypass_events (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL,
  username          TEXT,
  call_count_today  INTEGER,
  created_at        TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_rate_bypass_user
  ON sam_rate_bypass_events(user_id, created_at DESC);
