-- CP_FL_AUTHORITY_BACKFILL.sql
-- 2026-05-06
--
-- Backfill the FL row in compliance_authorities with real authority contact
-- info (URL, phone, mailing address). The seed row was a stub with placeholder
-- phone "(verify on state government website)" and null URL — that placeholder
-- combination broke Sam's deferral path when the helper bailed with
-- NO_USABLE_CONTENT, because the Phase 4 prompt's deferral sample
-- ("Contact [authority.name] at [authority.phone]") rendered as awkward,
-- non-actionable text. Sam compensated by recalling real URL/phone from
-- training data, which the citation validator then stripped, leaving the
-- response incoherent. See tcb_compliance_websearch_fallback_decision.md
-- for the full investigation thread.
--
-- This is Bug 1 fix from the 2026-05-06 verification — the simplest
-- of three coordinated fixes (Bug 1 = authority backfill, Bug 2 = Sam
-- citation form prompt tightening, Bug 3 = helper-Haiku verbatim
-- enforcement via few-shot examples). Phases 3 + 5 ship the prompt-side
-- fixes after Phase 2 verification of this backfill.
--
-- Scope: Florida only. Broader state-by-state backfill (all 50) is a
-- separate workstream — not blocking beta if FL works. Investor demo
-- 2026-05-07 uses Stephanie Murphy / FL HD 39 profile, so FL is the
-- only critical state for the demo.

UPDATE compliance_authorities
SET
  authority_phone = '850-245-6200',
  authority_url   = 'https://dos.fl.gov/elections/candidates-committees/qualifying/',
  notes           = 'Florida candidate filing/qualifying authority. Mailing: R.A. Gray Building, 500 S. Bronough Street, Tallahassee, FL 32399-0250.'
WHERE state_code = 'FL'
  AND jurisdiction_type = 'state';

-- Cache invalidation: existing compliance/finance/donation cache rows for
-- FL State House 2026 were written with the stub authority data baked in.
-- Delete them so the next lookup picks up the new authority info.
-- (TTL alone won't suffice — these rows are <14 days old.)

DELETE FROM compliance_deadlines_cache
  WHERE state_code = 'FL' AND office_normalized = 'state house' AND race_year = 2026;

DELETE FROM finance_reports_cache
  WHERE state_code = 'FL' AND office_normalized = 'state house' AND race_year = 2026;

DELETE FROM donation_limits_cache
  WHERE state_code = 'FL' AND office_normalized = 'state house' AND race_year = 2026;
