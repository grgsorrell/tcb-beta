/**
 * stripToolReferencesForGemini(maskedPrompt) → string
 *
 * WHY THIS FUNCTION EXISTS:
 * Sam's main conversational loop migrates from Anthropic Haiku 4.5 to
 * Google Gemini 2.5 Flash with Search Grounding. On the Haiku path, Sam
 * has access to a tool palette (web_search, lookup_compliance_deadlines,
 * lookup_finance_reports, lookup_donation_limits, lookup_jurisdiction,
 * save_note, add_calendar_event, etc.) and the system prompt instructs
 * her to call those tools. On the Gemini path, function calling is
 * intentionally disabled — UI buttons handle save/calendar/task actions,
 * and the lookup_* tool calls are replaced by worker-side pre-fetch that
 * injects results as prose into the system prompt. If the Haiku-tuned
 * tool-call instructions reach Gemini unchanged, Gemini gets confused:
 * she sees "your FIRST action must be a call to lookup_X" but cannot
 * call any tool, so she either narrates a tool call she can't make
 * (filler text the user reads) or attempts to recall data from training
 * (the failure mode the validators catch).
 *
 * WHAT IT DOES:
 * Replaces tool-call-mode language in the masked system prompt with
 * pre-fetch / Search Grounding language. Surgical text replacement, not
 * a wholesale prompt rewrite. The vast majority of the prompt (citation
 * discipline, smart deferral templates, URL routing tables, banned
 * hedging words, entity-mask instructions, ground-truth blocks, rules
 * that aren't tool-specific) flows through unchanged.
 *
 * WHEN IT RUNS:
 * Called inside runProductionGeminiTurn AFTER the line 6610 mask sweep
 * and BEFORE sending the prompt to the Gemini API. Operating on masked
 * text means real entity names are already replaced with placeholders;
 * tool names (web_search, lookup_*, etc.) are not entities and survive
 * the mask, so they can be matched literally here.
 *
 * LIMITATION — DRIFT RISK:
 * This is literal-text replacement against a generated string. If the
 * systemPrompt assembly in worker.js is restructured (new sections
 * added, existing sections reworded, tool names renamed), the strip
 * patterns in this function may stop matching and tool-call language
 * could leak through to Gemini. The companion test file
 * (tests/strip_tool_references.test.mjs) exists as a drift detector —
 * it asserts that no tool name survives the strip on a fixture prompt
 * representative of production. RUN THE TEST after any systemPrompt
 * edit. If assertions fail, update both the prompt and this strip
 * helper before shipping.
 */

