-- Entity-mask table: workspace-scoped mapping from real names to
-- placeholder tokens, used to keep real-world entity names out of
-- every Anthropic API call.
--
-- Built 2026-04-28 to fix the Stephanie Murphy class of bug: when a
-- candidate's name happens to match a real-world public figure,
-- Haiku's training-data priors override Ground Truth and prompt
-- instructions. By replacing the name with {{CANDIDATE}} before any
-- LLM call, the model has no entity to pull biographical facts about.
--
-- Lookup keys:
--   (workspace_owner_id, entity_type, real_name) → placeholder       (write side; UNIQUE)
--   (workspace_owner_id, placeholder)            → real_name         (demask side)
--
-- Placeholder allocation:
--   CANDIDATE      → "{{CANDIDATE}}" (singleton per workspace)
--   CANDIDATE_FIRST→ "{{CANDIDATE_FIRST}}"
--   CANDIDATE_LAST → "{{CANDIDATE_LAST}}"
--   OPPONENT       → "{{OPPONENT_1}}", "{{OPPONENT_2}}", ...
--   ENDORSER       → "{{ENDORSER_1}}", ...
--   DONOR          → "{{DONOR_1}}", ...
--   STAFF          → "{{STAFF_1}}", ... (reserved; no app surface yet)
--
-- For the numbered types, the next number is COUNT(*) + 1 within
-- (workspace_owner_id, entity_type). Inserts use INSERT OR IGNORE so
-- backfill can run idempotently on every chat turn.
--
-- Cross-workspace isolation: all queries filter on workspace_owner_id.
-- Two workspaces sharing the same real name (e.g., both with
-- "Greg Sorrell" candidates) get independent rows.
--
-- Storage: append-only this checkpoint. Cleanup/archival deferred.
--
-- Rollback: DROP TABLE entity_mask.

CREATE TABLE IF NOT EXISTS entity_mask (
  id                  TEXT PRIMARY KEY,
  workspace_owner_id  TEXT NOT NULL,
  entity_type         TEXT NOT NULL,
  real_name           TEXT NOT NULL,
  placeholder         TEXT NOT NULL,
  first_seen_at       TEXT DEFAULT (datetime('now')),
  created_at          TEXT DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_entity_mask_unique
  ON entity_mask(workspace_owner_id, entity_type, real_name);

-- Defensive UNIQUE on (workspace, placeholder) too: prevents the rare
-- concurrent-allocation race where two simultaneous backfills for the
-- same workspace + type compute the same numbered placeholder. With
-- this constraint, the second INSERT OR IGNORE silently no-ops on
-- collision; the unmatched name re-tries on the next chat turn and
-- gets the next available number.
CREATE UNIQUE INDEX IF NOT EXISTS idx_entity_mask_placeholder_unique
  ON entity_mask(workspace_owner_id, placeholder);

CREATE INDEX IF NOT EXISTS idx_entity_mask_workspace_type
  ON entity_mask(workspace_owner_id, entity_type, created_at);
