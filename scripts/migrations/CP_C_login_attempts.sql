-- CP-C: Login rate limiting infrastructure.
--
-- Tracks every /api/auth/login attempt (owner + sub-user, merged endpoint).
-- Used by the 5-fail-in-15-min sliding-window lockout in the login handler.
--
-- username is stored lowercased + trimmed (same normalization the login
-- endpoint applies before lookup). success=1 means the password matched
-- (regardless of downstream status like 'revoked'); success=0 means wrong
-- password OR unknown username. Lockout counts success=0 rows only.
--
-- Future hardening (not in beta scope):
--   * Periodic cleanup: DELETE rows older than 30 days. Implement via
--     Cloudflare Cron Triggers when that infra is set up.
--   * Per-IP limiting layer: add columns for ip_address, and a second
--     check with a tighter threshold (e.g. 15 failures/hour from any IP
--     = IP block). Per-IP catches distributed username-guessing that
--     per-username limits miss.
--   * Per-username+IP combo: strictest — a single (username, IP) pair
--     hitting 3 failures locks that pair faster than per-username alone.

CREATE TABLE IF NOT EXISTS login_attempts (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  success INTEGER NOT NULL,
  attempted_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_login_attempts_username_time
  ON login_attempts(username, attempted_at);
