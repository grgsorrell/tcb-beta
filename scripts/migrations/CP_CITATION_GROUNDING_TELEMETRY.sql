-- CP_CITATION_GROUNDING_TELEMETRY.sql
-- 2026-05-09
--
-- Phase 2: grounding-aware citation validation telemetry.
--
-- Three-tier architecture:
--   Tier 1 (free): classifyClaimSourcing checks groundingMetadata
--   Tier 2 (paid): verifyClaimsAgainstGroundedSources audits cited URL content
--   Tier 3 (existing 1.5.A.1): verifyCitationAccuracy audits inline URLs in response
--
-- Per-row telemetry distinguishes which tier caught fabrications, plus
-- defensive counter for validator extraction drift.

ALTER TABLE sam_citation_validation_events ADD COLUMN grounding_used INTEGER DEFAULT 0;
ALTER TABLE sam_citation_validation_events ADD COLUMN sourced_claims_count INTEGER DEFAULT 0;
ALTER TABLE sam_citation_validation_events ADD COLUMN tier1_unsourced_count INTEGER DEFAULT 0;
ALTER TABLE sam_citation_validation_events ADD COLUMN tier2_demoted_count INTEGER DEFAULT 0;
ALTER TABLE sam_citation_validation_events ADD COLUMN tier3_caught_count INTEGER DEFAULT 0;
ALTER TABLE sam_citation_validation_events ADD COLUMN claims_not_found_in_response_count INTEGER DEFAULT 0;
ALTER TABLE sam_citation_validation_events ADD COLUMN grounding_supports_json TEXT;
