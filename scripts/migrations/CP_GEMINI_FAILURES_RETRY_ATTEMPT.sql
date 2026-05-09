-- CP_GEMINI_FAILURES_RETRY_ATTEMPT.sql
-- 2026-05-08
--
-- Phase 1.5.B addition: track retry attempt number for Gemini production
-- failures. retry_attempt=1 = initial attempt failure; retry_attempt=2 =
-- retry attempt failure. Distinguishes transient blip-then-recovery turns
-- from persistent failure turns when reading per-day failure rates.
--
-- DEFAULT 1 covers existing rows (all from initial attempts pre-1.5.B).
-- Must apply BEFORE worker deploy — 1.5.B INSERT statement references
-- this column.

ALTER TABLE gemini_production_failures ADD COLUMN retry_attempt INTEGER DEFAULT 1;
