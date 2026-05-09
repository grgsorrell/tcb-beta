-- CP_USERS_SAM_ENGINE.sql
-- 2026-05-08
--
-- Per-user routing flag for the Sam-on-Gemini migration. Worker reads
-- this column on every chat request to decide whether to route the turn
-- through callClaudeAndDemask (Haiku) or runProductionGeminiTurn
-- (Gemini 2.5 Flash with Search Grounding).
--
-- Default 'haiku' so existing users continue on the prior brain
-- unchanged. Phase 1 spot test flips greg.sam_engine = 'gemini' to
-- exercise the Gemini path. Phase 3 flips greg + shannan together.
-- Phase 4 flips cjc + jerry.
--
-- Rollback per-user (no redeploy): UPDATE users SET sam_engine = 'haiku' WHERE id = ?
--
-- Defensive value handling in worker code: anything other than literal
-- string 'gemini' falls back to Haiku path. So a typo, NULL, or unknown
-- value never accidentally routes to a broken path.

ALTER TABLE users ADD COLUMN sam_engine TEXT DEFAULT 'haiku';

-- Index for the per-request lookup. Beta-scale users table is small
-- enough that a scan would be fine, but the index removes any future
-- worry as users grows.

CREATE INDEX IF NOT EXISTS idx_users_sam_engine ON users(sam_engine);
