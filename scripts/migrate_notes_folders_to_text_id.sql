-- Migrate notes and folders from INTEGER PRIMARY KEY to TEXT PRIMARY KEY.
-- The other workspace tables (tasks, events, endorsements, contributions) are
-- already TEXT PRIMARY KEY; this brings notes/folders in line and eliminates
-- the "Sam float-id rejected by INTEGER PRIMARY KEY" failure class.
--
-- Worker code is already TEXT-ready (every bind is wrapped in String()).
-- No worker changes needed.
--
-- Drop foreign key declarations during the migration. D1 / Cloudflare SQLite
-- doesn't enforce FKs at the row level by default, but it DOES enforce them
-- on DROP TABLE (can't drop a parent while children still reference it).
-- Turn off FK checks for the duration of the migration, then back on.

PRAGMA foreign_keys = OFF;

-- ---------- FOLDERS ----------
CREATE TABLE folders_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  campaign_id TEXT,
  workspace_owner_id TEXT
);

INSERT INTO folders_new (id, user_id, name, created_at, campaign_id, workspace_owner_id)
SELECT CAST(id AS TEXT), user_id, name, created_at, campaign_id, workspace_owner_id
FROM folders;

DROP TABLE folders;
ALTER TABLE folders_new RENAME TO folders;

-- ---------- NOTES ----------
CREATE TABLE notes_new (
  id TEXT PRIMARY KEY,
  folder_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  title TEXT,
  content TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  campaign_id TEXT,
  workspace_owner_id TEXT
);

INSERT INTO notes_new (id, folder_id, user_id, title, content, created_at, updated_at, campaign_id, workspace_owner_id)
SELECT CAST(id AS TEXT), CAST(folder_id AS TEXT), user_id, title, content, created_at, updated_at, campaign_id, workspace_owner_id
FROM notes;

DROP TABLE notes;
ALTER TABLE notes_new RENAME TO notes;

PRAGMA foreign_keys = ON;
