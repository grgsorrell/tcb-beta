// grounding_aware_validation.test.mjs
//
// Drift detector for classifyClaimSourcing + temperatureForCategory.
// Run as:
//   node tests/grounding_aware_validation.test.mjs
//
// Wired as Phase 2 pre-deploy gate alongside strip_tool_references and
// verify_citation_url_extraction tests.

import { classifyClaimSourcing, temperatureForCategory } from '../lib/grounding_aware_validation.mjs';

let passed = 0;
let failures = 0;

function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
  } else {
    failures++;
    console.error(`  FAIL: ${label}\n    expected: ${e}\n    actual:   ${a}`);
  }
}

// ===== classifyClaimSourcing =====

// 1. Sourced via specifics matched
{
  const response = 'Qualifying for State House opens June 8, 2026 (per dos.fl.gov).';
  const claim = 'Qualifying for State House opens June 8, 2026';
  const supports = [{
    text: 'Qualifying for State House opens June 8, 2026 (per dos.fl.gov)',
    startIndex: 0,
    endIndex: response.length,
    chunkIndices: [0]
  }];
  assertEq(
    classifyClaimSourcing(claim, response, supports),
    { sourced: true, via: 'specifics_matched', chunkIndices: [0] },
    'sourced via specifics_matched (date match)'
  );
}

// 2. No position overlap (different sentence, support nowhere near claim)
{
  const response = 'Petition deadline: May 11, 2026. Qualifying opens May 11, 2026.';
  const claim = 'Qualifying opens May 11, 2026';
  const claimStart = response.indexOf(claim);
  const supports = [{
    text: 'Petition deadline: May 11, 2026',
    startIndex: 0,
    endIndex: 31,
    chunkIndices: [0]
  }];
  // Claim is at position 33+, support is 0-31, no overlap
  assertEq(
    classifyClaimSourcing(claim, response, supports),
    { sourced: false, reason: 'no_overlap' },
    'no overlap — different sentence'
  );
}

// 3. Position overlap but content mismatch (different date in support)
{
  const response = 'Qualifying opens May 11, 2026 per dos.fl.gov.';
  const claim = 'Qualifying opens May 11, 2026';
  const supports = [{
    text: 'Qualifying opens June 8, 2026 per dos.fl.gov',
    startIndex: 0,
    endIndex: response.length,
    chunkIndices: [0]
  }];
  assertEq(
    classifyClaimSourcing(claim, response, supports),
    { sourced: false, reason: 'content_mismatch' },
    'position overlap but support text has different date'
  );
}

// 4. Sourced via vacuous overlap (claim has no extractable specifics)
{
  const response = 'The Florida Division of Elections handles state filings.';
  const claim = 'The Florida Division of Elections';
  const supports = [{
    text: 'The Florida Division of Elections handles state filings',
    startIndex: 0,
    endIndex: response.length,
    chunkIndices: [2]
  }];
  assertEq(
    classifyClaimSourcing(claim, response, supports),
    { sourced: true, via: 'vacuous_overlap', chunkIndices: [2] },
    'vacuous overlap — no specifics in claim'
  );
}

// 5. Grounding fired but no supports cover this claim
{
  const response = 'X is true. Y is also true.';
  const claim = 'Y is also true';
  const supports = [{
    text: 'X is true.',
    startIndex: 0,
    endIndex: 10,
    chunkIndices: [0]
  }];
  assertEq(
    classifyClaimSourcing(claim, response, supports),
    { sourced: false, reason: 'no_overlap' },
    'grounding fired, no support overlaps this specific claim'
  );
}

// 6. No grounding at all (empty supports array)
assertEq(
  classifyClaimSourcing('any claim', 'any response', []),
  { sourced: false, reason: 'no_grounding' },
  'empty supports array'
);

// 7. Haiku turn — supports field is undefined (not propagated)
assertEq(
  classifyClaimSourcing('claim', 'response', undefined),
  { sourced: false, reason: 'no_grounding' },
  'Haiku turn — undefined supports'
);

