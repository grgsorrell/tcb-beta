// Phase 1.5.A.1 historical audit.
//
// Runs the new verifyCitationAccuracy logic against the past 30 days
// of regenerated_with_url events to surface the fabrications that
// silently passed through Phase 1.5.A's narrow regex. Outputs a
// markdown report ranking the 10 worst offenders by claim severity.
//
// Inputs:
//   ANTHROPIC_API_KEY env var (set via shell, not committed)
//   scripts/regen_url_events.json — D1 dump of events to audit
//
// Generate the input file first:
//   wrangler d1 execute candidates-toolbox-db --remote ^
//     --command="SELECT id, created_at, user_id, conversation_id, final_response_excerpt FROM sam_citation_validation_events WHERE created_at > datetime('now', '-30 days') AND action_taken = 'regenerated_with_url' ORDER BY created_at DESC;" ^
//     --json > scripts/regen_url_events.json
//
// PowerShell run:
//   $env:ANTHROPIC_API_KEY = "sk-ant-..."
//   node scripts/audit_regenerated_with_url_history.mjs
//
// Output: scripts/regen_url_audit_report.md (top 10 + summary stats)
//
// Cost: ~$0.005/event audit-Haiku call × 107 events = ~$0.50 total.
// Runtime: ~3 sec/event sequential (parallelization risks rate-limit
// burst on small-batch keys); ~5 min total.

import { readFileSync, writeFileSync } from 'node:fs';
import { extractCitedUrls } from '../lib/extract_cited_urls.mjs';

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  console.error('Set ANTHROPIC_API_KEY env var before running.');
  console.error('PowerShell:  $env:ANTHROPIC_API_KEY = "sk-ant-..."');
  process.exit(1);
}

const RAW = JSON.parse(readFileSync('scripts/regen_url_events.json', 'utf8'));
const events = RAW[0].results || [];
console.log(`Loaded ${events.length} regenerated_with_url events.`);

// === HTML normalization helpers (mirror worker.js stripHtml + normalizeForMatch) ===
function stripHtml(html) {
  if (!html || typeof html !== 'string') return '';
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'");
}

function normalizeForMatch(t) {
  if (!t) return '';
  return t.toLowerCase().replace(/\s+/g, ' ').trim();
}

// === Per-event audit ===
async function auditOne(ev) {
  const text = ev.final_response_excerpt || '';
  if (!text) return { ev, skipped: 'no text', unsupported: [] };

  const urls = extractCitedUrls(text);
  if (urls.length === 0) return { ev, skipped: 'no URLs extracted', unsupported: [] };

  // Fetch each URL with 5s timeout
  const sources = await Promise.all(urls.map(async (url) => {
    try {
      const r = await fetch(url, {
        method: 'GET',
        headers: { 'User-Agent': 'TCB-citation-verifier/1.0' },
        signal: AbortSignal.timeout(5000),
        redirect: 'follow'
      });
      if (!r.ok) return { url, sourceText: null };
      const ct = (r.headers.get('content-type') || '').toLowerCase();
      if (!ct.includes('html') && !ct.includes('text/plain')) return { url, sourceText: null };
      const html = await r.text();
      if (!html || html.length < 200) return { url, sourceText: null };
      return { url, sourceText: normalizeForMatch(stripHtml(html)).slice(0, 6000) };
    } catch (e) {
      return { url, sourceText: null };
    }
  }));

  const reachable = sources.filter(s => s.sourceText);
  if (reachable.length === 0) return { ev, urls, skipped: 'no sources reachable', unsupported: [] };

  // Audit-Haiku: same prompt as production verifyCitationAccuracy
  const sourcesText = reachable.map(s => '=== Source ' + s.url + ' ===\n' + s.sourceText).join('\n\n');
  const prompt =
    'You verify that a campaign coaching response\'s specific factual claims are actually supported by their cited sources.\n\n' +
    'CITED SOURCES (' + reachable.length + ' URLs, normalized HTML, first 6000 chars each):\n' + sourcesText + '\n\n' +
    'CAMPAIGN COACHING RESPONSE:\n' + text.slice(0, 3000) + '\n\n' +
    'TASK: Identify any specific factual claim in the RESPONSE that is paired with a cited URL but is NOT supported by the source content.\n\n' +
    'Check specifically for:\n- Specific dates (qualifying open/close, filing deadlines, petition deadlines, election dates)\n- Specific dollar amounts (donation limits, filing fees, contribution caps)\n- Specific procedures (where to file, who to contact)\n\n' +
    'A claim is "supported" only if the source content contains the same date/amount labeled with the SAME concept.\n- "May 11 is the petition deadline" SUPPORTS "petition deadline is May 11"\n- "May 11 is the petition deadline" does NOT support "qualifying opens May 11"\n\n' +
    'Return JSON: {"unsupported_claims": ["..."]}\nIf all claims supported: {"unsupported_claims": []}\nJSON ONLY — no preamble.';

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 800,
        temperature: 0,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    const ad = await resp.json();
    let txt = '';
    if (ad && ad.content && Array.isArray(ad.content)) {
      for (const b of ad.content) if (b && b.type === 'text' && b.text) txt += b.text;
    }
    const m = txt.match(/\{[\s\S]*\}/);
    if (!m) return { ev, urls, unsupported: [] };
    const parsed = JSON.parse(m[0]);
    const unsupported = Array.isArray(parsed.unsupported_claims) ? parsed.unsupported_claims : [];
    return { ev, urls, unsupported };
  } catch (e) {
    console.warn(`audit failed for ${ev.id}:`, e.message);
    return { ev, urls, error: e.message, unsupported: [] };
  }
}

