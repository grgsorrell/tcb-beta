-- Phase 1 (intel-redesign): voter_contact primitive. Purely additive — a new
-- table; no existing data is touched.
--
-- Scoping: user_id holds the WORKSPACE OWNER id (ctx.ownerId), matching the
-- profiles/budget one-row-per-workspace pattern, so the candidate and every
-- sub-user on the field team contribute to ONE campaign pace picture. One row
-- per (owner, date); UNIQUE(user_id, date) backs the additive ON CONFLICT
-- upsert used by both /api/voter-contact/log and the log_voter_contact tool.
--
-- Applied via:
--   wrangler d1 execute candidates-toolbox-db --remote --file migrations/004_voter_contact.sql

CREATE TABLE IF NOT EXISTS voter_contact (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT,
  date       TEXT,
  doors      INTEGER DEFAULT 0,
  calls      INTEGER DEFAULT 0,
  texts      INTEGER DEFAULT 0,
  created_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_voter_contact_user_date ON voter_contact(user_id, date);