// 8. Empty/null inputs
assertEq(
  classifyClaimSourcing(null, 'response', [{ startIndex: 0, endIndex: 1, text: 'x', chunkIndices: [0] }]),
  { sourced: false, reason: 'no_grounding' },
  'null claim'
);
assertEq(
  classifyClaimSourcing('claim', null, [{ startIndex: 0, endIndex: 1, text: 'x', chunkIndices: [0] }]),
  { sourced: false, reason: 'no_grounding' },
  'null responseText'
);
assertEq(
  classifyClaimSourcing('', 'response', [{ startIndex: 0, endIndex: 1, text: 'x', chunkIndices: [0] }]),
  { sourced: false, reason: 'no_grounding' },
  'empty string claim'
);

// 9. Claim not found verbatim in response
{
  const response = 'Per dos.fl.gov, qualifying opens June 8.';
  const claim = 'Qualifying period begins June 8'; // paraphrase, not in response
  const supports = [{
    text: 'Per dos.fl.gov, qualifying opens June 8.',
    startIndex: 0,
    endIndex: response.length,
    chunkIndices: [0]
  }];
  assertEq(
    classifyClaimSourcing(claim, response, supports),
    { sourced: false, reason: 'claim_not_found' },
    'claim text not in response (paraphrased)'
  );
}

// 10. Malformed support entries (missing startIndex/endIndex) skipped
{
  const response = 'Qualifying opens June 8, 2026 (per dos.fl.gov).';
  const claim = 'Qualifying opens June 8, 2026';
  const supports = [
    { text: 'malformed', chunkIndices: [0] }, // missing indices
    { startIndex: 0, endIndex: response.length, text: 'Qualifying opens June 8, 2026 (per dos.fl.gov)', chunkIndices: [1] }
  ];
  assertEq(
    classifyClaimSourcing(claim, response, supports),
    { sourced: true, via: 'specifics_matched', chunkIndices: [1] },
    'malformed entry skipped, valid entry succeeds'
  );
}

// 11. Phone number specifics — match
{
  const response = 'Contact 850-245-6200 for FL DoE.';
  const claim = 'Contact 850-245-6200';
  const supports = [{
    text: 'Contact 850-245-6200 for FL DoE',
    startIndex: 0,
    endIndex: response.length,
    chunkIndices: [0]
  }];
  assertEq(
    classifyClaimSourcing(claim, response, supports),
    { sourced: true, via: 'specifics_matched', chunkIndices: [0] },
    'phone number specifics match'
  );
}

// 12. Dollar amount specifics — mismatch
{
  const response = 'Filing fee is $1,500 per FL DoE.';
  const claim = 'Filing fee is $1,500';
  const supports = [{
    text: 'Filing fee is $1,781.82 per FL DoE',
    startIndex: 0,
    endIndex: response.length,
    chunkIndices: [0]
  }];
  assertEq(
    classifyClaimSourcing(claim, response, supports),
    { sourced: false, reason: 'content_mismatch' },
    'dollar amount mismatch — wrong amount in support'
  );
}

// 13. Multiple chunkIndices propagate through
{
  const response = 'Qualifying opens June 8, 2026.';
  const claim = 'Qualifying opens June 8, 2026';
  const supports = [{
    text: 'Qualifying opens June 8, 2026',
    startIndex: 0,
    endIndex: response.length,
    chunkIndices: [0, 1, 3]
  }];
  assertEq(
    classifyClaimSourcing(claim, response, supports),
    { sourced: true, via: 'specifics_matched', chunkIndices: [0, 1, 3] },
    'multi-chunk indices propagate'
  );
}

// ===== Phase 2.1 — resolveSupportRange tests =====

