// strip_tool_references.test.mjs
//
// Drift-detector test for stripToolReferencesForGemini. Run as:
//   node tests/strip_tool_references.test.mjs
//
// Exits non-zero on any assertion failure. Wired as a pre-deploy gate
// for the Gemini migration — if this fails, the systemPrompt and the
// strip helper are out of sync and the Gemini path may receive
// tool-call instructions Gemini cannot honor.
//
// Three categories of assertions:
//   (a) Tool-name absence: every Anthropic-side tool name absent from
//       the strip output. Covers web_search, all lookup_*, all save_*,
//       and any other Anthropic-shape tool reference.
//   (b) KEEP-AS-IS sections present: a sample of sections that should
//       not be touched by the strip helper (rules 2-4, URL routing
//       table entries, geographic example, mode hints for non-compliance,
//       banned hedging words rule).
//   (c) Expected replacements present: a sample of new prose phrases
//       the strip should have introduced (Pre-Fetched Context block
//       references, "Search Grounding" replacements, NO GROUNDING FOR
//       OPPONENTS, etc.).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { stripToolReferencesForGemini } from '../lib/strip_tool_references.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE_PATH = join(__dirname, 'fixtures', 'sample_masked_prompt.txt');

const fixture = readFileSync(FIXTURE_PATH, 'utf8');
const result = stripToolReferencesForGemini(fixture);

let failures = 0;
let passed = 0;

function assert(cond, label) {
  if (cond) {
    passed++;
  } else {
    failures++;
    console.error(`  FAIL: ${label}`);
  }
}

// ============================================================
// (a) Forbidden tokens — every tool name absent from result
// ============================================================
console.log('\n[a] Forbidden tokens (Anthropic tool references)...');

const forbiddenTokens = [
  'web_search',
  'lookup_compliance_deadlines',
  'lookup_finance_reports',
  'lookup_donation_limits',
  'lookup_jurisdiction',
  'save_note',
  'add_calendar_event',
  'update_task',
  'save_win_number',
  'save_candidate_profile',
  // Phrases that imply tool-call mode
  'call web_search',
  'WEB_SEARCH RETURNS NOTHING',
  'NO WEB_SEARCH FOR OPPONENTS',
  'a call to lookup_',
  'No web_search needed',
  'Call web_search',
  'web_searched',
];

for (const t of forbiddenTokens) {
  assert(!result.includes(t), `forbidden token survived strip: "${t}"`);
}

// ============================================================
// (b) KEEP-AS-IS sections present
// ============================================================
console.log('[b] KEEP-AS-IS sections (must survive strip unchanged)...');

const expectedKeepIntact = [
  // Rules that aren't tool-specific
  '2. Never ask for information already in Ground Truth',
  '3. Dates: today is',
  '4. Compliance: never tell a candidate they are "compliant"',
  '6. Geographic scope',
  '7. If Intel Ground Truth has candidate data',
  '8. Budget categories: digital, mail, broadcast',
  '9. Services redirect',
  '11. When writing documents',
  '12. Calendar management',
  '13. Win number',
  '14. Keep responses to 2-3 sentences',
  '15. End every response with one specific actionable',
  // URL routing table
  '1. FILING / QUALIFYING DEADLINES (federal):',
  'fec.gov/help-candidates-and-committees',
  '5. CONTRIBUTION LIMITS:',
  // Geographic example failure mode
  'Altamonte Springs is in Seminole County',
  'Apopka, Bay Lake, Belle Isle',
  // Mode hints for non-compliance
  'MODE: Content Writing — ask clarifying questions',
  'MODE: Strategy — specific advice based on timeline',
  'MODE: Fundraising — practical advice',
  // Banned hedging words rule
  'BANNED HEDGING WORDS on factual questions',
  'typically,',
  // Validator note (KEEP per design)
  'post-generation validator',
  // Citation discipline
  'CITATION DISCIPLINE — HARD CONSTRAINT',
  // User notes authority
  'USER NOTES authority',
  // Sam intro
  'You are Sam, a veteran political campaign manager',
  // Ground Truth header
  'GROUND TRUTH —',
];

for (const s of expectedKeepIntact) {
  assert(result.includes(s), `expected KEEP-AS-IS section missing: "${s.slice(0, 60)}..."`);
}

// ============================================================
// (c) Expected replacement texts present
// ============================================================
console.log('[c] Expected replacement texts (strip output additions)...');

const expectedReplacements = [
  // Section 1: Factual discipline
  'rely on the Pre-Fetched Context block below',
  'Search Grounding to find a current source',
  'Search Grounding is always enabled',
  'Pre-Fetched Context block',
  'Pre-fetched data is verified, cached, and authoritative',
  'No grounding needed when answering from context',
  'WHEN GROUNDING RETURNS NOTHING USEFUL',
  // Section 2: Smart deferral
  'SEARCH-TRIED PATTERN (Search Grounding surfaced no usable result)',
  'If Search Grounding surfaced no usable result for a factual claim',
  // Section 3: Hard constraints
  'Authorized Places** subsection of the Pre-Fetched Context',
  'Compliance Deadlines** subsection of the Pre-Fetched Context',
  'Finance Reports** subsection of the Pre-Fetched Context',
  'Donation Limits** subsection of the Pre-Fetched Context',
  'labels its data "Verified"',
  'labels its data "Web-search-backed"',
  '"No verified data available"',
  // Section 4: News + opponent + meta-transparency
  'sourced from Search Grounding\'s surfaced articles',
  'NO GROUNDING FOR OPPONENTS',
  'pre-fetched compliance context didn\'t cover that for your race',
  // Section 5: Rules 1, 5
  'Never claim you completed a save/calendar/task action',
  'Lean on Pre-Fetched Context first, then Search Grounding',
  // Section 6: Onboarding
  'The Pre-Fetched Context block in this prompt contains compliance deadlines',
  // Section 7: Mode hint
  'MODE: Compliance — use Pre-Fetched Context first, then Search Grounding',
  // Section 8: Classifier framing
  'Pre-Fetched Context or Search Grounding and be cited inline',
  'find a relevant rule via Pre-Fetched Context or Search Grounding',
  'No grounding call needed',
  'Default to Pre-Fetched Context first',
];

for (const s of expectedReplacements) {
  assert(result.includes(s), `expected replacement text missing: "${s.slice(0, 60)}..."`);
}

// ============================================================
// Summary + exit code
// ============================================================
console.log(`\n${passed} passed, ${failures} failed.`);
if (failures > 0) {
  console.error(`\nstrip_tool_references.test.mjs — FAILED. Deploy is blocked until this passes.`);
  process.exit(1);
}
console.log(`strip_tool_references.test.mjs — all assertions passed.`);