// === Severity scoring ===
function severityScore(claim) {
  const c = claim.toLowerCase();
  let score = 1;
  // Date claims (compliance deadlines): highest stakes
  if (/qualif|filing|petition|deadline|due/.test(c) && /\b(20\d\d|january|february|march|april|may|june|july|august|september|october|november|december)\b/.test(c)) score += 5;
  // Dollar amounts (donation limits, filing fees)
  if (/\$[\d,]+/.test(c) || /\b(limit|fee|cap|max)\b/.test(c)) score += 4;
  // Phone numbers
  if (/\b\d{3}-\d{3}-\d{4}\b/.test(c)) score += 2;
  // Procedural fabrications
  if (/file with|submit to|contact|send to|mail to/.test(c) && /(county|state|division|department)/.test(c)) score += 3;
  // Agency/contact fabrications
  if (/\b(division of elections|secretary of state|fec|department of state)\b/.test(c)) score += 2;
  return score;
}

// === Run audit sequentially ===
const results = [];
for (let i = 0; i < events.length; i++) {
  const ev = events[i];
  process.stdout.write(`Auditing ${i+1}/${events.length}: ${ev.id}... `);
  const r = await auditOne(ev);
  results.push(r);
  console.log(r.skipped ? `[skip: ${r.skipped}]` : `${r.unsupported.length} unsupported`);
}

// === Rank by severity ===
const flagged = results.filter(r => r.unsupported && r.unsupported.length > 0);
flagged.forEach(r => {
  r.severity = r.unsupported.reduce((sum, c) => sum + severityScore(c), 0);
});
flagged.sort((a, b) => b.severity - a.severity);

// === Build markdown report ===
const lines = [];
lines.push('# Phase 1.5.A.1 historical audit — regenerated_with_url events\n');
lines.push(`**Run date:** ${new Date().toISOString()}`);
lines.push(`**Events audited:** ${events.length}`);
lines.push(`**Events with unsupported claims:** ${flagged.length} (${((flagged.length/events.length)*100).toFixed(1)}%)`);
lines.push(`**Skipped (no URLs / unreachable):** ${results.filter(r => r.skipped).length}\n`);

// Severity distribution
const severityCounts = { high: 0, medium: 0, low: 0 };
flagged.forEach(r => {
  if (r.severity >= 8) severityCounts.high++;
  else if (r.severity >= 4) severityCounts.medium++;
  else severityCounts.low++;
});
lines.push('## Severity distribution');
lines.push(`- High (date+deadline / dollar+limit fabrications): ${severityCounts.high}`);
lines.push(`- Medium (procedural / contact / phone): ${severityCounts.medium}`);
lines.push(`- Low (single-claim fabrications): ${severityCounts.low}\n`);

// Per-user breakdown
const byUser = {};
flagged.forEach(r => {
  const u = r.ev.user_id || 'unknown';
  if (!byUser[u]) byUser[u] = { events: 0, unsupportedTotal: 0 };
  byUser[u].events++;
  byUser[u].unsupportedTotal += r.unsupported.length;
});
lines.push('## Affected users');
Object.entries(byUser).sort((a,b) => b[1].events - a[1].events).forEach(([u, s]) => {
  lines.push(`- \`${u}\` — ${s.events} events, ${s.unsupportedTotal} unsupported claims`);
});
lines.push('');

// Top 10 worst offenders
lines.push('## Top 10 worst offenders (ranked by severity score)\n');
flagged.slice(0, 10).forEach((r, i) => {
  lines.push(`### #${i+1} — severity ${r.severity}, event ${r.ev.id}`);
  lines.push(`- **When:** ${r.ev.created_at}`);
  lines.push(`- **User:** \`${r.ev.user_id}\``);
  lines.push(`- **Conversation:** \`${r.ev.conversation_id || 'null'}\``);
  lines.push(`- **Cited URLs extracted:** ${(r.urls || []).join(', ')}`);
  lines.push(`- **Verifier-flagged unsupported claims:**`);
  r.unsupported.forEach(c => lines.push(`  - "${String(c).slice(0, 200)}"`));
  lines.push(`- **Original response excerpt:**`);
  lines.push('```');
  lines.push(String(r.ev.final_response_excerpt || '').slice(0, 800));
  lines.push('```');
  lines.push('');
});

writeFileSync('scripts/regen_url_audit_report.md', lines.join('\n'));
console.log(`\nReport written to scripts/regen_url_audit_report.md`);
console.log(`${flagged.length} events flagged with unsupported claims out of ${events.length} audited.`);
