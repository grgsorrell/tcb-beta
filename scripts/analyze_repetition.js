// P4 investigation: detect repetition patterns in Sam's responses.
// One-shot analysis script — read sam_turn_logs JSON dump, score repetition,
// categorize patterns, surface examples.
//
// Repetition heuristics (run independently per response):
//   1. EXACT sentence duplicate — same normalized sentence appears 2+ times
//   2. NEAR sentence duplicate — Levenshtein <= 20% of length, len >= 30 chars
//   3. NGRAM repeat — same 8-word run appears 2+ times
//   4. BULLET duplicate — same bullet line appears 2+ times
//
// Each row gets a flags object {exact, near, ngram, bullet} + the matched text.

const fs = require('fs');

const raw = fs.readFileSync('scripts/turn_logs.json', 'utf8');
const parsed = JSON.parse(raw);
const rows = parsed[0].results;

console.log(`Loaded ${rows.length} rows`);
console.log(`Date range: ${rows[rows.length-1].created_at} → ${rows[0].created_at}`);

function normalize(s) {
  return (s || '').toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
}

function splitSentences(text) {
  if (!text) return [];
  // Split on sentence boundaries; keep newlines as splits too
  const parts = text.split(/(?<=[.!?])\s+|\n+/).map(s => s.trim()).filter(s => s.length > 0);
  return parts;
}

function splitBullets(text) {
  if (!text) return [];
  const lines = text.split(/\n/).map(l => l.trim());
  return lines.filter(l => /^[-•*]\s+|^\d+[.)]\s+/.test(l));
}

function levenshtein(a, b, max) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1));
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i-1] === b[j-1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i-1][j] + 1, dp[i][j-1] + 1, dp[i-1][j-1] + cost);
    }
  }
  return dp[a.length][b.length];
}

function detectRepetition(text) {
  const flags = { exact: null, near: null, ngram: null, bullet: null };
  if (!text || text.length < 60) return flags;

  // Strip the trailing "…" from truncation marker
  const work = text.replace(/…$/, '');

  // 1. EXACT sentence duplicate
  const sentences = splitSentences(work);
  const sentNorms = sentences.map(normalize).filter(s => s.length >= 20);
  const seenSent = new Map();
  for (let i = 0; i < sentNorms.length; i++) {
    const s = sentNorms[i];
    if (seenSent.has(s)) {
      flags.exact = { text: sentences[i].slice(0, 200), positions: [seenSent.get(s), i] };
      break;
    }
    seenSent.set(s, i);
  }

  // 2. NEAR sentence duplicate (skip if exact already found — exact is stronger signal)
  if (!flags.exact) {
    for (let i = 0; i < sentNorms.length && !flags.near; i++) {
      for (let j = i + 1; j < sentNorms.length; j++) {
        const a = sentNorms[i], b = sentNorms[j];
        if (a.length < 30 || b.length < 30) continue;
        const max = Math.floor(Math.min(a.length, b.length) * 0.20);
        if (max < 4) continue;
        if (levenshtein(a, b, max) <= max) {
          flags.near = { a: sentences[i].slice(0, 200), b: sentences[j].slice(0, 200) };
          break;
        }
      }
    }
  }

  // 3. NGRAM repeat — 8-word runs
  const wordsNorm = normalize(work).split(' ').filter(Boolean);
  if (wordsNorm.length >= 16) {
    const seenGram = new Map();
    for (let i = 0; i + 8 <= wordsNorm.length; i++) {
      const g = wordsNorm.slice(i, i + 8).join(' ');
      if (seenGram.has(g)) {
        flags.ngram = { gram: g, positions: [seenGram.get(g), i] };
        break;
      }
      seenGram.set(g, i);
    }
  }

  // 4. BULLET duplicate
  const bullets = splitBullets(work);
  const bulletNorms = bullets.map(normalize).filter(b => b.length >= 15);
  const seenBul = new Map();
  for (let i = 0; i < bulletNorms.length; i++) {
    if (seenBul.has(bulletNorms[i])) {
      flags.bullet = { text: bullets[i].slice(0, 200) };
      break;
    }
    seenBul.set(bulletNorms[i], i);
  }

  return flags;
}

// Analyze every row
const results = rows.map(r => {
  const flags = detectRepetition(r.response_excerpt);
  let toolCalls = [];
  try { toolCalls = JSON.parse(r.tool_calls || '[]'); } catch (_) {}
  const toolNames = (toolCalls || []).map(t => t && t.name).filter(Boolean);
  const wasTruncated = r.response_excerpt && r.response_excerpt.endsWith('…');
  const hasAnyFlag = !!(flags.exact || flags.near || flags.ngram || flags.bullet);
  return {
    id: r.id,
    created_at: r.created_at,
    user_message: r.user_message,
    response: r.response_excerpt,
    flags,
    hasAnyFlag,
    toolNames,
    toolCount: toolNames.length,
    wasTruncated,
    respLen: (r.response_excerpt || '').length
  };
});

