// Renderer auto-link unit tests. Mirrors formatSamText's URL-handling
// chain in app.html. Identity stubs for stripCitations/cleanResearchNarration.
//
// Run: node scripts/test_renderer_autolink.js

function stripCitations(t) { return t; }
function cleanResearchNarration(t) { return t; }

function formatSamText(text) {
  var processed = stripCitations(cleanResearchNarration(text))
    .replace(/\[Actions taken:[^\]]*\]/gi, '')
    .replace(/\[Action:[^\]]*\]/gi, '')
    .replace(/\【\d+[:\d]*†?[a-z]*\】/g, '')
    .replace(/\[\d+\]/g, '')
    .replace(/\s*\.\s*\n/g, '.\n')
    .replace(/\n{3,}/g, '\n\n');

  function trimTrailing(s) {
    var trailing = '';
    while (s.length > 0 && /[.,;:!?)\]]/.test(s.slice(-1))) {
      trailing = s.slice(-1) + trailing;
      s = s.slice(0, -1);
    }
    return [s, trailing];
  }

  var anchors = [];
  function swapAnchors(s) {
    return s.replace(/<a\b[^>]*>[\s\S]*?<\/a>/g, function(m) {
      anchors.push(m);
      return '\u0000A' + (anchors.length - 1) + '\u0000';
    });
  }

  processed = processed.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
  );
  processed = swapAnchors(processed);

  processed = processed.replace(/https?:\/\/[^\s<>"']+/gi, function(url) {
    var parts = trimTrailing(url);
    return '<a href="' + parts[0] + '" target="_blank" rel="noopener noreferrer">' +
           parts[0] + '</a>' + parts[1];
  });
  processed = swapAnchors(processed);

  processed = processed.replace(
    /(?<![@\w])([a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)*\.(?:gov|com|org|net|edu|us|io|co|info|app))(\/[^\s<>"']*)?/gi,
    function(match) {
      var parts = trimTrailing(match);
      return '<a href="https://' + parts[0] + '" target="_blank" rel="noopener noreferrer">' +
             parts[0] + '</a>' + parts[1];
    }
  );

  processed = processed.replace(/\u0000A(\d+)\u0000/g, function(_, i) {
    return anchors[parseInt(i, 10)];
  });

  return processed
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\n/g, '<br>');
}

const cases = [
  // [name, input, must-contain, must-NOT-contain]
  ['markdown-link, no double-wrap',
    'Visit [DOE](https://dos.fl.gov/elections) for details.',
    ['<a href="https://dos.fl.gov/elections" target="_blank" rel="noopener noreferrer">DOE</a>'],
    ['<a href="https://https://', '<a href="https://dos.fl.gov/elections">dos.fl.gov']],

  ['bare URL with path',
    'Check dos.fl.gov/elections for the calendar.',
    ['<a href="https://dos.fl.gov/elections" target="_blank" rel="noopener noreferrer">dos.fl.gov/elections</a>'],
    ['<a href="https://https://']],

  ['schemed URL',
    'See https://dos.fl.gov/elections for info.',
    ['<a href="https://dos.fl.gov/elections" target="_blank" rel="noopener noreferrer">https://dos.fl.gov/elections</a>'],
    ['<a href="https://https://']],

  ['mixed format markdown + bare',
    'Try [DOE](https://dos.fl.gov) or call ocfelections.gov directly.',
    ['<a href="https://dos.fl.gov" target="_blank" rel="noopener noreferrer">DOE</a>',
     '<a href="https://ocfelections.gov" target="_blank" rel="noopener noreferrer">ocfelections.gov</a>'],
    []],

  ['statute reference does NOT auto-link',
    'See Section 106.141, F.S. for the rule.',
    ['Section 106.141, F.S.'],
    ['<a href']],

  ['version number does NOT auto-link',
    'Running v1.2.3 of the build.',
    ['v1.2.3'],
    ['<a href']],

  ['IP address does NOT auto-link',
    'Connect to 192.168.1.1 on port 8080.',
    ['192.168.1.1'],
    ['<a href']],

  ['email address does NOT auto-link (and does not break)',
    'Email greg@example.com or call 850-245-6100.',
    ['greg@example.com'],
    []],

  ['parenthesized bare domain (Sam pattern)',
    'Florida Division of Elections (dos.fl.gov/elections) — their results portal.',
    ['<a href="https://dos.fl.gov/elections" target="_blank" rel="noopener noreferrer">dos.fl.gov/elections</a>'],
    []],

  ['Source: prefix bare domain',
    '(Source: dos.fl.gov/elections/contacts/).',
    ['<a href="https://dos.fl.gov/elections/contacts/" target="_blank" rel="noopener noreferrer">dos.fl.gov/elections/contacts/</a>'],
    []],

  ['trailing period stripped from link',
    'See dos.fl.gov.',
    ['<a href="https://dos.fl.gov" target="_blank" rel="noopener noreferrer">dos.fl.gov</a>.'],
    ['<a href="https://dos.fl.gov." target="_blank"']],

  ['markdown bold preserved with link',
    '**Florida Division of Elections** (dos.fl.gov/elections) results portal.',
    ['<strong>Florida Division of Elections</strong>',
     '<a href="https://dos.fl.gov/elections" target="_blank" rel="noopener noreferrer">dos.fl.gov/elections</a>'],
    []],

  ['Co. (business abbreviation) does NOT auto-link',
    'Smith & Co. is reliable.',
    ['Smith & Co.'],
    ['<a href']],

  ['e.g. does NOT auto-link',
    'Try a state site, e.g. dos.fl.gov, for verification.',
    ['e.g.',
     '<a href="https://dos.fl.gov" target="_blank" rel="noopener noreferrer">dos.fl.gov</a>'],
    []],

  ['multiple URLs in one sentence',
    'See dos.fl.gov, fec.gov, and floridabar.org/public/lrs.',
    ['<a href="https://dos.fl.gov"',
     '<a href="https://fec.gov"',
     '<a href="https://floridabar.org/public/lrs"'],
    []],

  ['preserves bold and newlines',
    'Visit **dos.fl.gov** for **details**.\nAnd fec.gov too.',
    ['<strong>',
     '<br>',
     '<a href="https://dos.fl.gov"',
     '<a href="https://fec.gov"'],
    []],
];

let pass = 0, fail = 0;
const failures = [];

for (const [name, input, mustHave, mustNot] of cases) {
  const output = formatSamText(input);
  const missing = mustHave.filter(s => output.indexOf(s) === -1);
  const present = mustNot.filter(s => output.indexOf(s) !== -1);
  if (missing.length === 0 && present.length === 0) {
    console.log(`PASS — ${name}`);
    pass++;
  } else {
    console.log(`FAIL — ${name}`);
    console.log(`  input:  ${input}`);
    console.log(`  output: ${output}`);
    if (missing.length) console.log(`  missing: ${JSON.stringify(missing)}`);
    if (present.length) console.log(`  unwanted: ${JSON.stringify(present)}`);
    fail++;
    failures.push(name);
  }
}

console.log(`\nPass: ${pass}  Fail: ${fail}`);
if (fail > 0) {
  console.log(`Failed: ${failures.join(', ')}`);
  process.exit(1);
}