// 14. startIndex null (Gemini omitted-zero serialization), endIndex set
{
  const response = 'Qualifying for State Representative in Florida opens at Noon on Monday, June 8, 2026, and closes at Noon on Friday, June 12, 2026.';
  const claim = 'Qualifying for State Representative in Florida opens at Noon on Monday, June 8, 2026';
  const supports = [{
    text: 'Qualifying for State Representative in Florida opens at Noon on Monday, June 8, 2026',
    startIndex: null,
    endIndex: 84,
    chunkIndices: [0, 1, 2]
  }];
  assertEq(
    classifyClaimSourcing(claim, response, supports),
    { sourced: true, via: 'specifics_matched', chunkIndices: [0, 1, 2] },
    'Phase 2.1: startIndex=null defaults to 0 when endIndex present (the actual production bug)'
  );
}

// 15. Both indices null but text-match recoverable
{
  const response = 'For State House, qualifying opens June 8, 2026 (per dos.fl.gov).';
  const claim = 'qualifying opens June 8, 2026';
  const supports = [{
    text: 'qualifying opens June 8, 2026',
    startIndex: null,
    endIndex: null,
    chunkIndices: [0]
  }];
  assertEq(
    classifyClaimSourcing(claim, response, supports),
    { sourced: true, via: 'specifics_matched', chunkIndices: [0] },
    'Phase 2.1: both indices null, text-match fallback locates segment'
  );
}

// 16. Both indices null, text NOT in response
{
  const response = 'For State House, qualifying opens June 8, 2026.';
  const claim = 'qualifying opens June 8, 2026';
  const supports = [{
    text: 'an entirely different sentence not in the response',
    startIndex: null,
    endIndex: null,
    chunkIndices: [0]
  }];
  assertEq(
    classifyClaimSourcing(claim, response, supports),
    { sourced: false, reason: 'no_overlap' },
    'Phase 2.1: both indices null, text not in response — unresolvable support skipped, loop exits with no overlap'
  );
}

// 17. endIndex null, startIndex present: default end via text length
{
  const response = 'Per dos.fl.gov, qualifying opens June 8, 2026.';
  const claim = 'qualifying opens June 8, 2026';
  const supports = [{
    text: 'qualifying opens June 8, 2026',
    startIndex: 16,
    endIndex: null,
    chunkIndices: [0]
  }];
  assertEq(
    classifyClaimSourcing(claim, response, supports),
    { sourced: true, via: 'specifics_matched', chunkIndices: [0] },
    'Phase 2.1: endIndex=null defaults to startIndex + text.length'
  );
}

// 18. Short text + missing offsets: text-match fallback skipped
{
  const response = 'Short text. Other content here.';
  const claim = 'Short text';
  const supports = [{
    text: 'Short',
    startIndex: null,
    endIndex: null,
    chunkIndices: [0]
  }];
  assertEq(
    classifyClaimSourcing(claim, response, supports),
    { sourced: false, reason: 'no_overlap' },
    'Phase 2.1: short text (<10 chars) + missing offsets — fallback skipped, loop exits with no overlap'
  );
}

// ===== temperatureForCategory =====
assertEq(temperatureForCategory('factual'), 0.0, 'factual → 0.0');
assertEq(temperatureForCategory('compliance'), 0.0, 'compliance → 0.0');
assertEq(temperatureForCategory('predictive'), 0.1, 'predictive → 0.1');
assertEq(temperatureForCategory('strategic'), 0.4, 'strategic → 0.4 (unchanged)');
assertEq(temperatureForCategory('conversational'), 0.6, 'conversational → 0.6');
assertEq(temperatureForCategory('unknown'), 0.4, 'unknown category → 0.4 default');
assertEq(temperatureForCategory(null), 0.4, 'null category → 0.4 default');
assertEq(temperatureForCategory(undefined), 0.4, 'undefined category → 0.4 default');

console.log(`\n${passed} passed, ${failures} failed.`);
if (failures > 0) {
  console.error(`\ngrounding_aware_validation.test.mjs — FAILED. Deploy is blocked until this passes.`);
  process.exit(1);
}
console.log('grounding_aware_validation.test.mjs — all assertions passed.');
