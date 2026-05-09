/**
 * extractCitedUrls(text) → string[]
 *
 * Extracts all cited URLs from response text. Catches both
 * protocol-prefixed (https://...) AND bare-domain (dos.fl.gov,
 * fec.gov, ballotpedia.org/X) forms because LLM citation styles
 * vary across engines:
 *
 *   - Haiku emits markdown links: [FL DoE](https://dos.fl.gov/X)
 *   - Gemini emits bare domains:  Source: dos.fl.gov/X
 *
 * Phase 1.5.A's initial deploy used a protocol-only regex which
 * silently no-op'd on Gemini's bare-domain style — verifier never
 * fetched anything for ~50% of regenerated_with_url events. See
 * tcb_citation_validator_fake_url_trust_pattern.md for the
 * production fabrications hidden behind that gap.
 *
 * Bare domains get https:// prepended so fetch() works against
 * them. Trailing punctuation (.,;:!?)) stripped because markdown
 * rendering glues them to URLs.
 *
 * Returns deduped array of fetchable URL strings, ordered by
 * first appearance.
 *
 * Drift detector: tests/verify_citation_url_extraction.test.mjs
 * asserts that every citation style we've seen in production
 * extracts correctly. RUN THE TEST after any change here.
 */

export function extractCitedUrls(text) {
  if (!text || typeof text !== 'string') return [];
  // Branch 1: explicit protocol prefix (existing Phase 1.5.A regex).
  // Branch 2: bare domain ending in a known TLD, with optional path.
  // Same shape as detectAgencyMentionsWithoutUrl in worker.js (line ~9881)
  // for consistency, but with path-suffix capture added so the verifier
  // fetches the specific cited page, not just the domain root.
  const urlRe = /https?:\/\/[^\s)\]<>"']+|\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]+)*\.(?:gov|com|org|net|us|edu)\b(?:\/[^\s)\]<>"']*)?/gi;
  const matches = text.match(urlRe) || [];
  const seen = new Set();
  const out = [];
  for (const raw of matches) {
    const stripped = raw.replace(/[.,;:!?)]+$/, '');
    const normalized = stripped.startsWith('http') ? stripped : 'https://' + stripped;
    if (!seen.has(normalized)) {
      seen.add(normalized);
      out.push(normalized);
    }
  }
  return out;
}
