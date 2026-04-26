-- Tool-result persistence across conversation turns.
--
-- Built 2026-04-26 to fix the multi-turn drift problem at its
-- root: the client only persists plain text in chatHistory, so
-- tool_use / tool_result blocks evaporate after each turn's
-- multi-round loop. Yesterday's jurisdiction-bug fix used a
-- jurisdiction-specific cache table workaround; this is the
-- generalized solution.
--
-- Lifecycle:
--   write — every turn, the chat handler scans incoming `messages`
--     for tool_use/tool_result pairs and inserts new rows
--     (deduplicated on tool_use_id within a conversation_id).
--   read  — every turn, the chat handler loads the 5 most recent
--     rows for this conversation_id and injects them into the
--     system prompt as RECENT TOOL RESULTS, between GROUND TRUTH
--     and RULES.
--   purge — when the user fires /new chat, the client posts to
--     /api/sam/conversation/reset with the old conversation_id
--     and DELETEs all matching rows before rotating to a new id.
--
-- Token budget: caller caps per-result at 2000 tokens (~8000
-- chars) and total injected memory at 8000 tokens. Truncation
-- happens at format time, not at write time, so the row keeps
-- the full result for forensic purposes.
--
-- Dedupe: the chat handler may see the same tool_use_id across
-- multiple requests (the client replays the multi-round
-- follow-up history). UNIQUE INDEX on (conversation_id,
-- tool_use_id) prevents duplicate rows.
--
-- Cleanup: orphan rows (from conversations that ended without
-- explicit /new chat) sit until manually swept. 30-day cron
-- planned but not in this checkpoint.
--
-- Rollback: DROP TABLE sam_tool_memory.

CREATE TABLE IF NOT EXISTS sam_tool_memory (
  id                  TEXT PRIMARY KEY,
  conversation_id     TEXT NOT NULL,
  workspace_owner_id  TEXT,
  tool_name           TEXT NOT NULL,
  tool_use_id         TEXT,
  parameters          TEXT,
  result              TEXT,
  created_at          TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sam_tool_memory_conversation_time
  ON sam_tool_memory(conversation_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_sam_tool_memory_workspace
  ON sam_tool_memory(workspace_owner_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sam_tool_memory_dedupe
  ON sam_tool_memory(conversation_id, tool_use_id);

-- Tag sam_turn_logs with conversation_id so the same key joins
-- both tables. Existing rows get NULL — acceptable for forensic
-- continuity (older turns predate the conversation_id concept).
ALTER TABLE sam_turn_logs ADD COLUMN conversation_id TEXT;

CREATE INDEX IF NOT EXISTS idx_sam_turn_logs_conversation_time
  ON sam_turn_logs(conversation_id, created_at DESC);
