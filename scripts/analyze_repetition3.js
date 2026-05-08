// Round 3: timeline correlation + content analysis of round-1 narration patterns.
// Hypothesis at this point: the "repetition" Shannan reports is actually
// pre-tool intent narration (round 1) showing alongside the tool answer (round 2)
// in the chat UI as two separate sam-msg divs — not literal text repetition.
//
// Tasks:
//   1. Date histogram of round-marker turns to see if pattern emerged recently
//   2. Categorize round-1 text into narration patterns
//   3. Check what round-2 includes (does it stand alone? or does it depend on round 1?)
//   4. Compute fraction of multi-round turns where round 1 is pure narration
//      vs. round 1 contains useful content the user would lose if suppressed

const fs = require('fs');
const rows = JSON.parse(fs.readFileSync('scripts/turn_logs.json', 'utf8'))[0].results;

const roundMarkerRows = rows.filter(r => r.response_excerpt && /\[round \d+\]/i.test(r.response_excerpt));
console.log(`Round-marker turns: ${roundMarkerRows.length} / ${rows.length}`);

// 1. Date histogram (by day)
const byDay = {};
for (const r of roundMarkerRows) {
  const day = (r.created_at || '').slice(0, 10);
  byDay[day] = (byDay[day] || 0) + 1;
}
console.log(`\n=== ROUND-MARKER TURNS BY DAY ===`);
for (const [d, c] of Object.entries(byDay).sort()) console.log(`  ${d}: ${c}`);

// 2. Extract round-1 vs round-2 text per row
const splitRounds = roundMarkerRows.map(r => {
  const txt = r.response_excerpt || '';
  const m = txt.split(/\[round \d+\]/i);
  const round1 = (m[0] || '').trim();
  const round2 = (m[1] || '').trim();
  return { id: r.id, created_at: r.created_at, user: r.user_message, round1, round2, raw: txt };
});

// 3. Round-1 narration pattern detection
const narrationPrefixes = [
  /^let me pull/i,
  /^let me look up/i,
  /^let me get/i,
  /^let me search/i,
  /^let me check/i,
  /^let me grab/i,
  /^let me verify/i,
  /^i need to look up/i,
  /^i'll look up/i,
  /^i'll pull/i,
  /^i'll search/i,
  /^i'll check/i,
  /^i'll verify/i,
  /^searching for/i,
  /^looking up/i,
  /^pulling/i,
  /^one moment/i,
  /^just a sec/i,
  /^got it.{0,40}let me/i,
  /^okay.{0,40}let me/i
];
function isPureNarration(round1) {
  if (!round1) return false;
  if (round1.length === 0) return false;
  // Pure narration if it matches one of the prefixes AND short (one sentence)
  const matchesPrefix = narrationPrefixes.some(re => re.test(round1));
  const sentenceCount = round1.split(/(?<=[.!?])\s+/).filter(s => s.trim().length > 0).length;
  return matchesPrefix && sentenceCount <= 2 && round1.length <= 250;
}
function round1Category(round1) {
  if (!round1 || round1.length === 0) return 'EMPTY';
  if (isPureNarration(round1)) return 'PURE_NARRATION';
  if (round1.length < 80) return 'SHORT';
  return 'CONTENT';
}

const categoryCounts = { EMPTY: 0, PURE_NARRATION: 0, SHORT: 0, CONTENT: 0 };
for (const r of splitRounds) {
  const cat = round1Category(r.round1);
  categoryCounts[cat]++;
  r.cat = cat;
}
console.log(`\n=== ROUND-1 CATEGORIES ===`);
for (const [k, v] of Object.entries(categoryCounts)) {
  console.log(`  ${k}: ${v} (${((v/splitRounds.length)*100).toFixed(1)}%)`);
}

// 4. Round-1 text samples by category
console.log(`\n=== PURE NARRATION ROUND-1 SAMPLES ===`);
const pure = splitRounds.filter(r => r.cat === 'PURE_NARRATION');
const seenSamples = new Set();
for (const r of pure) {
  const norm = r.round1.toLowerCase().slice(0, 80);
  if (seenSamples.has(norm)) continue;
  seenSamples.add(norm);
  console.log(`  - "${r.round1}"`);
  if (seenSamples.size >= 12) break;
}

console.log(`\n=== SHORT (non-narration) ROUND-1 SAMPLES ===`);
const short = splitRounds.filter(r => r.cat === 'SHORT');
const seenShort = new Set();
for (const r of short) {
  const norm = r.round1.toLowerCase().slice(0, 80);
  if (seenShort.has(norm)) continue;
  seenShort.add(norm);
  console.log(`  - "${r.round1}"`);
  if (seenShort.size >= 8) break;
}

console.log(`\n=== EMPTY ROUND-1 (Sam went straight to tool — ideal pattern) ===`);
console.log(`  Count: ${categoryCounts.EMPTY}`);
console.log(`  These rows have only round-2 content — no narration, single message to user.`);

console.log(`\n=== CONTENT ROUND-1 SAMPLES (round 1 had real content beyond narration) ===`);
const content = splitRounds.filter(r => r.cat === 'CONTENT');
for (const r of content.slice(0, 5)) {
  console.log(`  ID ${r.id} [${r.created_at}]`);
  console.log(`    User: "${(r.user || '').slice(0, 100)}"`);
  console.log(`    Round 1: "${r.round1.slice(0, 250)}"`);
  console.log(`    Round 2: "${r.round2.slice(0, 100)}..."`);
  console.log('');
}

// 5. Tool-call breakdown for round-marker turns
const toolCounts = {};
for (const r of roundMarkerRows) {
  let tools = [];
  try { tools = JSON.parse(r.tool_calls || '[]'); } catch (_) {}
  for (const t of tools) if (t && t.name) toolCounts[t.name] = (toolCounts[t.name] || 0) + 1;
}
console.log(`\n=== TOOLS IN ROUND-MARKER TURNS ===`);
for (const [k, v] of Object.entries(toolCounts).sort((a,b) => b[1]-a[1])) {
  console.log(`  ${k}: ${v}`);
}

// Save split rounds for follow-up
fs.writeFileSync('scripts/round_split.json', JSON.stringify(splitRounds, null, 2));
console.log(`\nSplit rounds saved: scripts/round_split.json`);
