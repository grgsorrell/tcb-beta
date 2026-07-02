#!/usr/bin/env node
// Phase 7 unit test for the state-agnostic URL authority predicate.
// Exercises the REAL logic imported from lib/url_authority.mjs (the same
// module worker.js uses). No worker imports, no network.
//
// Run:  node scripts/test_url_whitelist.mjs

import { urlHostMatchesAuthority, KNOWN_AUTHORITY_DOMAINS } from '../lib/url_authority.mjs';

// No tool-returned authority URLs in these cases — exercises rules (a)/(b)/(c).
const accept = (url) => urlHostMatchesAuthority(url, [], KNOWN_AUTHORITY_DOMAINS);

const cases = [
  // [input, expected]
  ['ohiosos.gov', true],                 // (a) .gov
  ['sos.ga.gov', true],                  // (a) .gov subdomain
  ['elections.virginia.gov', true],      // (a) .gov subdomain
  ['sos.state.tx.us', true],             // (b) *.state.XX.us
  ['dos.myflorida.com', true],           // (c) subdomain of known myflorida.com
  ['ballotpedia.org', true],             // (c) exact known
  ['https://elections.ohiosos.gov/candidates', true], // scheme + path stripped, still .gov
  ['randomblog.com', false],             // not authoritative
  ['sos-ga.fake.com', false],            // look-alike, not .gov/.us/known
  ['mygov.com', false],                  // MUST NOT match .gov by substring
];

let failed = 0;
for (const [input, expected] of cases) {
  const got = accept(input);
  const ok = got === expected;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${input}  → ${got} (expected ${expected})`);
}

if (failed) {
  console.error(`\n${failed} case(s) FAILED.`);
  process.exit(1);
}
console.log('\nAll URL-authority cases passed.');
