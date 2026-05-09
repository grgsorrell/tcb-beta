// import_campaign_reference.mjs
//
// Reads a JSON array of campaign reference rows, validates against the
// schema, generates a SQL file with multi-row UPSERT INSERTs, and prints
// the wrangler command to apply.
//
// Usage:
//   node scripts/import_campaign_reference.mjs path/to/rows.json
//
// Output:
//   - Validation report (rejected rows + reasons)
//   - Generated SQL at <input>.sql
//   - Batch ID for the run (stamped on every row)
//   - wrangler command to execute the SQL
//   - Rollback command to revert just this batch
//
// IDEMPOTENCY MODEL — read before re-importing:
//
// Deterministic id = sha256(state + '|' + question.toLowerCase().trim()).slice(0, 16).
// Re-importing the same JSON updates existing rows via ON CONFLICT(id) DO UPDATE.
// The id is stable across re-imports IF the question text is identical.
//
// AWARENESS — the deterministic-id quirk:
//   If a row's `question` text is reworded in a future batch (e.g., typo
//   fix, light rephrasing), the new wording produces a NEW id, and the
//   import creates a parallel row instead of updating the prior one.
//   The old row stays in the table with its old import_batch_id.
//
//   This is acceptable for V1 — manual review will catch parallel rows
//   when re-importing. Mitigations if it becomes painful:
//     (a) Check sql diff before applying re-imports; spot reworded questions
//     (b) Manually DELETE old row by id before applying the new batch
//     (c) Future: add a `canonical_question_id` field that survives wording changes
//
//   Greg flagged this in the 2026-05-09 review. Don't get surprised.

import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, extname } from 'node:path';

const REQUIRED_FIELDS = [
  'state', 'office_level', 'category', 'question', 'answer',
  'source_url', 'last_verified_date', 'update_frequency', 'verification_method'
];

const ALLOWED_CATEGORIES = [
  'ballot_access', 'finance_ethics', 'voter_interaction', 'election_dates',
  'residency', 'filing_requirements', 'redistricting', 'runoff_rules',
  'recall_rules', 'candidate_eligibility'
];

const ALLOWED_UPDATE_FREQ = ['static', 'per_cycle', 'volatile'];
const ALLOWED_VERIFICATION = ['official_source_direct', 'secondary_source', 'statute_citation'];

