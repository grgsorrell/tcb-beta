// Round 2 of P4 investigation. Findings from round 1 surfaced ONE row with
// repetition — but it's a strong signal: a Safe Mode banner appearing twice
// in the same response, separated by what looks like a "[round 2]" marker.
// Hypothesis: multi-round tool execution causes the safe-mode banner to be
// prepended on each round.
//
// This script looks for:
//   1. Safe-mode banner occurrences per response (flag any with 2+)
//   2. Literal "[round N]" markers in stored responses
//   3. Common phrase n-gram repetition with looser threshold
//   4. Paraphrase pattern with lower bar
//   5. Tool-call count vs response shape correlation

const fs = require('fs');
const rows = JSON.parse(fs.readFileSync('scripts/turn_logs.json', 'utf8'))[0].results;

console.log(`Loaded ${rows.length} rows`);

// 1. Safe-mode banner detection
const SAFE_MODE_FRAGMENTS = [
  'heads up',
  'ive had trouble verifying',
  'double-check anything specific',
  'before acting on it'
];
function countSafeModeOccurrences(text) {
  if (!text) return 0;
  const lc = text.toLowerCase();
  // The banner contains "double-check anything specific" — count those.
  const re = /double-check anything specific/g;
  const m = lc.match(re);
  return m ? m.length : 0;
}

// 2. Round marker detection
function countRoundMarkers(text) {
  if (!text) return 0;
  const m = text.match(/\[round \d+\]/gi);
  return m ? m.length : 0;
}

// 3. Multi-paragraph "got it" / "okay" acknowledgment repetition
function countAckOpeners(text) {
  if (!text) return 0;
  const re = /^(got it|okay|sure|of course|alright|let me)\b/gim;
  const m = text.match(re);
  return m ? m.length : 0;
}

// 4. Paragraph-level repetition: split by blank lines, find duplicate paragraphs
function findDuplicateParagraphs(text) {
  if (!text) return [];
  const paras = text.split(/\n\s*\n/).map(p => p.trim()).filter(p => p.length >= 40);
  const norm = p => p.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
  const seen = new Map();
  const dups = [];
  for (let i = 0; i < paras.length; i++) {
    const n = norm(paras[i]);
    if (seen.has(n)) dups.push({ first: seen.get(n), second: i, text: paras[i].slice(0, 200) });
    else seen.set(n, i);
  }
  return dups;
}

// 5. Near-paragraph duplicates (Jaccard on word sets)
function jaccardSim(a, b) {
  const wa = new Set(a.toLowerCase().split(/\s+/).filter(w => w.length >= 3));
  const wb = new Set(b.toLowerCase().split(/\s+/).filter(w => w.length >= 3));
  if (wa.size === 0 || wb.size === 0) return 0;
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter++;
  return inter / (wa.size + wb.size - inter);
}
function findNearDuplicateParagraphs(text) {
  if (!text) return [];
  const paras = text.split(/\n\s*\n/).map(p => p.trim()).filter(p => p.length >= 60);
  const out = [];
  for (let i = 0; i < paras.length; i++) {
    for (let j = i + 1; j < paras.length; j++) {
      const sim = jaccardSim(paras[i], paras[j]);
      if (sim >= 0.6) {
        out.push({ i, j, sim: sim.toFixed(2), a: paras[i].slice(0, 180), b: paras[j].slice(0, 180) });
      }
    }
  }
  return out;
}

// Run all checks
const findings = rows.map(r => {
  const text = r.response_excerpt || '';
  const safeModeCount = countSafeModeOccurrences(text);
  const roundMarkers = countRoundMarkers(text);
  const ackOpeners = countAckOpeners(text);
  const dupParas = findDuplicateParagraphs(text);
  const nearDupParas = findNearDuplicateParagraphs(text);
  let toolCalls = [];
  try { toolCalls = JSON.parse(r.tool_calls || '[]'); } catch (_) {}
  const toolNames = (toolCalls || []).map(t => t && t.name).filter(Boolean);
  const wasTruncated = text.endsWith('…');
  return {
    id: r.id,
    created_at: r.created_at,
    user_message: r.user_message,
    response: text,
    safeModeCount,
    roundMarkers,
    ackOpeners,
    dupParas,
    nearDupParas,
    toolNames,
    toolCount: toolNames.length,
    wasTruncated,
    respLen: text.length,
    flagged: !!(safeModeCount >= 2 || roundMarkers >= 1 || dupParas.length > 0 || nearDupParas.length > 0 || ackOpeners >= 2)
  };
});

const flagged = findings.filter(f => f.flagged);
const total = findings.length;

