/**
 * classifyForReferenceLookup(userMessage, profileState) → result
 *
 * Returns one of:
 *   { needsLookup: true, state, category, queryText }
 *     — caller queries campaign_reference with these params.
 *     V1: ONLY returned when BOTH state AND a specific category are detected.
 *   { needsLookup: false, reason }
 *     — strategic/conversational/no-state/no-category-match query; skip lookup.
 *
 * State extraction priority:
 *   1. State name in message ("Texas", "running for office in Florida")
 *   2. Profile state fallback (body.state from request)
 *   3. None → needsLookup: false (reason: 'no_state')
 *
 * V1 LIMITATION: pure 2-letter codes without surrounding context (e.g.,
 * standalone "TX" not preceded by "in"/"for"/"of") are NOT detected.
 * False-positive risk too high (codes like ME/OR/IN/OK/HI overlap with
 * common English words). V2 could add context-bounded code matching.
 *
 * Category detection: first-match-wins across CATEGORY_SIGNALS in
 * declaration order. Multi-word phrases listed first inside each
 * category to favor specificity over breadth.
 *
 * V1 DESIGN: NO factual-fallback. If no specific category matches,
 * classifier returns needsLookup: false with reason='no_specific_category_match'.
 *
 * Rationale (Greg, 2026-05-09): with 100 rows in the table, off-context
 * queries that match generic factual signals could token-match the wrong
 * verified facts and inject mis-context (e.g. "when is the deadline for
 * my campaign manager to send mailers?" matching per_cycle rows). Better
 * to miss a novel-phrasing query than to inject wrong context.
 *
 * V2 may revisit factual-fallback once telemetry shows which queries
 * are missing. The 'no_specific_category_match' reason is logged so we
 * can review near-misses.
 */

const STATE_NAMES = {
  'alabama': 'AL', 'alaska': 'AK', 'arizona': 'AZ', 'arkansas': 'AR',
  'california': 'CA', 'colorado': 'CO', 'connecticut': 'CT', 'delaware': 'DE',
  'florida': 'FL', 'georgia': 'GA', 'hawaii': 'HI', 'idaho': 'ID',
  'illinois': 'IL', 'indiana': 'IN', 'iowa': 'IA', 'kansas': 'KS',
  'kentucky': 'KY', 'louisiana': 'LA', 'maine': 'ME', 'maryland': 'MD',
  'massachusetts': 'MA', 'michigan': 'MI', 'minnesota': 'MN', 'mississippi': 'MS',
  'missouri': 'MO', 'montana': 'MT', 'nebraska': 'NE', 'nevada': 'NV',
  'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
  'north carolina': 'NC', 'north dakota': 'ND', 'ohio': 'OH', 'oklahoma': 'OK',
  'oregon': 'OR', 'pennsylvania': 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
  'south dakota': 'SD', 'tennessee': 'TN', 'texas': 'TX', 'utah': 'UT',
  'vermont': 'VT', 'virginia': 'VA', 'washington': 'WA', 'west virginia': 'WV',
  'wisconsin': 'WI', 'wyoming': 'WY', 'district of columbia': 'DC'
};
const STATE_CODES = new Set(Object.values(STATE_NAMES));

// Category → signal phrases. Order within each array: specific → general.
// Order of categories: more disambiguating categories first, so dual-match
// signals (e.g. "early voting") resolve to the right bucket.
const CATEGORY_SIGNALS = {
  election_dates: [
    'election day', 'general election date', 'primary runoff date',
    'when does early voting', 'when is early voting',
    'when is the runoff', 'when is the primary',
    'registration deadline', 'mail ballot deadline', 'voter registration',
    'when does early voting start', 'when does early voting end'
  ],
  finance_ethics: [
    'campaign finance', 'campaign treasurer', 'campaign expense',
    'campaign account', 'campaign funds', 'finance report',
    'ethics commission', 'in-kind contribution', 'personal financial statement',
    'foreign national', 'corporate contribution', 'cash contribution',
    'donor', 'donation', 'contribution limit', 'donation limit',
    'treasurer', 'pac contribution', 'expenditure', 'venmo', 'paypal',
    'reporting period', 'filing deadline late', 'pfs', 'c/oh form'
  ],
  ballot_access: [
    'filing fee', 'filing application', 'place on the ballot',
    'appear on the ballot', 'ballot order', 'ballot ordering',
    'declaration of candidacy', 'qualifying period', 'qualify',
    'qualifying', 'petition signature', 'write-in candidate',
    'withdraw from the ballot', 'name on the ballot'
  ],
  voter_interaction: [
    'poll watcher', 'polling place', 'voter id', 'voter identification',
    'electioneering', 'mail ballot', 'vote by mail', 'absentee ballot',
    'provisional ballot', 'driving voters', 'firearm at polls',
    'cell phone polling', 'assist a voter'
  ],
  residency: [
    'residency requirement', 'domicile', 'live in my district',
    'reside in', 'where i live', 'how long must i live'
  ],
  candidate_eligibility: [
    'eligibility', 'felony conviction', 'felon run for office',
    'age requirement', 'how old must i be', 'minimum age',
    'eligible to run', 'qualifications for'
  ],
  redistricting: [
    'redistricting', 'redrawn district', 'new district map',
    'district lines changed', 'plan c2333'
  ],
  recall_rules: [
    'recall election', 'recall an officeholder', 'recall a mayor',
    'recall provision'
  ],
  filing_requirements: [
    'filing requirement', 'qualify by petition', 'petition signature requirement'
  ],
  runoff_rules: [
    'runoff rule', 'runoff threshold', 'runoff election trigger'
  ]
};

export function classifyForReferenceLookup(userMessage, profileState) {
  if (!userMessage || typeof userMessage !== 'string' || userMessage.trim().length === 0) {
    return { needsLookup: false, reason: 'empty_message' };
  }
  const text = userMessage.toLowerCase();

  // Step 1: state extraction
  let state = null;
  for (const [name, code] of Object.entries(STATE_NAMES)) {
    const re = new RegExp('\\b' + name.replace(/\s+/g, '\\s+') + '\\b', 'i');
    if (re.test(userMessage)) { state = code; break; }
  }
  if (!state && profileState) {
    const lower = String(profileState).toLowerCase().trim();
    if (STATE_NAMES[lower]) state = STATE_NAMES[lower];
    else if (STATE_CODES.has(lower.toUpperCase())) state = lower.toUpperCase();
  }
  if (!state) {
    return { needsLookup: false, reason: 'no_state' };
  }

  // Step 2: category signal detection (V1: required for needsLookup=true)
  let category = null;
  for (const [cat, signals] of Object.entries(CATEGORY_SIGNALS)) {
    if (signals.some(sig => text.includes(sig))) { category = cat; break; }
  }

  if (category) {
    return { needsLookup: true, state, category, queryText: userMessage };
  }

  // V1: no factual-fallback. State present but no specific category → skip.
  return { needsLookup: false, state, reason: 'no_specific_category_match' };
}