function deterministicId(state, question) {
  const key = String(state).toUpperCase() + '|' + String(question).toLowerCase().trim();
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

function sqlEscape(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return String(value);
  return "'" + String(value).replace(/'/g, "''") + "'";
}

function validateRow(row, idx) {
  const errors = [];
  for (const field of REQUIRED_FIELDS) {
    if (row[field] === undefined || row[field] === null || row[field] === '') {
      errors.push(`row ${idx}: missing required field "${field}"`);
    }
  }
  if (row.category && !ALLOWED_CATEGORIES.includes(row.category)) {
    errors.push(`row ${idx}: invalid category "${row.category}" (allowed: ${ALLOWED_CATEGORIES.join(', ')})`);
  }
  if (row.update_frequency && !ALLOWED_UPDATE_FREQ.includes(row.update_frequency)) {
    errors.push(`row ${idx}: invalid update_frequency "${row.update_frequency}" (allowed: ${ALLOWED_UPDATE_FREQ.join(', ')})`);
  }
  if (row.verification_method && !ALLOWED_VERIFICATION.includes(row.verification_method)) {
    errors.push(`row ${idx}: invalid verification_method "${row.verification_method}" (allowed: ${ALLOWED_VERIFICATION.join(', ')})`);
  }
  if (row.state && (typeof row.state !== 'string' || !/^[A-Za-z]{2}$/.test(row.state))) {
    errors.push(`row ${idx}: state must be 2-letter code, got "${row.state}"`);
  }
  if (row.last_verified_date && !/^\d{4}-\d{2}-\d{2}/.test(row.last_verified_date)) {
    errors.push(`row ${idx}: last_verified_date must be ISO YYYY-MM-DD, got "${row.last_verified_date}"`);
  }
  if (row.office_level !== undefined && !Array.isArray(row.office_level) && typeof row.office_level !== 'string') {
    errors.push(`row ${idx}: office_level must be array or JSON-string array`);
  }
  if (row.question_variants !== undefined && row.question_variants !== null && !Array.isArray(row.question_variants) && typeof row.question_variants !== 'string') {
    errors.push(`row ${idx}: question_variants must be array, JSON-string, or null`);
  }
  return errors;
}

function normalizeRow(row, batchId) {
  const officeLevel = Array.isArray(row.office_level) ? JSON.stringify(row.office_level) : String(row.office_level);
  const questionVariants = (row.question_variants === undefined || row.question_variants === null)
    ? null
    : (Array.isArray(row.question_variants) ? JSON.stringify(row.question_variants) : String(row.question_variants));
  return {
    id: deterministicId(row.state, row.question),
    state: row.state.toUpperCase(),
    office_level: officeLevel,
    category: row.category,
    question: row.question,
    question_variants: questionVariants,
    answer: row.answer,
    source_url: row.source_url,
    source_name: row.source_name || null,
    last_verified_date: row.last_verified_date,
    update_frequency: row.update_frequency,
    verification_method: row.verification_method,
    scope: row.scope || null,
    import_batch_id: batchId
  };
}

// === MAIN ===
const inputPath = process.argv[2];
if (!inputPath) {
  console.error('Usage: node scripts/import_campaign_reference.mjs <path-to-json-file>');
  process.exit(1);
}

let raw;
try {
  raw = JSON.parse(readFileSync(inputPath, 'utf8'));
} catch (e) {
  console.error('Failed to read/parse JSON:', e.message);
  process.exit(1);
}
const rows = Array.isArray(raw) ? raw : [raw];
console.log(`Loaded ${rows.length} rows from ${inputPath}`);

const errors = [];
const validRows = [];
for (let i = 0; i < rows.length; i++) {
  const errs = validateRow(rows[i], i);
  if (errs.length > 0) errors.push(...errs);
  else validRows.push(rows[i]);
}

if (errors.length > 0) {
  console.error(`\n${errors.length} validation issues:`);
  for (const e of errors) console.error('  ' + e);
  if (validRows.length === 0) {
    console.error('\nNo valid rows. Aborting (no SQL written).');
    process.exit(1);
  }
  console.error(`\n${validRows.length} valid rows will be imported. ${rows.length - validRows.length} rejected.\n`);
}

const batchId = 'batch_' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '_' + basename(inputPath, extname(inputPath));

const normalized = validRows.map(r => normalizeRow(r, batchId));

// Dedupe within this import (deterministic id collisions = same state+question)
const uniqueById = new Map();
for (const r of normalized) {
  if (uniqueById.has(r.id)) {
    console.warn(`Duplicate id ${r.id} (state=${r.state}, question="${r.question.slice(0, 60)}..."); keeping last`);
  }
  uniqueById.set(r.id, r);
}
const uniqueRows = [...uniqueById.values()];

const COLUMNS = ['id', 'state', 'office_level', 'category', 'question', 'question_variants', 'answer', 'source_url', 'source_name', 'last_verified_date', 'update_frequency', 'verification_method', 'scope', 'import_batch_id'];
const BATCH_SIZE = 50;

const lines = [];
lines.push('-- Generated by import_campaign_reference.mjs');
lines.push(`-- Source: ${inputPath}`);
lines.push(`-- Batch ID: ${batchId}`);
lines.push(`-- Rows: ${uniqueRows.length}`);
lines.push(`-- Generated: ${new Date().toISOString()}`);
lines.push('');

for (let i = 0; i < uniqueRows.length; i += BATCH_SIZE) {
  const batch = uniqueRows.slice(i, i + BATCH_SIZE);
  lines.push(`INSERT INTO campaign_reference (${COLUMNS.join(', ')}) VALUES`);
  const valueLines = batch.map((r, j) => {
    const vals = COLUMNS.map(c => sqlEscape(r[c])).join(', ');
    return '  (' + vals + ')' + (j < batch.length - 1 ? ',' : '');
  });
  lines.push(valueLines.join('\n'));
  lines.push('ON CONFLICT(id) DO UPDATE SET');
  lines.push('  office_level = excluded.office_level,');
  lines.push('  category = excluded.category,');
  lines.push('  question = excluded.question,');
  lines.push('  question_variants = excluded.question_variants,');
  lines.push('  answer = excluded.answer,');
  lines.push('  source_url = excluded.source_url,');
  lines.push('  source_name = excluded.source_name,');
  lines.push('  last_verified_date = excluded.last_verified_date,');
  lines.push('  update_frequency = excluded.update_frequency,');
  lines.push('  verification_method = excluded.verification_method,');
  lines.push('  scope = excluded.scope,');
  lines.push('  import_batch_id = excluded.import_batch_id,');
  lines.push("  updated_at = datetime('now');");
  lines.push('');
}

const outputPath = inputPath.replace(/\.json$/i, '.sql');
writeFileSync(outputPath, lines.join('\n'));

console.log('');
console.log(`Wrote ${uniqueRows.length} rows to ${outputPath}`);
console.log(`Batch ID: ${batchId}`);
console.log('');
console.log('Apply (idempotent — re-running updates rows in place):');
console.log(`  wrangler d1 execute candidates-toolbox-db --remote --file=${outputPath}`);
console.log('');
console.log('Rollback this batch only:');
console.log(`  wrangler d1 execute candidates-toolbox-db --remote --command="DELETE FROM campaign_reference WHERE import_batch_id = '${batchId}';"`);