console.log(`\n=== EXTENDED PATTERN STATS ===`);
console.log(`Total turns:                                 ${total}`);
console.log(`Safe Mode banner appears 2+ times:           ${findings.filter(f => f.safeModeCount >= 2).length}`);
console.log(`Safe Mode banner appears 1+ times (any):     ${findings.filter(f => f.safeModeCount >= 1).length}`);
console.log(`Has "[round N]" marker(s):                   ${findings.filter(f => f.roundMarkers >= 1).length}`);
console.log(`Has 2+ acknowledgment openers (Got it/etc):  ${findings.filter(f => f.ackOpeners >= 2).length}`);
console.log(`Has duplicate paragraph (exact match):       ${findings.filter(f => f.dupParas.length > 0).length}`);
console.log(`Has near-duplicate paragraph (Jaccard >=0.6): ${findings.filter(f => f.nearDupParas.length > 0).length}`);
console.log(`---`);
console.log(`ANY flag triggered:                          ${flagged.length} (${((flagged.length/total)*100).toFixed(1)}%)`);
console.log(`Truncated at 800:                            ${findings.filter(f => f.wasTruncated).length}`);

// Tool correlation among flagged
const flaggedWithTools = flagged.filter(f => f.toolCount > 0);
const flaggedNoTools = flagged.filter(f => f.toolCount === 0);
console.log(`\n=== FLAGGED TOOL DISTRIBUTION ===`);
console.log(`Flagged + had tools:    ${flaggedWithTools.length} / ${flagged.length}`);
console.log(`Flagged + no tools:     ${flaggedNoTools.length} / ${flagged.length}`);

// Print one example per flag type
console.log(`\n\n=== EXAMPLES BY PATTERN TYPE ===`);

function printExample(f, label) {
  console.log(`\n--- ${label} ---`);
  console.log(`ID: ${f.id}    Time: ${f.created_at}`);
  console.log(`Tools: ${f.toolNames.join(', ') || 'none'}    Truncated: ${f.wasTruncated}    Length: ${f.respLen}`);
  console.log(`User: ${f.user_message ? f.user_message.slice(0, 120) : '(null)'}`);
  console.log(`Response:\n${f.response}`);
  console.log(`Counts: safeMode=${f.safeModeCount} roundMarkers=${f.roundMarkers} ackOpeners=${f.ackOpeners} dupParas=${f.dupParas.length} nearDupParas=${f.nearDupParas.length}`);
  if (f.dupParas.length > 0) console.log(`  Dup paragraph: "${f.dupParas[0].text}" at indices ${f.dupParas[0].first}, ${f.dupParas[0].second}`);
  if (f.nearDupParas.length > 0) console.log(`  Near-dup pair (sim ${f.nearDupParas[0].sim}):\n    A: "${f.nearDupParas[0].a}"\n    B: "${f.nearDupParas[0].b}"`);
}

const safeMode2Plus = findings.filter(f => f.safeModeCount >= 2);
const roundMarkerExamples = findings.filter(f => f.roundMarkers >= 1);
const ackOpenerExamples = findings.filter(f => f.ackOpeners >= 2);
const dupParaExamples = findings.filter(f => f.dupParas.length > 0);
const nearDupParaExamples = findings.filter(f => f.nearDupParas.length > 0);

console.log(`\n# Safe Mode banner 2+ examples (${safeMode2Plus.length} total):`);
safeMode2Plus.slice(0, 3).forEach((f, i) => printExample(f, `SafeMode#${i+1}`));

console.log(`\n# [round N] marker examples (${roundMarkerExamples.length} total):`);
roundMarkerExamples.slice(0, 2).forEach((f, i) => printExample(f, `RoundMarker#${i+1}`));

console.log(`\n# 2+ acknowledgment opener examples (${ackOpenerExamples.length} total):`);
ackOpenerExamples.slice(0, 3).forEach((f, i) => printExample(f, `AckOpener#${i+1}`));

console.log(`\n# Duplicate paragraph examples (${dupParaExamples.length} total):`);
dupParaExamples.slice(0, 3).forEach((f, i) => printExample(f, `DupPara#${i+1}`));

console.log(`\n# Near-duplicate paragraph examples (${nearDupParaExamples.length} total):`);
nearDupParaExamples.slice(0, 3).forEach((f, i) => printExample(f, `NearDup#${i+1}`));

fs.writeFileSync('scripts/flagged_turns2.json', JSON.stringify(flagged, null, 2));
console.log(`\nFlagged rows saved: scripts/flagged_turns2.json (${flagged.length} rows)`);
