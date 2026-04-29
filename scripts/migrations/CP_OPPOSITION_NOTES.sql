-- Opposition Notes (Intel UI Phase 1)
--
-- User-editable structured intel layer added 2026-04-29. Backs Intel
-- Tab 4 (Opposition Notes). Each row is a free-text notes blob the
-- candidate writes about a specific opponent — fundraising rumors,
-- endorsement chatter, vulnerabilities, donor info, on-the-ground intel.
-- Auto-research can't capture this; user notes can.
--
-- Linkage: opponent_name (NOT opponent_id) is the join key. Rationale:
-- Sam's chat handler receives intelContext.opponents keyed by name; using
-- name as the lookup avoids carrying opponent.id through the chat path.
-- One side effect: renaming an opponent in Tab 1 would orphan their notes
-- here — acceptable because Tab 1 doesn't currently support rename.
--
-- UNIQUE constraint enforces one notes row per (workspace_owner_id,
-- opponent_name). save endpoint uses INSERT ... ON CONFLICT(...) DO UPDATE
-- to upsert.
--
-- Cascade: removing an opponent from Tab 1 must clean up notes here. Both
-- sides cooperate — frontend explicit DELETE call from removeOpponent,
-- server-side cascade inside /api/opponents/remove (look up name, delete
-- notes by (workspace_owner_id, name)).
--
-- 2,000 char application-level cap on notes (enforced client-side before
-- save and at the save endpoint). Stored as TEXT — no DB-level cap.
--
-- Rollback: DROP TABLE opposition_notes.

CREATE TABLE IF NOT EXISTS opposition_notes (
  id                  TEXT PRIMARY KEY,
  workspace_owner_id  TEXT NOT NULL,
  opponent_name       TEXT NOT NULL,
  notes               TEXT,
  created_at          TEXT DEFAULT (datetime('now')),
  updated_at          TEXT DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_opposition_notes_unique
  ON opposition_notes(workspace_owner_id, opponent_name);

CREATE INDEX IF NOT EXISTS idx_opposition_notes_workspace
  ON opposition_notes(workspace_owner_id, updated_at DESC);