// Stats
const total = results.length;
const flaggedExact = results.filter(r => r.flags.exact).length;
const flaggedNear = results.filter(r => r.flags.near).length;
const flaggedNgram = results.filter(r => r.flags.ngram).length;
const flaggedBullet = results.filter(r => r.flags.bullet).length;
const flaggedAny = results.filter(r => r.hasAnyFlag).length;
const truncatedCount = results.filter(r => r.wasTruncated).length;
const truncatedAndFlagged = results.filter(r => r.wasTruncated && r.hasAnyFlag).length;

console.log(`\n=== STATS ===`);
console.log(`Total turns:            ${total}`);
console.log(`Truncated at 800 chars: ${truncatedCount} (${((truncatedCount/total)*100).toFixed(1)}%)`);
console.log(`\nFlagged any pattern:    ${flaggedAny} (${((flaggedAny/total)*100).toFixed(1)}%)`);
console.log(`  - Exact sentence dup: ${flaggedExact}`);
console.log(`  - Near sentence dup:  ${flaggedNear}`);
console.log(`  - 8-word ngram dup:   ${flaggedNgram}`);
console.log(`  - Bullet dup:         ${flaggedBullet}`);
console.log(`Flagged AND truncated:  ${truncatedAndFlagged} (these may have additional repetition past 800-char window)`);

// Tool-call breakdown for flagged rows
const flaggedRows = results.filter(r => r.hasAnyFlag);
const toolCounts = {};
for (const r of flaggedRows) {
  for (const t of r.toolNames) toolCounts[t] = (toolCounts[t] || 0) + 1;
}
console.log(`\n=== TOOLS USED IN FLAGGED TURNS ===`);
for (const [k, v] of Object.entries(toolCounts).sort((a,b) => b[1]-a[1])) {
  console.log(`  ${k}: ${v}`);
}

// Multi-tool vs single-tool vs no-tool flagged
const noToolFlagged = flaggedRows.filter(r => r.toolCount === 0).length;
const oneToolFlagged = flaggedRows.filter(r => r.toolCount === 1).length;
const multiToolFlagged = flaggedRows.filter(r => r.toolCount >= 2).length;
console.log(`\nFlagged turns by tool count:`);
console.log(`  no tools:       ${noToolFlagged}`);
console.log(`  exactly 1 tool: ${oneToolFlagged}`);
console.log(`  2+ tools:       ${multiToolFlagged}`);

// Examples — pick 5 spanning categories
console.log(`\n=== TOP EXAMPLES (most distinctive per category) ===`);

function showRow(r, label) {
  console.log(`\n--- ${label} ---`);
  console.log(`ID: ${r.id}`);
  console.log(`When: ${r.created_at}`);
  console.log(`Tools used: ${r.toolNames.join(', ') || 'none'}`);
  console.log(`Truncated: ${r.wasTruncated}`);
  console.log(`User asked: ${r.user_message ? r.user_message.slice(0, 150) : '(null)'}`);
  console.log(`Response (${r.respLen} chars):`);
  console.log(r.response);
  console.log(`Flags:`);
  if (r.flags.exact) console.log(`  EXACT DUP: "${r.flags.exact.text}" at sentence indices ${r.flags.exact.positions.join(', ')}`);
  if (r.flags.near) console.log(`  NEAR DUP:\n    A: "${r.flags.near.a}"\n    B: "${r.flags.near.b}"`);
  if (r.flags.ngram) console.log(`  8-WORD REPEAT: "${r.flags.ngram.gram}" at word indices ${r.flags.ngram.positions.join(', ')}`);
  if (r.flags.bullet) console.log(`  BULLET DUP: "${r.flags.bullet.text}"`);
}

const exactExamples = results.filter(r => r.flags.exact).slice(0, 2);
const nearExamples = results.filter(r => r.flags.near && !r.flags.exact).slice(0, 2);
const ngramExamples = results.filter(r => r.flags.ngram && !r.flags.exact && !r.flags.near).slice(0, 1);
const bulletExamples = results.filter(r => r.flags.bullet && !r.flags.exact && !r.flags.near && !r.flags.ngram).slice(0, 1);

let counter = 1;
for (const r of exactExamples) showRow(r, `Example ${counter++}: EXACT sentence duplicate`);
for (const r of nearExamples) showRow(r, `Example ${counter++}: NEAR sentence duplicate (paraphrase)`);
for (const r of ngramExamples) showRow(r, `Example ${counter++}: 8-word phrase repeat`);
for (const r of bulletExamples) showRow(r, `Example ${counter++}: bullet point duplicate`);

// Save flagged for follow-up
fs.writeFileSync('scripts/flagged_turns.json', JSON.stringify(flaggedRows, null, 2));
console.log(`\nFlagged rows saved to scripts/flagged_turns.json (${flaggedRows.length} rows)`);
