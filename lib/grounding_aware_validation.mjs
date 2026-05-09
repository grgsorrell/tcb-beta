/**
 * Phase 2 — grounding-aware citation validation.
 *
 * Tier 1 (this module): metadata-only classification. classifyClaimSourcing
 * checks whether a high_stakes claim is backed by Gemini's groundingSupports
 * via two-stage check (position overlap + content sanity).
 *
 * Tier 2 (worker.js verifyClaimsAgainstGroundedSources): for Tier-1-sourced
 * claims, fetches grounded chunk URLs and audits whether source content
 * actually supports the claim. Catches "hallucinated support" — Gemini
 * metadata says claim is sourced when source doesn't back it.
 *
 * Tier 3 (worker.js verifyCitationAccuracy, Phase 1.5.A.1): runs on final
 * post-validation text, audits inline URLs Sam wrote. Catches Ballotpedia-
 * style fake-cite pattern.
 *
 * Drift detector: tests/grounding_aware_validation.test.mjs.
 */

export function classifyClaimSourcing(claim, responseText, groundingSupports) {
  // Returns one of:
  //   { sourced: true,  via: 'specifics_matched', chunkIndices: [...] }
  //   { sourced: true,  via: 'vacuous_overlap',   chunkIndices: [...] }
  //   { sourced: false, reason: 'no_grounding' }
  //   { sourced: false, reason: 'claim_not_found' }
  //   { sourced: false, reason: 'no_overlap' }
  //   { sourced: false, reason: 'content_mismatch' }
  if (!claim || typeof claim !== 'string') return { sourced: false, reason: 'no_grounding' };
  if (!responseText || typeof responseText !== 'string') return { sourced: false, reason: 'no_grounding' };
  if (!Array.isArray(groundingSupports) || groundingSupports.length === 0) {
    return { sourced: false, reason: 'no_grounding' };
  }

  const claimLower = claim.toLowerCase();
  const textLower = responseText.toLowerCase();
  const claimPositions = [];
  let searchStart = 0;
  while (searchStart < textLower.length) {
    const idx = textLower.indexOf(claimLower, searchStart);
    if (idx === -1) break;
    claimPositions.push({ start: idx, end: idx + claim.length });
    searchStart = idx + 1;
  }
  if (claimPositions.length === 0) {
    return { sourced: false, reason: 'claim_not_found' };
  }

  let positionOverlapFound = false;
  for (const claimPos of claimPositions) {
    for (const sup of groundingSupports) {
      const range = resolveSupportRange(sup, responseText);
      if (!range) continue;
      const overlap = Math.max(claimPos.start, range.start) < Math.min(claimPos.end, range.end);
      if (!overlap) continue;
      positionOverlapFound = true;

      const contentResult = supportTextContainsClaimSpecifics(sup.text || '', claim);
      if (contentResult.matched) {
        return {
          sourced: true,
          via: contentResult.viaSpecifics ? 'specifics_matched' : 'vacuous_overlap',
          chunkIndices: Array.isArray(sup.chunkIndices) ? sup.chunkIndices.slice() : []
        };
      }
    }
  }

  if (positionOverlapFound) return { sourced: false, reason: 'content_mismatch' };
  return { sourced: false, reason: 'no_overlap' };
}

// Phase 2.1 fix: resolve a support segment's [start, end] range in the
// response text. Handles Gemini API serialization quirks:
//   - startIndex omitted when value is 0 (common JSON serializer behavior:
//     drop zero-defaults). The Tier 1 bug from greg's 2026-05-09 spot test:
//     a correct grounded claim was rejected because startIndex was null
//     while endIndex was 133, so the strict `typeof === 'number'` check
//     skipped the support entirely.
//   - endIndex occasionally missing too — default to start + text.length.
//
// Two-stage resolution:
//   Stage 1 — defaults: missing startIndex → 0; missing endIndex → start + text.length
//   Stage 2 — text-matching fallback: if defaults still don't yield a
//             usable range (e.g., both indices missing), look up sup.text
//             as a substring in responseText. Catches the case where
//             Gemini's offsets are wrong but the segment text is preserved.
//             Requires text >= 10 chars to avoid noise from short segments
//             matching by coincidence.
//
// Returns { start, end } or null if range can't be determined.
function resolveSupportRange(sup, responseText) {
  if (!sup || typeof sup !== 'object') return null;
  let start = (typeof sup.startIndex === 'number') ? sup.startIndex : null;
  let end = (typeof sup.endIndex === 'number') ? sup.endIndex : null;
  const text = (typeof sup.text === 'string') ? sup.text : '';

  if (start === null && end !== null) start = 0;
  if (end === null && start !== null && text.length > 0) end = start + text.length;

  if (start !== null && end !== null && end > start) {
    return { start, end };
  }

  if (text.length >= 10 && responseText) {
    const lower = responseText.toLowerCase();
    const idx = lower.indexOf(text.toLowerCase());
    if (idx >= 0) {
      return { start: idx, end: idx + text.length };
    }
  }

  return null;
}

function supportTextContainsClaimSpecifics(supportText, claim) {
  const supportLower = supportText.toLowerCase();
  let extractedSpecifics = 0;

  const dateRe = /\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2},?\s+\d{4}\b/gi;
  const claimDates = (claim.match(dateRe) || []).map(d => d.toLowerCase());
  for (const d of claimDates) {
    extractedSpecifics++;
    if (!supportLower.includes(d)) return { matched: false, viaSpecifics: true };
  }

  const dollarRe = /\$[\d,]+(?:\.\d+)?/g;
  const claimDollars = claim.match(dollarRe) || [];
  for (const dol of claimDollars) {
    extractedSpecifics++;
    if (!supportText.includes(dol)) return { matched: false, viaSpecifics: true };
  }

  const phoneRe = /\b\d{3}-\d{3}-\d{4}\b/g;
  const claimPhones = claim.match(phoneRe) || [];
  for (const phone of claimPhones) {
    extractedSpecifics++;
    if (!supportText.includes(phone)) return { matched: false, viaSpecifics: true };
  }

  return {
    matched: true,
    viaSpecifics: extractedSpecifics > 0
  };
}

/**
 * Per-classifier-category temperature for Gemini calls. Lower temp on
 * fact-bearing categories minimizes parametric-memory leak (creative
 * gap-filling Pro flagged). Strategic kept at 0.4 for messaging variation;
 * conversational at 0.6 for natural warmth.
 */
export function temperatureForCategory(category) {
  if (category === 'compliance' || category === 'factual') return 0.0;
  if (category === 'predictive') return 0.1;
  if (category === 'conversational') return 0.6;
  return 0.4; // strategic + default
}
