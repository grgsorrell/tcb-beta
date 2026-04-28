-- Backfill: add conversation_id to sam_validation_events.
--
-- The geographic validator's events table predates the conversation_id
-- concept (added during the sam_tool_memory checkpoint) and never got
-- the column. Phase 3's Safe Mode firing-counter query selects across
-- all 5 validator tables filtered by conversation_id; with this column
-- missing on sam_validation_events, geographic firings were silently
-- excluded from the count.
--
-- ALTER TABLE adds the column with NULL default for existing rows.
-- Future geographic firings will populate it. The Phase 3 count query
-- works against the schema after this migration; legacy rows with
-- conversation_id IS NULL won't match any conversation_id filter,
-- which is correct behavior (we shouldn't retroactively attribute
-- pre-Phase-3 firings to current conversations).
--
-- Rollback: ALTER TABLE sam_validation_events DROP COLUMN conversation_id.

ALTER TABLE sam_validation_events ADD COLUMN conversation_id TEXT;

CREATE INDEX IF NOT EXISTS idx_sam_validation_events_conv
  ON sam_validation_events(conversation_id, created_at DESC);
