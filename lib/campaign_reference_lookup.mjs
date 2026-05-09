/**
 * lookupCampaignReference(db, { state, category, queryText }) → row[]
 *
 * V1 fuzzy match: state-scoped candidate pull + JS-side token scoring.
 *
 * Algorithm:
 *   1. SELECT all rows matching state (and optionally category).
 *      State partitioning keeps candidate set small even at 5000+ row scale.
 *      Hard cap of 500 candidates as defense against accidental over-pull.
 *   2. Tokenize queryText: lowercase, strip non-alphanumeric, drop tokens
 *      shorter than 3 chars, drop common stop-words.
 *   3. Score each candidate by count of unique token matches against
 *      question + question_variants concatenated.
 *   4. Filter to nonzero scores, sort descending (tiebreak: more recent
 *      last_verified_date first), return top 3 rows.
 *
 * Returns full row data (all columns) per match. Caller (Sam pre-fetch
 * Phase 2) formats the rows into prose for systemPrompt injection.
 *
 * No queryText: falls back to most-recently-verified rows for the state
 * (helps the test endpoint return something sensible when called without q).
 *
 * V1 → V2 migration path: if state-partitioned candidate scoring becomes
 * a bottleneck (5000+ rows per state, slow tokenization), move to D1 FTS5
 * full-text indexing. Schema change + index rebuild; algorithm becomes
 * SQL-side MATCH instead of JS-side scoring.
 */

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'has',
  'her', 'was', 'one', 'our', 'out', 'day', 'get', 'use', 'now', 'who',
  'how', 'why', 'where', 'when', 'what', 'which', 'will', 'with', 'this',
  'that', 'they', 'have', 'from', 'into', 'over', 'than', 'them', 'about',
  'does', 'did', 'such', 'some', 'any', 'these', 'those', 'just', 'only'
]);

export async function lookupCampaignReference(db, params) {
  if (!db || !params || !params.state) return [];
  const state = String(params.state).toUpperCase();
  const category = params.category || null;
  const queryText = params.queryText || '';

  // Step 1: pull state-scoped candidates
  let sql = 'SELECT * FROM campaign_reference WHERE UPPER(state) = ?';
  const sqlParams = [state];
  if (category) {
    sql += ' AND category = ?';
    sqlParams.push(category);
  }
  sql += ' LIMIT 500';

  let candidates;
  try {
    const result = await db.prepare(sql).bind(...sqlParams).all();
    candidates = (result && result.results) || [];
  } catch (e) {
    console.warn('[lookupCampaignReference] D1 query failed:', e.message);
    return [];
  }
  if (candidates.length === 0) return [];

  // Step 2: tokenize
  const tokens = queryText
    .toLowerCase()
    .split(/\s+/)
    .map(t => t.replace(/[^a-z0-9]/g, ''))
    .filter(t => t.length >= 3 && !STOP_WORDS.has(t));

  // No tokens — fall back to recency
  if (tokens.length === 0) {
    return candidates
      .sort((a, b) => (b.last_verified_date || '').localeCompare(a.last_verified_date || ''))
      .slice(0, 3);
  }

  // Step 3: score by token-match count against question + question_variants
  const scored = candidates.map(row => {
    const haystack = (
      (row.question || '') + ' ' + (row.question_variants || '')
    ).toLowerCase();
    let score = 0;
    for (const t of tokens) {
      if (haystack.includes(t)) score++;
    }
    return { row, score };
  });

  // Step 4: filter, sort, return top 3
  return scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score || (b.row.last_verified_date || '').localeCompare(a.row.last_verified_date || ''))
    .slice(0, 3)
    .map(s => s.row);
}
