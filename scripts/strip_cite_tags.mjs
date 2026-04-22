// One-off cleanup: read the JSON dumped by `wrangler d1 execute --json` and
// write a .sql file with UPDATE statements that strip <cite...> wrappers from
// each affected opponents.data blob. Run:
//   wrangler d1 execute candidates-toolbox-db --remote --json \
//     --command "SELECT id, data FROM opponents WHERE data LIKE '%<cite%' OR data LIKE '%</cite%'" \
//     > /tmp/opps_with_tags.json
//   node scripts/strip_cite_tags.mjs /tmp/opps_with_tags.json /tmp/strip_cite_tags.sql
//   wrangler d1 execute candidates-toolbox-db --remote --file /tmp/strip_cite_tags.sql
import fs from 'fs';

const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) {
  console.error('usage: node strip_cite_tags.mjs <input.json> <output.sql>');
  process.exit(1);
}

const raw = fs.readFileSync(inPath, 'utf8');
const parsed = JSON.parse(raw);
const rows = parsed[0]?.results || [];

function stripCiteTags(s) {
  if (typeof s !== 'string') return s;
  return s
    .replace(/<cite\b[^>]*>([\s\S]*?)<\/cite>/gi, '$1')
    .replace(/<\/?cite\b[^>]*>/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

const stringFields = ['party', 'office', 'bio', 'background', 'recentNews', 'campaignFocus', 'keyRisk'];
let cleaned = 0;
const statements = [];
for (const row of rows) {
  let card;
  try { card = JSON.parse(row.data); } catch { continue; }
  let changed = false;
  for (const f of stringFields) {
    if (typeof card[f] === 'string') {
      const newVal = stripCiteTags(card[f]);
      if (newVal !== card[f]) { card[f] = newVal; changed = true; }
    }
  }
  if (!changed) continue;
  cleaned++;
  // SQL single-quote escape
  const newBlob = JSON.stringify(card).replace(/'/g, "''");
  statements.push(`UPDATE opponents SET data = '${newBlob}' WHERE id = '${row.id}';`);
}

fs.writeFileSync(outPath, statements.join('\n') + '\n');
console.log(`Processed ${rows.length} rows, ${cleaned} need updates. Wrote ${outPath}`);
