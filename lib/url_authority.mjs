// Phase 7 of the sam-overhaul: state-agnostic URL authority acceptance.
//
// The citation validator only accepts a claimed authority URL if its HOST is
// authoritative. Previously that was a FL/TX-heavy 15-domain allowlist, which
// stripped correct state-SOS citations for every other state. This module makes
// the check state-agnostic while keeping the non-.gov entries that still matter.
//
// A host is authoritative if it:
//   (a) ends in .gov  (any subdomain — elections.ohiosos.gov passes)
//   (b) matches *.state.XX.us or *.XX.us for a valid two-letter US state code
//   (c) is (or is a subdomain of) one of KNOWN_AUTHORITY_DOMAINS (kept because
//       several — myflorida.com, voterfocus.com, ballotpedia.org — aren't .gov)
//   (d) matches a tool-returned authority URL (handled by the caller; unchanged)
//
// Matching is on the host SUFFIX (not substring), so subdomains pass but
// look-alikes fail: mygov.com does NOT match .gov.

export const US_STATE_CODES = new Set([
  'al','ak','az','ar','ca','co','ct','de','fl','ga','hi','id','il','in','ia',
  'ks','ky','la','me','md','ma','mi','mn','ms','mo','mt','ne','nv','nh','nj',
  'nm','ny','nc','nd','oh','ok','or','pa','ri','sc','sd','tn','tx','ut','vt',
  'va','wa','wv','wi','wy','dc'
]);

// The retained non-pattern allowlist (federal + a few non-.gov authorities).
export const KNOWN_AUTHORITY_DOMAINS = [
  'fec.gov', 'irs.gov', 'census.gov', 'data.census.gov',
  'dos.fl.gov', 'dos.myflorida.com', 'dos.elections.myflorida.com',
  'myflorida.com', 'sos.state.tx.us', 'votetexas.gov',
  'ocfelections.gov', 'voterfocus.com', 'sb.seminolecountyfl.gov',
  'floridabar.org', 'ballotpedia.org'
];

// Extract a bare lowercase host from a URL or a bare-domain token.
// "https://elections.ohiosos.gov/x" -> "elections.ohiosos.gov"
// "dos.fl.gov/elections" -> "dos.fl.gov"
export function extractHost(urlOrToken) {
  let s = String(urlOrToken || '').trim().toLowerCase();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, ''); // strip scheme
  s = s.split('/')[0].split('?')[0].split('#')[0]; // strip path/query/fragment
  s = s.split('@').pop();  // strip any userinfo
  s = s.split(':')[0];     // strip port
  return s;
}

// (a) + (b): government host pattern, matched on the host suffix.
export function hostIsGovernment(host) {
  const h = String(host || '').toLowerCase();
  if (!h) return false;
  if (h === 'gov' || h.endsWith('.gov')) return true; // (a) — suffix, not substring
  // (b) — *.state.XX.us or *.XX.us with a valid state code. The regex matches
  // the trailing ".XX.us"; "state." (if present) is just an earlier label.
  const m = h.match(/\.([a-z]{2})\.us$/);
  if (m && US_STATE_CODES.has(m[1])) return true;
  return false;
}

// Full predicate. authoritativeUrls = tool-returned URLs (path (d), unchanged
// substring behavior); knownDomains defaults to KNOWN_AUTHORITY_DOMAINS.
export function urlHostMatchesAuthority(claimedUrl, authoritativeUrls, knownDomains) {
  if (!claimedUrl) return true; // nothing to check
  const host = extractHost(claimedUrl);
  if (!host) return true;
  // (a)/(b) government pattern
  if (hostIsGovernment(host)) return true;
  // (c) known authority domains — host-suffix match (subdomains pass)
  const known = knownDomains || KNOWN_AUTHORITY_DOMAINS;
  for (const k of known) {
    const kh = String(k).toLowerCase();
    if (host === kh || host.endsWith('.' + kh)) return true;
  }
  // (d) tool-returned authoritative URLs — existing substring behavior, unchanged
  const cl = String(claimedUrl).toLowerCase();
  for (const a of (authoritativeUrls || [])) {
    if (!a) continue;
    const al = String(a).toLowerCase();
    if (cl === al || cl.includes(al) || al.includes(cl)) return true;
  }
  return false;
}
