-- Safe Mode activation log.
--
-- Built 2026-04-28 as the meta-fix on top of all per-fact-class
-- validators. When Sam's validators fire 3+ times in a single
-- conversation (regenerated + stripped events combined across
-- geographic, compliance A, compliance B finance, donation, and
-- opponent validators), Safe Mode activates: a banner appears
-- above Sam's responses warning the user, and a stricter deferral
-- prompt block is appended to Sam's system prompt.
--
-- Logging is idempotent per conversation_id — exactly ONE row per
-- conversation, recording the moment Safe Mode first activated.
-- The UNIQUE INDEX on conversation_id enforces this; the INSERT
-- in the chat handler is INSERT OR IGNORE.
--
-- trigger_count is the count at the START of the turn that
-- activated Safe Mode (the threshold-crossing turn). The current
-- turn's validator firings are NOT included in this count because
-- they haven't happened yet at the time the count is read.
--
-- triggering_validator_breakdown records which fact classes
-- contributed: {geographic: N, compliance_a: N, compliance_b: N,
-- donation: N, opponent: N} where N is the number of regen+strip
-- events per validator at the moment of activation.
--
-- Safe Mode is session-only. New conversation = fresh count =
-- no Safe Mode unless that conversation hits the threshold.
--
-- Rollback: DROP TABLE sam_safe_mode_events.

CREATE TABLE IF NOT EXISTS sam_safe_mode_events (
  id                              TEXT PRIMARY KEY,
  conversation_id                 TEXT NOT NULL,
  workspace_owner_id              TEXT,
  user_id                         TEXT,
  trigger_count                   INTEGER NOT NULL,
  activated_at                    TEXT DEFAULT (datetime('now')),
  triggering_validator_breakdown  TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_safe_mode_unique_conv
  ON sam_safe_mode_events(conversation_id);

CREATE INDEX IF NOT EXISTS idx_safe_mode_workspace
  ON sam_safe_mode_events(workspace_owner_id, activated_at DESC);
