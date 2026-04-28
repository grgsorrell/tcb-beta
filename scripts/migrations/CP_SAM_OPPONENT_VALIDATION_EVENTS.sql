-- Per-event log of opponent-research firings: web_search gating +
-- post-generation opponent-fact validator.
--
-- Built 2026-04-28 to close the web_search re-identification gap
-- surfaced during Phase 1 entity-masking testing. Sam quoted real
-- $129,500 / $203,339.14 / "Action For Florida" PAC details about
-- the actual Florida candidate Mayra Uribe even with her name
-- masked to {{OPPONENT_1}}, because she web_searched on the
-- (still visible) office + jurisdiction. Masking the name in
-- prompt context doesn't prevent reconstruction via tool calls.
--
-- Three architectural layers, this table logs events from all of them:
--   1. Pre-call gate: when a user message looks like opponent
--      research, web_search is omitted from tools[] for that turn.
--      Action 'search_blocked' logged with the user's message.
--   2. Post-generation validator: extract opponent claims from
--      Sam's response, cross-check vs Intel / tool memory /
--      user-provided claims. action_taken in
--      {'passed', 'regenerated', 'stripped'}.
--   3. Combined for traffic that wasn't pre-blocked but had
--      drifted opponent claims regenerated.
--
-- Rollback: DROP TABLE sam_opponent_validation_events.

CREATE TABLE IF NOT EXISTS sam_opponent_validation_events (
  id                          TEXT PRIMARY KEY,
  conversation_id             TEXT,
  workspace_owner_id          TEXT,
  user_id                     TEXT,
  action_taken                TEXT NOT NULL,
  opponent_claims_detected    TEXT,
  unauthorized_claims         TEXT,
  blocked_search_query        TEXT,
  original_response_excerpt   TEXT,
  final_response_excerpt      TEXT,
  created_at                  TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_opponent_val_conv
  ON sam_opponent_validation_events(conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_opponent_val_workspace
  ON sam_opponent_validation_events(workspace_owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_opponent_val_action
  ON sam_opponent_validation_events(action_taken, created_at DESC);