export function stripToolReferencesForGemini(prompt) {
  if (!prompt || typeof prompt !== 'string') return prompt || '';
  let p = prompt;

  // ============================================================
  // SECTION 1: TOP-LEVEL FACTUAL DISCIPLINE
  // ============================================================

  // Block 1: STOP rule (line 6017 area) — both halves of the rule
  p = p.replace(
    /Either call web_search right now and cite what you find, or reply/g,
    'Either rely on the Pre-Fetched Context block below (if covers the question) or use Search Grounding to find a current source and cite the URL inline, or reply'
  );
  // The same rule's three-sources-for-facts list — replace the (b) reference
  p = p.replace(
    /\(b\) a web_search result you called in THIS conversation/g,
    '(b) data the worker pre-fetched into the Pre-Fetched Context block below or a Search-Grounding-surfaced source you cited in THIS response'
  );

  // Block 2: WHEN TO CALL WEB_SEARCH section — strip wholesale up to next header
  p = p.replace(
    /WHEN TO CALL WEB_SEARCH:[\s\S]*?(?=WHEN ANSWERING FACTUAL QUESTIONS:)/,
    ''
  );

  // Block 2b: WHEN ANSWERING FACTUAL QUESTIONS section — replace body with grounding-aware version
  p = p.replace(
    /WHEN ANSWERING FACTUAL QUESTIONS:[\s\S]*?Make the URL clickable in the response\./,
    'WHEN ANSWERING FACTUAL QUESTIONS:\n\n' +
    'Search Grounding is always enabled for your responses — Google\'s grounding will surface current sources for factual claims you make. When the response calls for a specific date, dollar amount, named contact, current event, compliance rule, electoral history, or any "state of the world" fact:\n\n' +
    '1. Use the Pre-Fetched Context block (below in this prompt) FIRST when it covers the question. Pre-fetched data is verified, cached, and authoritative for the categories it covers (compliance deadlines, finance reports, donation limits, jurisdiction municipalities).\n\n' +
    '2. For facts NOT covered by Pre-Fetched Context, lean on Search Grounding\'s surfaced sources. Cite the source URL inline:\n' +
    '   "Florida early voting starts October 22, 2026 (Source: dos.fl.gov)"\n' +
    '   "Filing deadline is June 12, 2026 (Source: ballotpedia.org/Florida_House_District_39)"\n\n' +
    '3. Make the URL clickable in the response.\n\n' +
    'Do NOT use grounding for:\n' +
    '- Conceptual or definitional questions ("what\'s a PAC?", "what does 501c4 mean?")\n' +
    '- Math or calculations using data already in context\n' +
    '- Strategic reasoning over data already provided\n' +
    '- Conversational responses ("thanks", "what\'s next?")'
  );

  // Block 3: WHEN WEB_SEARCH RETURNS NOTHING USEFUL — header rename only
  p = p.replace(
    /WHEN WEB_SEARCH RETURNS NOTHING USEFUL:/g,
    'WHEN GROUNDING RETURNS NOTHING USEFUL:'
  );

  // Block 4: "No web_search needed" reframe
  p = p.replace(
    /No web_search needed\. Cite the context source:/g,
    'No grounding needed when answering from context. Cite the context source:'
  );

  // Block 5: validator note — KEEP AS-IS (no replacement)

  // ============================================================
  // SECTION 2: SMART DEFERRAL
  // ============================================================

  // Block 6: SEARCH-TRIED PATTERN header
  p = p.replace(
    /SEARCH-TRIED PATTERN \(you called web_search and got nothing useful\):/g,
    'SEARCH-TRIED PATTERN (Search Grounding surfaced no usable result):'
  );

  // Block 7: WHEN TO USE WHICH PATTERN — replace two branches
  p = p.replace(
    /If you called web_search this turn and it returned nothing useful → SEARCH-TRIED pattern \(acknowledge what you searched, route to specific URL\)\.\s*\n\s*If you didn't call web_search because the question is race-specific or user-data-dependent → SEARCH-SKIPPED pattern \(route directly to specific URL with explanation of what's there\)\./,
    'If Search Grounding surfaced no usable result for a factual claim → SEARCH-TRIED pattern (acknowledge what you tried, route to specific URL).\n\nIf the question is race-specific or user-data-dependent (no public source) → SEARCH-SKIPPED pattern (route directly to specific URL with explanation of what\'s there).'
  );

  // ============================================================
  // SECTION 3: HARD-CONSTRAINT BLOCKS
  // ============================================================

  // Block 8: GEOGRAPHIC TARGETING — full replacement
  p = p.replace(
    /GEOGRAPHIC TARGETING — HARD CONSTRAINT[\s\S]*?(?=COMPLIANCE \/ FILING \/ QUALIFYING — HARD CONSTRAINT)/,
    'GEOGRAPHIC TARGETING — HARD CONSTRAINT (read every time, before any answer about places):\n' +
    'When the user asks anything about geographic targeting — canvassing, neighborhoods, event locations, mail targets, voter outreach geography, "where should I focus", door knocking, ground game routes, area-specific messaging — your response is constrained by the **Authorized Places** subsection of the Pre-Fetched Context block below.\n\n' +
    '  POSITIVE CONSTRAINT (this is the rule, not a guideline): The set of place names you may mention in your response is exactly the union of incorporated municipalities and major unincorporated areas listed in that subsection. No other place name from your training data may appear. None. The candidate\'s adjacent counties contain real cities you have learned about; those cities are forbidden in this response unless the subsection lists them.\n\n' +
    '  HOW TO COMPLY: When you draft each sentence that names a place, check it against the Authorized Places list in the subsection. If it isn\'t there, delete the place name and pick a different one from the list.\n\n' +
    '  EXAMPLE OF THE FAILURE MODE TO AVOID (this happened on 2026-04-25 with a real beta user): A user running for Orange County, FL Mayor asked where to canvass. The Authorized Places for that race included Apopka, Bay Lake, Belle Isle, Eatonville, Edgewood, Lake Buena Vista, Maitland, Oakland, Ocoee, Orlando, Windermere, Winter Garden, Winter Park, plus 49 unincorporated areas. None of those are Altamonte Springs or Sanford. A prior response listed Altamonte Springs as a high-priority canvassing area. Altamonte Springs is in Seminole County, not Orange County. That response was factually wrong. The model wrote a fabricated recommendation despite having the correct list in its context.\n\n' +
    '  IF THE PRE-FETCHED CONTEXT shows "No verified Authorized Places" for this race (district-level races where jurisdiction lookup couldn\'t surface a verified list): the subsection includes the state elections office contact instead. Use it. Sample phrasing: "I don\'t have a verified place list for [jurisdiction]. For verified district boundaries, contact [authority] — phone: [authority phone]. Want me to set a reminder to follow up?" Do NOT invent place names from training.\n\n'
  );

  // Block 9: COMPLIANCE / FILING / QUALIFYING — full replacement
  p = p.replace(
    /COMPLIANCE \/ FILING \/ QUALIFYING — HARD CONSTRAINT[\s\S]*?(?=CAMPAIGN FINANCE REPORTS — HARD CONSTRAINT)/,
    'COMPLIANCE / FILING / QUALIFYING — HARD CONSTRAINT (read every time, before any answer about deadlines):\n\n' +
    'When the user asks about filing deadlines, qualifying periods, ballot access dates, petition deadlines, filing fees, or any "must do X by date Y to be on the ballot" question — your PRIMARY SOURCE is the **Compliance Deadlines** subsection of the Pre-Fetched Context block below. Recognize the source-quality framing in that subsection\'s prose:\n\n' +
    '  If the subsection labels its data "Verified" or "Partially verified" — the source cascade returned a confirmed answer. State dates and fees confidently, citing the URL provided in the same subsection.\n\n' +
    '  If the subsection labels its data "Web-search-backed" — the source cascade was exhausted, but a worker-side web search backstop surfaced cited content. Quote the excerpt verbatim and cite the URL inline, with a verify-with-authority caveat. Sample: "Per FL Division of Elections (dos.fl.gov/elections), qualifying for State House opens at noon on Monday, June 8, 2026 — confirm with them and your county elections office before you build your filing checklist around that date."\n\n' +
    '  If the subsection says "No verified data available" — defer with the authority contact provided in the same subsection. Sample: "I don\'t have verified qualifying dates for [office] in [state]. Contact [authority] at [authority phone] for the current calendar."\n\n' +
    '  TRAINING-DATA RECALL FORBIDDEN: every date, deadline, and fee must trace to the verified or web-search-backed data shown in the Pre-Fetched Context subsection. No recall without a fresh citation from that subsection.\n\n' +
    '  URL HANDLING: only use URLs from the Pre-Fetched Context subsection. When the subsection has no URL, do NOT invent or guess URLs.\n\n' +
    '  WHY: Confidently wrong deadline = candidate disqualified. Citation requirement plus verify-with-authority caveat keeps Sam honest while staying useful. The pre-fetched data plus its built-in web search backstop ensures findable deadlines reach you without needing to chain searches yourself.\n\n'
  );

  // Block 10: CAMPAIGN FINANCE REPORTS — full replacement (placeholder phrasing per Refinement 1)
  p = p.replace(
    /CAMPAIGN FINANCE REPORTS — HARD CONSTRAINT[\s\S]*?(?=DONATION LIMITS — HARD CONSTRAINT)/,
    'CAMPAIGN FINANCE REPORTS — HARD CONSTRAINT (read every time, before any answer about reports):\n\n' +
    'When the user asks about quarterly reports, pre-primary / pre-general filings, post-election reports, FEC filing dates, or any "when is my campaign finance report due" question — your PRIMARY SOURCE is the **Finance Reports** subsection of the Pre-Fetched Context block below. Recognize the source-quality framing in that subsection\'s prose:\n\n' +
    '  If the subsection labels its data "Verified" or "Partially verified" — the source cascade returned a confirmed answer. State report dates and coverage periods confidently, citing the URL provided in the same subsection.\n\n' +
    '  If the subsection labels its data "Web-search-backed" — the source cascade was exhausted, but a worker-side web search backstop surfaced cited content. Quote the excerpt verbatim and cite the URL inline, with a verify-with-authority caveat. Sample: "Per FEC (fec.gov), Q2 reports are due [date] — verify your specific candidate-committee deadline since pre-primary filings may move."\n\n' +
    '  If the subsection says "No verified data available" — defer with the authority contact provided in the same subsection. Sample: "I don\'t have a verified [Q2 / pre-primary / etc.] report calendar for [office] in [state]. Contact [authority] at [authority phone]."\n\n' +
    '  TRAINING-DATA RECALL FORBIDDEN: every report date and coverage period must trace to the verified or web-search-backed data shown in the Pre-Fetched Context subsection. No recall without a fresh citation from that subsection.\n\n' +
    '  URL HANDLING: only use URLs from the Pre-Fetched Context subsection. When the subsection has no URL, do NOT invent or guess URLs.\n\n' +
    '  WHY: Missing a finance report = fines and bad press at minimum. Citation requirement plus verify caveat keeps Sam honest while staying useful. The pre-fetched data plus its built-in web search backstop ensures findable report calendars reach you without needing to chain searches yourself.\n\n'
  );

  // Block 11: DONATION LIMITS — full replacement (placeholder phrasing per Refinement 1)
  p = p.replace(
    /DONATION LIMITS — HARD CONSTRAINT[\s\S]*?(?=CITATION DISCIPLINE — HARD CONSTRAINT)/,
    'DONATION LIMITS — HARD CONSTRAINT (read every time, before any answer about contribution limits):\n\n' +
    'When the user asks about individual contribution limits, donation caps, max donations, "how much can a donor give", per-election or per-cycle limits — your PRIMARY SOURCE is the **Donation Limits** subsection of the Pre-Fetched Context block below. Recognize the source-quality framing in that subsection\'s prose:\n\n' +
    '  If the subsection labels its data "Verified" or "Partially verified" — the source cascade returned a confirmed answer. State amounts confidently, citing the URL provided in the same subsection.\n\n' +
    '  If the subsection labels its data "Web-search-backed" — the source cascade was exhausted, but a worker-side web search backstop surfaced cited content. Quote the excerpt verbatim and cite the URL inline, with a verify-with-authority caveat. Sample: "Per FL Division of Elections (dos.fl.gov/elections), the individual limit per the cited source — verify with them since limits can change between cycles. Want me to set a reminder?"\n\n' +
    '  If the subsection says "No verified data available" — defer with the authority contact provided in the same subsection. Sample: "I don\'t have verified contribution limits for [office] in [state]. Contact [authority] at [authority phone]."\n\n' +
    '  TRAINING-DATA RECALL FORBIDDEN: every figure must trace to the verified or web-search-backed data shown in the Pre-Fetched Context subsection. No training-data recall, even if you remember the number.\n\n' +
    '  URL HANDLING: only use URLs from the Pre-Fetched Context subsection. When the subsection has no URL, do NOT invent or guess URLs.\n\n' +
    '  WHY: A campaign manager who states the limit (with verify caveat) is useful. One who refuses when authoritative sources are findable online is not. The pre-fetched data plus its built-in web search backstop ensures findable answers reach you without needing to chain searches yourself; the citation requirement keeps every figure traceable.\n\n'
  );

  // ============================================================
  // SECTION 4: NEWS / OPPONENT / META-TRANSPARENCY
  // ============================================================

  // Block 12: NEWS QUERIES — replace web_search instructions
  p = p.replace(
    /your FIRST action MUST be a web_search call\. After web_search returns, your response MUST cite the specific articles\/sources from the search results using an explicit attribution phrase/,
    'your response MUST be sourced from Search Grounding\'s surfaced articles, citing the specific articles/sources using an explicit attribution phrase'
  );

  // News block — unavailable-search branch
  p = p.replace(
    /If web_search is unavailable for this turn[\s\S]*?Let me know what you've heard and I'll factor it in\."/,
    'If Search Grounding produced no relevant results for opponent-related queries, defer entirely: "I can\'t pull current news right now. Let me know what you\'ve heard and I\'ll factor it in."'
  );

  // News block — additional web_search reference
  p = p.replace(
    /NEVER characterize "news" or recent developments without calling web_search first\./g,
    'NEVER characterize "news" or recent developments without grounding-sourced citations.'
  );

  // Block 13: META-TRANSPARENCY sample
  p = p.replace(
    /Sample: "I called lookup_donation_limits — it returned no verified data for your race\. Fallback web_search of the FL Division of Elections is allowed — want me to try that\?"/,
    'Sample: "The pre-fetched compliance context didn\'t cover that for your race, and Search Grounding didn\'t surface a verified figure either. Want me to set a calendar reminder to check the FL Division of Elections directly?"'
  );

  // Block 14: OPPONENT FACTS — soft Phase 1 gate (Option Alpha; Option Gamma is Phase 2)
  p = p.replace(
    /NO WEB_SEARCH FOR OPPONENTS: web_search is forbidden for opponent-specific queries[\s\S]*?the entity-mask system requires this restriction regardless of source authority\./,
    'NO GROUNDING FOR OPPONENTS: Do NOT lean on Search Grounding for opponent-specific queries even when not auto-gated. Even with masked names, search results re-leak real-world identities and inject training-data facts. The entity-mask system requires this restriction regardless of source authority. Use Intel panel data only.'
  );

  // ============================================================
  // SECTION 5: NUMBERED RULES BLOCK
  // ============================================================

  // Block 15: Rule 1 — replace
  p = p.replace(
    /1\. Always call the appropriate tool before confirming any action\. Never claim you did something without a tool call\. If you need multiple tools, call ALL of them before responding\./,
    '1. Never claim you completed a save/calendar/task action — those happen via UI buttons the user clicks, not by you. When the user asks to save or schedule something, draft the content and ask "Want to add this to your calendar?" or similar. The user clicks the button to commit.'
  );

  // Block 16: Rule 5 — replace
  p = p.replace(
    /5\. Search proactively for any specific factual claim — dates, dollar amounts, named contacts, current events, compliance rules, electoral history\. Call web_search FIRST, then answer with inline citation\. Don't NARRATE the call \("Let me search\.\.\.", "Based on search results\.\.\."\) — just deliver the answer with the source attached\./,
    '5. Lean on Pre-Fetched Context first, then Search Grounding, for any specific factual claim — dates, dollar amounts, named contacts, current events, compliance rules, electoral history. Cite the source URL inline. Don\'t narrate ("Based on search results...") — just deliver the answer with the source attached.'
  );

  // ============================================================
  // SECTION 6: ONBOARDING BLOCK
  // ============================================================

  // Block 18: Onboarding "Search for" instructions
  p = p.replace(
    /1\. Search for "[^"]+ campaign finance report deadlines [^"]+"\s*\n\s*2\. Search for "[^"]+ personal financial statement [^"]+"/,
    '1. The Pre-Fetched Context block in this prompt contains compliance deadlines for the candidate\'s race. Lean on it for filing dates and report calendars.\n2. If a specific deadline isn\'t covered by Pre-Fetched Context, use Search Grounding to surface it from the state\'s elections authority site, citing the URL inline.'
  );

  // ============================================================
  // SECTION 7: MODE HINTS
  // ============================================================

  // Block 19: Compliance mode hint
  p = p.replace(
    /MODE: Compliance — search for current dates, name sources, recommend verification\./,
    'MODE: Compliance — use Pre-Fetched Context first, then Search Grounding for any uncovered specifics; name sources; recommend verification.'
  );

  // ============================================================
  // SECTION 8: CLASSIFIER-DRIVEN FRAMING
  // ============================================================

  // Block 20: STRATEGIC framing
  p = p.replace(
    /But strategic reasoning often surfaces FACTS — specific dollar amounts, named opponents, current events, electoral history\. Those facts MUST be web_searched and cited, even inside strategic responses\. When in doubt: search first, then reason on the cited results\./,
    'But strategic reasoning often surfaces FACTS — specific dollar amounts, current events, electoral history. Those facts MUST come from Pre-Fetched Context or Search Grounding and be cited inline. (Opponent-specific facts come from Intel panel only — never grounding for opponents.)'
  );

  // Block 21: COMPLIANCE framing
  p = p.replace(
    /Even when you find a relevant rule via web_search, append "verify with a campaign attorney before acting" or equivalent/,
    'Even when you find a relevant rule via Pre-Fetched Context or Search Grounding, append "verify with a campaign attorney before acting" or equivalent'
  );

  // Block 22: CONVERSATIONAL framing
  p = p.replace(
    /No web_search call needed\. No long checklists\. A few sentences max\./,
    'No grounding call needed. No long checklists. A few sentences max.'
  );

  // Block 23: FACTUAL framing
  p = p.replace(
    /Default to web_search FIRST before answering\. If web_search returns nothing useful, defer with a smart-deferral URL pointer/,
    'Default to Pre-Fetched Context first; for items not covered, lean on Search Grounding. If neither surfaces a verified answer, defer with a smart-deferral URL pointer'
  );

  return p;
}
