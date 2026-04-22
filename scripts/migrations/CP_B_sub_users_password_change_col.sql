-- CP-B schema: add last_password_change_at audit column to sub_users.
--
-- Populated by /api/auth/change-password on successful password change.
-- Nullable — existing rows stay NULL until their first password change.
-- Used for audit ("when did Shannan last rotate her password?"); no
-- application logic depends on it (e.g. no forced-rotation timer today).
--
-- Rollback: ALTER TABLE sub_users DROP COLUMN last_password_change_at.

ALTER TABLE sub_users ADD COLUMN last_password_change_at TEXT;
