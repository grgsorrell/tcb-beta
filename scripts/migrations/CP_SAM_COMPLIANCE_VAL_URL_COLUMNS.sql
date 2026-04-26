-- Extend sam_compliance_validation_events for URL fabrication tracking.
--
-- B2 of the live tests caught Sam inventing "floridados.gov" when the
-- actual FL DOS site is dos.fl.gov — a URL fabrication of the same
-- bug class as date drift. The validator now also extracts URL-shaped
-- tokens from Sam's response and cross-checks against URLs returned
-- by the tool's authority object.
--
-- Three new columns:
--   sam_claimed_urls    — JSON array of every URL/domain Sam wrote
--   unauthorized_urls   — JSON subset that didn't match the lookup's
--                         authoritative URL set
--   fabrication_type    — 'date' | 'url' | 'both' | 'none', tags
--                         which class triggered the validator action
--                         (mostly for telemetry/dashboard queries)
--
-- Rollback: ALTER TABLE ... DROP COLUMN (D1 supports column drops as
-- of late 2025 SQLite version).

ALTER TABLE sam_compliance_validation_events ADD COLUMN sam_claimed_urls TEXT;
ALTER TABLE sam_compliance_validation_events ADD COLUMN unauthorized_urls TEXT;
ALTER TABLE sam_compliance_validation_events ADD COLUMN fabrication_type TEXT;
