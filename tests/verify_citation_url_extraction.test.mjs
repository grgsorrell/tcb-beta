// verify_citation_url_extraction.test.mjs
//
// Drift detector for extractCitedUrls. Runs as:
//   node tests/verify_citation_url_extraction.test.mjs
//
// Exits non-zero on assertion failure. Wired as a pre-deploy gate
// alongside strip_tool_references.test.mjs. Catches regressions
// where the citation URL regex gets re-narrowed and silently
// drops citation forms — the failure mode that hid 50% of
// regenerated_with_url events from Phase 1.5.A's verifier.

import { extractCitedUrls } from '../lib/extract_cited_urls.mjs';

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

// === Protocol-prefixed URLs (Phase 1.5.A original behavior) ===
assertEq(
  extractCitedUrls('See https://dos.fl.gov/elections for details.'),
  ['https://dos.fl.gov/elections'],
  'protocol-prefixed URL'
);

assertEq(
  extractCitedUrls('Per [FL DoE](https://dos.fl.gov/elections), qualifying opens.'),
  ['https://dos.fl.gov/elections'],
  'markdown link with https://'
);

// === Bare-domain URLs (Phase 1.5.A.1 fixes) ===
assertEq(
  extractCitedUrls('Source: Florida Division of Elections at dos.fl.gov/elections'),
  ['https://dos.fl.gov/elections'],
  'bare domain with path'
);

assertEq(
  extractCitedUrls('Per dos.fl.gov, qualifying opens June 8.'),
  ['https://dos.fl.gov'],
  'bare domain without path'
);

assertEq(
  extractCitedUrls('Source: (dos.fl.gov/elections).'),
  ['https://dos.fl.gov/elections'],
  'parens around bare-domain URL — paren excluded, trailing period stripped'
);

assertEq(
  extractCitedUrls('Per dos.fl.gov.'),
  ['https://dos.fl.gov'],
  'trailing period stripped'
);

// === Mixed forms ===
assertEq(
  extractCitedUrls('First (https://dos.fl.gov/elections) then (dos.fl.gov/elections).'),
  ['https://dos.fl.gov/elections'],
  'both protocol and bare forms — deduped after normalization'
);

assertEq(
  extractCitedUrls('Sources: dos.fl.gov, fec.gov.'),
  ['https://dos.fl.gov', 'https://fec.gov'],
  'multiple bare domains comma-separated'
);

assertEq(
  extractCitedUrls('Per dos.fl.gov for state, fec.gov for federal, sos.state.tx.us for Texas.'),
  ['https://dos.fl.gov', 'https://fec.gov', 'https://sos.state.tx.us'],
  'three distinct bare domains'
);

// === Edge cases ===
assertEq(
  extractCitedUrls('Per [Ballotpedia](https://ballotpedia.org/Florida_House_of_Representatives_elections,_2026), elections.'),
  ['https://ballotpedia.org/Florida_House_of_Representatives_elections,_2026'],
  'URL with comma in path (Ballotpedia article slug)'
);

assertEq(
  extractCitedUrls('Per [FL DoE](dos.fl.gov/elections), qualifying opens.'),
  ['https://dos.fl.gov/elections'],
  'markdown link to bare-domain target'
);

assertEq(
  extractCitedUrls('Just plain text with no citations.'),
  [],
  'no URLs in text'
);

assertEq(extractCitedUrls(''), [], 'empty string');
assertEq(extractCitedUrls(null), [], 'null input');
assertEq(extractCitedUrls(undefined), [], 'undefined input');

// === Real production patterns ===

// Greg's exact 2026-05-08 failed turn (bare-domain × 2)
assertEq(
  extractCitedUrls(
    'Qualifying for State House candidates in Florida opens at noon on Monday, June 8, 2026 (Source: Florida Division of Elections at dos.fl.gov/elections). The Florida Division of Elections (dos.fl.gov/elections) began accepting pre-qualifying documents on May 25, 2026.'
  ),
  ['https://dos.fl.gov/elections'],
  "Greg's 2026-05-08 Phase 1 spot test failure — bare-domain x2 deduped"
);

// Yesterday's 2026-05-07 Haiku-side test (markdown link with https://)
assertEq(
  extractCitedUrls(
    "I don't have the verified 2026 qualifying dates published yet. The authoritative source is the Florida Department of State - Division of Elections at [dos.fl.gov/elections/candidates-committees/qualifying/](https://dos.fl.gov/elections/candidates-committees/qualifying/) — call them at 850-245-6200."
  ),
  ['https://dos.fl.gov/elections/candidates-committees/qualifying/'],
  "Haiku 2026-05-07 markdown style — both bare and protocol present, deduped to canonical"
);

// May 11 fabrication examples from the production audit (Sample 4 + 5 from yesterday's investigation)
assertEq(
  extractCitedUrls(
    'For State House, qualifying opens at noon on May 11, 2026, and the filing deadline is June 12, 2026 (per [Ballotpedia](https://ballotpedia.org/Florida_House_of_Representatives_elections,_2026)). That\'s your window. You need to file with the Florida Division of Elections at [dos.fl.gov/elections/candidates](https://dos.fl.gov/elections/candidates).'
  ),
  ['https://ballotpedia.org/Florida_House_of_Representatives_elections,_2026', 'https://dos.fl.gov/elections/candidates'],
  'May 11 fabrication sample — two markdown-linked URLs extracted'
);

// === Acknowledged over-extraction (low risk per design) ===
assertEq(
  extractCitedUrls('Email greg@example.com for info.'),
  ['https://example.com'],
  'email domain extracted (acknowledged over-extraction; verifier audit-Haiku catches false-pair)'
);

// === Summary ===
console.log(`\n${passed} passed, ${failures} failed.`);
if (failures > 0) {
  console.error(`\nverify_citation_url_extraction.test.mjs — FAILED. Deploy is blocked until this passes.`);
  process.exit(1);
}
console.log('verify_citation_url_extraction.test.mjs — all assertions passed.');
