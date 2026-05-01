-- Sam v2 Phase 5 — Question classifier event log.
--
-- Logs every classification call. Classifier runs at start of each chat
-- turn, classifies the user's latest message into one of five categories
-- (factual / strategic / compliance / predictive / conversational), and
-- the result drives prompt assembly + tool availability + validator gating.
--
-- Columns:
--   user_message_excerpt  — first 200 chars of user message (debug)
--   classified_category   — the category returned by audit-Haiku
--   classifier_failed     — 1 if Haiku call errored or returned an
--                           unexpected value (fallback to 'factual' was used)
--
-- Rollback: DROP TABLE sam_classification_events.

CREATE TABLE IF NOT EXISTS sam_classification_events (
  id                    TEXT PRIMARY KEY,
  conversation_id       TEXT,
  workspace_owner_id    TEXT,
  user_id               TEXT,
  user_message_excerpt  TEXT,
  classified_category   TEXT NOT NULL,
  classifier_failed     INTEGER DEFAULT 0,
  created_at            TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_classification_conv
  ON sam_classification_events(conversation_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_classification_workspace
  ON sam_classification_events(workspace_owner_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_classification_category
  ON sam_classification_events(classified_category, created_at DESC);
