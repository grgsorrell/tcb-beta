-- CP_SHADOW_GEMINI_LOG.sql
-- 2026-05-07
--
-- Shadow-test phase for Gemini 2.5 Flash migration. Each Sam turn for users
-- in SHADOW_GEMINI_USER_IDS allowlist (greg + shannan only initially)
-- triggers a fire-and-forget Gemini call after Haiku-Sam responds. Gemini's
-- response is logged here alongside Haiku's for side-by-side review.
-- Validators (already on Haiku) audit BOTH outputs independently;
-- pass/fail results captured per row for Haiku and Gemini separately.
--
-- Manual review by Greg + Shannan after 3-5 days of accumulation informs
-- the full-migration decision.
--
-- PRIVACY: this table contains raw user messages. Per beta scope this is
-- acceptable, but post-migration-decision the table should be either
-- dropped or have a retention policy applied. Tracked in memory file
-- tcb_shadow_gemini_log_privacy.md — Greg's calendar reminder.
--
-- Lifecycle: shadow phase only. After full migration decision, this table
-- becomes a historical record. No TTL applied at the database level —
-- manual cleanup post-decision.

CREATE TABLE shadow_gemini_log (
  id                          TEXT PRIMARY KEY,
  conversation_id             TEXT,
  user_id                     TEXT,
  workspace_owner_id          TEXT,
  turn_index                  INTEGER,
  created_at                  TEXT DEFAULT (datetime('now')),

  -- Inputs (same context Haiku saw)
  user_message                TEXT,
  classifier_category         TEXT,

  -- Side-by-side outputs
  haiku_response              TEXT,
  haiku_latency_ms            INTEGER,
  haiku_validator_results     TEXT,           -- JSON: {"passes": [...], "failures": [...]}

  gemini_response             TEXT,           -- nullable on error
  gemini_latency_ms           INTEGER,
  gemini_input_tokens         INTEGER,
  gemini_output_tokens        INTEGER,
  gemini_grounding_used       INTEGER,        -- count of grounding invocations (not boolean)
  gemini_grounding_urls       TEXT,           -- JSON array of cited URLs from grounding metadata
  gemini_error                TEXT,           -- non-null if call failed; describes failure mode

  -- Validator audit results (Haiku validators run on Gemini output)
  -- Read-only audit — no regen, no strip side effects.
  validator_audit_passes      TEXT,           -- JSON: ["citation","geographic",...]
  validator_audit_failures    TEXT            -- JSON: [{"validator":"citation","claims":[...],"action_would_be":"stripped"}]
);

CREATE INDEX idx_shadow_gemini_user_time
  ON shadow_gemini_log(user_id, created_at DESC);

CREATE INDEX idx_shadow_gemini_convo
  ON shadow_gemini_log(conversation_id, turn_index);
