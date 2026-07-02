#!/usr/bin/env node
// Prompt word-budget guard (Phase 2 of the sam-overhaul).
//
// Replaces the stale CLAUDE.md `sed | wc -w` check (which asserted an
// "under 800 words" base prompt that was actually ~8,700). Checks each Sam
// prompt module against a per-module budget AND the combined static base
// assembly against the 2,500-word ceiling. Exits non-zero (fails loudly) on
// any breach so it can gate a pre-deploy check.
//
// Run: node scripts/check_prompt_budget.mjs

import {
  MODULE_IDENTITY,
  MODULE_TRUST_LADDER,
  MODULE_HARD_CONSTRAINTS,
  MODULE_TOOL_GUIDANCE,
} from '../lib/sam_prompt_modules.mjs';

const words = (s) => (s.trim().match(/\S+/g) || []).length;

// Per-module budgets. Base assembly = identity + ladder + constraints + tool
// guidance, and must stay under 2,500 words (the volatile per-turn ground-truth
// block is appended separately in worker.js and is NOT counted here).
const BUDGETS = {
  MODULE_IDENTITY: 450,
  MODULE_TRUST_LADDER: 500,
  MODULE_HARD_CONSTRAINTS: 1050,
  MODULE_TOOL_GUIDANCE: 600,
};
const BASE_TOTAL_BUDGET = 2500;

const modules = {
  MODULE_IDENTITY,
  MODULE_TRUST_LADDER,
  MODULE_HARD_CONSTRAINTS,
  MODULE_TOOL_GUIDANCE,
};

let failed = false;
let total = 0;
console.log('Prompt module word budgets:');
for (const [name, text] of Object.entries(modules)) {
  const w = words(text);
  total += w;
  const budget = BUDGETS[name];
  const ok = w <= budget;
  if (!ok) failed = true;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${name}: ${w} / ${budget}`);
}
const totalOk = total <= BASE_TOTAL_BUDGET;
if (!totalOk) failed = true;
console.log(`  ${totalOk ? 'OK  ' : 'FAIL'} BASE ASSEMBLY TOTAL: ${total} / ${BASE_TOTAL_BUDGET}`);

if (failed) {
  console.error('\nPROMPT BUDGET EXCEEDED — trim a module before shipping.');
  process.exit(1);
}
console.log('\nAll prompt budgets OK.');
