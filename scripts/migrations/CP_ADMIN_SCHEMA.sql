-- CP_ADMIN_SCHEMA — admin dashboard MVP
-- 2026-05-02
--
-- Adds is_admin / is_disabled flags to users, plus admin_audit_log
-- table for recording admin actions (disable/enable account).
--
-- After applying this migration, set Greg's row manually:
--   wrangler d1 execute candidates-toolbox-db --remote --command \
--     "UPDATE users SET is_admin = 1 WHERE id = 'XQCxgGyUVCPc3M1z2tFHKZ7kVDieGfO7'"

ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN is_disabled INTEGER DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_users_is_admin ON users(is_admin);
CREATE INDEX IF NOT EXISTS idx_users_is_disabled ON users(is_disabled);

CREATE TABLE IF NOT EXISTS admin_audit_log (
  id TEXT PRIMARY KEY,
  admin_user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_user_id TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_admin
  ON admin_audit_log(admin_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_target
  ON admin_audit_log(target_user_id, created_at DESC);
