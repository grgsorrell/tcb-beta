#!/usr/bin/env node
// Standalone live-API test for the Phase 3 escape-hatch round-trip shape.
// NO worker imports — self-contained. Verifies against the real Gemini API
// that the exact functionResponse shape runGroundingSubturn produces is
// accepted, and that the model can still call an action tool afterward.
//
// Run:
//   GEMINI_API_KEY=... node scripts/test_gemini_functionresponse.mjs
// (PowerShell:  $env:GEMINI_API_KEY="..."; node scripts/test_gemini_functionresponse.mjs)
//
// Exit 0 = PASS, non-zero = FAIL (raw error body printed on failure).

const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) {
  console.error('FAIL: GEMINI_API_KEY not set in environment.');
  console.error('Run:  GEMINI_API_KEY=... node scripts/test_gemini_functionresponse.mjs');
  process.exit(2);
}

const MODEL = 'gemini-2.5-flash';
const URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`;

// The exact two tools an action-route turn exposes for this test: the escape
// hatch + one dummy action tool (stands in for save_note etc.).
const TOOLS = [{
  functionDeclarations: [
    {
      name: 'request_web_search',
      description: 'Fetch live web information via Google Search when the answer requires current data not present in your verified blocks or tools. Use for news, election results, current officeholders, live facts.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The search query for the live web lookup.' },
          reason: { type: 'string', description: 'One short phrase: why this live lookup is needed.' }
        },
        required: ['query', 'reason']
      }
    },
    {
      name: 'record_action',
      description: 'Record a one-sentence summary note for the campaign. Call this to save a note the user asked for.',
      parameters: {
        type: 'object',
        properties: { summary: { type: 'string', description: 'The one-sentence summary to save.' } },
        required: ['summary']
      }
    }
  ]
}];

const GEN_CONFIG = { temperature: 0.2, maxOutputTokens: 2000, thinkingConfig: { thinkingBudget: 0 } };
const SYS = { parts: [{ text: 'You are a campaign assistant with a full toolset. For any live/current information you MUST call request_web_search first. After you receive search results, call record_action to save a one-sentence summary. Never claim you cannot search.' }] };

async function generate(contents) {
  const resp = await fetch(URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ systemInstruction: SYS, contents, tools: TOOLS, generationConfig: GEN_CONFIG })
  });
  const status = resp.status;
  const data = await resp.json();
  return { status, data };
}

function functionCalls(data) {
  const parts = data?.candidates?.[0]?.content?.parts || [];
  return parts.filter(p => p.functionCall).map(p => p.functionCall);
}

function fail(msg, data) {
  console.error('FAIL: ' + msg);
  if (data !== undefined) console.error('Raw response body:\n' + JSON.stringify(data, null, 2));
  process.exit(1);
}

(async () => {
  // ---- Round 1: expect a request_web_search functionCall ----
  const prompt = "What's the very latest news on the 2026 Florida state elections? You must use request_web_search to find out. After you have results, save a one-sentence summary with record_action.";
  let contents = [{ role: 'user', parts: [{ text: prompt }] }];

  const r1 = await generate(contents);
  if (r1.status !== 200 || r1.data.error) fail('Round 1 (initial call) was rejected (HTTP ' + r1.status + ').', r1.data);
  const calls1 = functionCalls(r1.data);
  const searchCall = calls1.find(c => c.name === 'request_web_search');
  if (!searchCall) {
    fail('Round 1 did not trigger a request_web_search call (got: ' + (calls1.map(c => c.name).join(', ') || 'text only') + '). Prompt may need tuning, but the round-trip shape below is the real test.', r1.data);
  }
  console.log('Round 1 OK: model called request_web_search(query=' + JSON.stringify(searchCall.args?.query) + ').');

  // ---- Feed back a functionResponse in the EXACT runGroundingSubturn shape ----
  // runGroundingSubturn returns { excerpt, sources }; callClaude wraps it as
  // { functionResponse: { name:'request_web_search', response: { excerpt, sources } } }
  // in a user-role turn, appended after the model turn.
  const modelParts = r1.data.candidates[0].content.parts;
  const fnResponse = {
    functionResponse: {
      name: 'request_web_search',
      response: {
        excerpt: 'DUMMY GROUNDING RESULT: As of this test, the top item is a placeholder headline about the 2026 Florida primary calendar. (source below)',
        sources: ['https://example.com/florida-2026-elections']
      }
    }
  };
  contents = contents.concat(
    [{ role: 'model', parts: modelParts }],
    [{ role: 'user', parts: [fnResponse] }]
  );

  // ---- Round 2: the KEY assertion — functionResponse shape accepted ----
  const r2 = await generate(contents);
  if (r2.status !== 200 || r2.data.error) {
    fail('Round 2 (functionResponse feed-back) was REJECTED — the escape-hatch shape is wrong (HTTP ' + r2.status + ').', r2.data);
  }
  if (!r2.data.candidates || r2.data.candidates.length === 0) {
    fail('Round 2 returned no candidates.', r2.data);
  }
  console.log('Round 2 OK: functionResponse round-trip accepted (HTTP 200, candidate returned).');

  // ---- Secondary: model can still call the dummy action tool afterward ----
  const calls2 = functionCalls(r2.data);
  const actionCall = calls2.find(c => c.name === 'record_action');
  if (actionCall) {
    console.log('Action tool OK: model called record_action(summary=' + JSON.stringify(actionCall.args?.summary) + ') after the round-trip.');
  } else {
    const text = (r2.data.candidates[0].content?.parts || []).map(p => p.text).filter(Boolean).join(' ').slice(0, 200);
    console.log('Note: model answered with text instead of calling record_action this run (toolset was still attached and accepted). Text preview: ' + JSON.stringify(text));
  }

  console.log('\nPASS: escape-hatch functionResponse round-trip is accepted by the live Gemini API with the full toolset attached.');
  process.exit(0);
})().catch((e) => {
  console.error('FAIL: unexpected error: ' + (e && e.stack || e));
  process.exit(1);
});
