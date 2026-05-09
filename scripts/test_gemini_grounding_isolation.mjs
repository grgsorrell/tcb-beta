// test_gemini_grounding_isolation.mjs
//
// Diagnostic: hit Gemini 2.5 Flash directly with Search Grounding,
// minimal system prompt, just the trigger user query. Bypasses all
// worker pipeline (no entity mask, no pre-fetch, no strip helper, no
// validators). Answers the question: "When grounding is on and
// nothing else is in the way, does Gemini produce a correctly-cited
// answer for compliance questions, or does it still fabricate?"
//
// Output:
//   - Raw response text
//   - Grounding metadata (chunks count, cited URLs)
//   - Whether grounding actually fired
//
// Usage (PowerShell):
//   $env:GEMINI_API_KEY = "..."
//   node scripts/test_gemini_grounding_isolation.mjs

const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) {
  console.error('Set GEMINI_API_KEY env var. PowerShell: $env:GEMINI_API_KEY = "..."');
  process.exit(1);
}

const QUERY = 'When does qualifying open for Florida State House in 2026?';

const SYSTEM_PROMPT = 'You are a helpful research assistant. Answer factual questions concisely. When grounding tools surface sources, cite them inline.';

const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + encodeURIComponent(API_KEY);

const body = {
  systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
  contents: [
    { role: 'user', parts: [{ text: QUERY }] }
  ],
  tools: [{ google_search: {} }],   // ← Search Grounding enabled, same as production
  generationConfig: {
    temperature: 0.4,
    maxOutputTokens: 4096
  }
};

console.log('=== INPUT ===');
console.log('System prompt:', SYSTEM_PROMPT);
console.log('User query:', QUERY);
console.log('Tools:', JSON.stringify(body.tools));
console.log();

const startedAt = Date.now();
const resp = await fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
  signal: AbortSignal.timeout(30000)
});
const latencyMs = Date.now() - startedAt;

if (!resp.ok) {
  const t = await resp.text().catch(() => '');
  console.error(`HTTP ${resp.status} ${resp.statusText}: ${t.slice(0, 500)}`);
  process.exit(1);
}

const data = await resp.json();
const candidate = data.candidates && data.candidates[0];

console.log('=== RESPONSE ===');
console.log('Latency:', latencyMs, 'ms');
console.log('Input tokens:', (data.usageMetadata && data.usageMetadata.promptTokenCount) || 'unknown');
console.log('Output tokens:', (data.usageMetadata && data.usageMetadata.candidatesTokenCount) || 'unknown');
console.log('Finish reason:', candidate && candidate.finishReason);
console.log();

// Concatenate text parts
let text = '';
const parts = (candidate && candidate.content && Array.isArray(candidate.content.parts)) ? candidate.content.parts : [];
for (const p of parts) if (p && typeof p.text === 'string') text += p.text;

console.log('=== TEXT ===');
console.log(text.trim());
console.log();

// Grounding metadata
const gm = candidate && candidate.groundingMetadata;
if (gm) {
  const chunks = (gm.groundingChunks || []);
  const supports = (gm.groundingSupports || []);
  const queries = (gm.webSearchQueries || []);

  console.log('=== GROUNDING ===');
  console.log('Search queries Gemini issued:');
  for (const q of queries) console.log('  -', q);
  console.log();

  console.log('Grounding chunks (sources):', chunks.length);
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    const w = c.web || {};
    console.log(`  [${i}] ${w.title || '(no title)'} — ${w.uri || '(no URI)'}`);
  }
  console.log();

  console.log('Grounding supports (claim → source mappings):', supports.length);
  for (let i = 0; i < Math.min(supports.length, 10); i++) {
    const s = supports[i];
    const seg = (s.segment && s.segment.text) ? s.segment.text.slice(0, 120) : '(no segment text)';
    const idxs = (s.groundingChunkIndices || []).join(',');
    console.log(`  "${seg}" ← chunks [${idxs}]`);
  }
  if (supports.length > 10) console.log(`  ... and ${supports.length - 10} more`);
} else {
  console.log('=== GROUNDING ===');
  console.log('NO groundingMetadata in response — grounding did NOT fire on this turn.');
  console.log('This means the model answered from training data alone.');
}

// Quick fabrication check
console.log();
console.log('=== QUICK FABRICATION CHECK ===');
const lc = text.toLowerCase();
const flags = [];
if (lc.includes('may 11')) flags.push('May 11 mentioned (could be petition deadline OR fabrication-as-qualifying-open)');
if (lc.includes('may 25')) flags.push('May 25 mentioned (FL DoE actual: documents-accepted-from)');
if (lc.includes('june 8')) flags.push('June 8 mentioned (FL DoE actual qualifying open)');
if (lc.includes('june 12')) flags.push('June 12 mentioned (FL DoE actual qualifying close)');
if (lc.includes('qualifying') && lc.includes('open')) flags.push('uses "qualifying" + "open" framing');
if (lc.includes('petition deadline')) flags.push('uses "petition deadline" — distinguishes from qualifying');
if (flags.length === 0) console.log('  (no specific dates flagged for review)');
else for (const f of flags) console.log('  -', f);

console.log();
console.log('Per dos.fl.gov/elections/candidates-committees/qualifying/ (verified earlier):');
console.log('  - Qualifying period: Noon, June 8 – Noon, June 12, 2026');
console.log('  - May 11: petition deadline (NOT qualifying open)');
console.log('  - May 25: documents acceptance begins (pre-qualifying paperwork)');
