export default {
  async fetch(request, env) {
    // CORS headers helper
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Admin-Key",
    };

    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);

    // ========================================
    // HELPER: Generate random ID
    // ========================================
    function generateId(length = 32) {
      const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
      let result = '';
      const bytes = new Uint8Array(length);
      crypto.getRandomValues(bytes);
      for (let i = 0; i < length; i++) {
        result += chars[bytes[i] % chars.length];
      }
      return result;
    }

    // ========================================
    // HELPER: JSON response
    // ========================================
    function jsonResponse(data, status = 200) {
      return new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // ========================================
    // HELPER: Get user from session
    // ========================================
    async function getUserFromSession(req) {
      const authHeader = req.headers.get('Authorization');
      if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
      const sessionId = authHeader.slice(7);
      const session = await env.DB.prepare(
        'SELECT user_id FROM sessions WHERE session_id = ? AND expires_at > datetime(\'now\')'
      ).bind(sessionId).first();
      return session ? session.user_id : null;
    }

    // ========================================
    // HELPER: Resolve session → workspace context (C3, dormant until C4)
    // ========================================
    // Owner:    { userId, ownerId: userId, isSubUser: false, permissions: null }
    // Sub-user: { userId, ownerId: <owner's users.id>, isSubUser: true, permissions: {...} }
    // Revoked:  { userId, ownerId: null, isSubUser: true, revoked: true }
    // No valid session: null
    //
    // Every data endpoint filter/write will route through ownerId starting in
    // C4/C5. Until then this helper is declared but unused.
    async function getSessionContext(req) {
      const userId = await getUserFromSession(req);
      if (!userId) return null;
      const user = await env.DB.prepare(
        'SELECT id, email FROM users WHERE id = ?'
      ).bind(userId).first();
      if (!user) return null;
      if (user.email && user.email.endsWith('@sub.tcb')) {
        const subUsername = user.email.replace(/@sub\.tcb$/, '');
        // LOWER() match — anchor emails are stored lowercased (login
        // normalizes before insert), but sub_users.username is stored
        // as-typed by the owner. Without LOWER(), mixed-case usernames
        // like "Kelly-mgr1" silently miss and we report revoked.
        const sub = await env.DB.prepare(
          'SELECT owner_id, status, permissions_json FROM sub_users WHERE LOWER(username) = ?'
        ).bind(subUsername).first();
        if (!sub || sub.status === 'revoked') {
          return { userId, ownerId: null, isSubUser: true, revoked: true };
        }
        let perms = {};
        try { perms = JSON.parse(sub.permissions_json || '{}'); } catch (e) {}
        return { userId, ownerId: sub.owner_id, isSubUser: true, permissions: perms };
      }
      return { userId, ownerId: userId, isSubUser: false, permissions: null };
    }

    // Returns true if ctx can perform an action gated by (tab, minLevel).
    // Owners bypass all checks. Sub-users need the tab key present with a
    // level >= requested minimum. 'read' allows read or full; 'full' requires
    // full. Missing key or null ctx → denied.
    function requirePermission(ctx, tab, minLevel) {
      if (!ctx) return false;
      if (ctx.revoked) return false;
      if (!ctx.isSubUser) return true;
      const level = (ctx.permissions || {})[tab];
      if (!level) return false;
      if (minLevel === 'read') return level === 'read' || level === 'full';
      if (minLevel === 'full') return level === 'full';
      return false;
    }

    // Standard denial responses consumed by the frontend. Shape is stable
    // across endpoints so handleUnauthenticated / permission-aware UI can
    // branch on .error.
    function denyPermission(tab) {
      return jsonResponse({ error: 'permission_denied', tab: tab, message: "You don't have access to this tab" }, 403);
    }
    function denyOwnerOnly() {
      return jsonResponse({ error: 'owner_only', message: 'This action is only available to the workspace owner' }, 403);
    }
    function denyRevoked() {
      return jsonResponse({ error: 'Access revoked' }, 401);
    }

    // ========================================
    // HELPER: Jurisdiction lookup (backs the lookup_jurisdiction Sam tool)
    // ========================================

    // Two-letter postal code → full state name. Used for building
    // Wikipedia article + category titles. Accepts already-full names
    // pass-through.
    function expandStateName(s) {
      const map = {
        AL:'Alabama',AK:'Alaska',AZ:'Arizona',AR:'Arkansas',CA:'California',
        CO:'Colorado',CT:'Connecticut',DE:'Delaware',FL:'Florida',GA:'Georgia',
        HI:'Hawaii',ID:'Idaho',IL:'Illinois',IN:'Indiana',IA:'Iowa',
        KS:'Kansas',KY:'Kentucky',LA:'Louisiana',ME:'Maine',MD:'Maryland',
        MA:'Massachusetts',MI:'Michigan',MN:'Minnesota',MS:'Mississippi',
        MO:'Missouri',MT:'Montana',NE:'Nebraska',NV:'Nevada',NH:'New Hampshire',
        NJ:'New Jersey',NM:'New Mexico',NY:'New York',NC:'North Carolina',
        ND:'North Dakota',OH:'Ohio',OK:'Oklahoma',OR:'Oregon',PA:'Pennsylvania',
        RI:'Rhode Island',SC:'South Carolina',SD:'South Dakota',TN:'Tennessee',
        TX:'Texas',UT:'Utah',VT:'Vermont',VA:'Virginia',WA:'Washington',
        WV:'West Virginia',WI:'Wisconsin',WY:'Wyoming',DC:'District of Columbia'
      };
      const trimmed = (s || '').trim();
      if (trimmed.length === 2) return map[trimmed.toUpperCase()] || trimmed;
      return trimmed;
    }

    // Detect jurisdiction type from the office + jurisdiction strings.
    // Returns one of: 'county', 'city', 'us_house_district',
    // 'state_legislative_district', or 'unknown'.
    function detectJurisdictionType(office, jurisdictionName) {
      const o = (office || '').toLowerCase();
      const j = (jurisdictionName || '').toLowerCase();
      if (j.includes('county')) return 'county';
      if (o.includes('us house') || o.includes('us congress') || o.includes('congressional district') || /^[a-z]{2}-?\d+$/i.test(j.replace(/\s+/g,''))) {
        return 'us_house_district';
      }
      if (o.includes('state house') || o.includes('state senate') || o.includes('state assembly') || o.includes('state legislator') || o.includes('state representative')) {
        return 'state_legislative_district';
      }
      // Default to city/municipal — covers Mayor, City Council, etc.
      return 'city';
    }

    // Wikipedia category-members API path for county lookups.
    // Counties have well-curated category trees:
    //   Cities_in_X_County,_State
    //   Towns_in_X_County,_State
    //   Villages_in_X_County,_State (some states)
    //   Census-designated_places_in_X_County,_State
    //   Unincorporated_communities_in_X_County,_State
    // We hit each, dedupe titles, strip the disambiguating ", State"
    // suffix from each entry's title.
    async function resolveCountyViaWikipedia(jurisdictionName, state) {
      const stateFull = expandStateName(state);
      const cleanCounty = jurisdictionName.replace(/\s+county\s*$/i, '').trim();
      const wikiCounty = (cleanCounty + '_County,_' + stateFull).replace(/\s+/g, '_');

      const incorporatedCats = [
        'Cities_in_' + wikiCounty,
        'Towns_in_' + wikiCounty,
        'Villages_in_' + wikiCounty
      ];
      const unincorporatedCats = [
        'Unincorporated_communities_in_' + wikiCounty,
        'Census-designated_places_in_' + wikiCounty
      ];

      async function fetchCategory(catTitle) {
        const url = 'https://en.wikipedia.org/w/api.php?action=query&list=categorymembers&cmtitle=Category:' +
          encodeURIComponent(catTitle) + '&cmlimit=500&cmtype=page&format=json&origin=*';
        try {
          const r = await fetch(url, {
            headers: { 'User-Agent': 'TheCandidatesToolbox/1.0 (https://thecandidatestoolbox.com; ops@thecandidatestoolbox.com)' }
          });
          if (!r.ok) return [];
          const data = await r.json();
          const members = (data && data.query && data.query.categorymembers) || [];
          return members.map(m => {
            // Strip ", State" suffix (e.g. "Orlando, Florida" → "Orlando")
            // and parenthetical disambiguators (e.g. "Apopka (city)" → "Apopka").
            // State names don't contain regex special chars, so no escape needed.
            let title = m.title || '';
            title = title.replace(new RegExp(',?\\s*' + stateFull + '\\s*$', 'i'), '');
            title = title.replace(/\s*\([^)]*\)\s*$/, '');
            return title.trim();
          }).filter(Boolean);
        } catch (e) {
          return [];
        }
      }

      const incResults = await Promise.all(incorporatedCats.map(fetchCategory));
      const uninResults = await Promise.all(unincorporatedCats.map(fetchCategory));

      const incorporated = [...new Set(incResults.flat())].sort();
      const unincorporated = [...new Set(uninResults.flat())].sort();

      return {
        jurisdiction_type: 'county',
        official_name: cleanCounty + ' County, ' + stateFull,
        incorporated_municipalities: incorporated,
        major_unincorporated_areas: unincorporated,
        source: 'Wikipedia',
        last_updated: new Date().toISOString().split('T')[0]
      };
    }

    // ========================================
    // HELPER: Log API usage to console and D1
    // ========================================
    async function logApiUsage(feature, data, userId, ownerId) {
      const usage = data && data.usage ? data.usage : {};
      const inputTokens = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);
      const outputTokens = usage.output_tokens || 0;
      // Haiku 4.5 rates: $0.80/M input, $4.00/M output
      // Cache creation: $1.00/M, Cache read: $0.08/M
      const cacheCreate = usage.cache_creation_input_tokens || 0;
      const cacheRead = usage.cache_read_input_tokens || 0;
      const regularInput = usage.input_tokens || 0;
      const cost = (regularInput * 0.80 / 1000000) + (cacheCreate * 1.00 / 1000000) + (cacheRead * 0.08 / 1000000) + (outputTokens * 4.00 / 1000000);
      console.log(`[API] ${feature}: ${inputTokens} in / ${outputTokens} out = $${cost.toFixed(4)}`);
      try {
        // workspace_owner_id attributes the cost to the billing workspace;
        // user_id records the actual caller (sub-user or owner) for audit.
        await env.DB.prepare(
          'INSERT INTO api_usage (id, user_id, workspace_owner_id, feature, input_tokens, output_tokens, estimated_cost, model) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        ).bind(generateId(16), userId || '', ownerId || null, feature, inputTokens, outputTokens, cost, 'claude-haiku-4-5-20251001').run();
      } catch(e) { /* don't fail the request if logging fails */ }
    }

    // ========================================
    // HELPER: Research a single opponent
    // Federal races: FEC race roster (resolve candidate_id) → FEC finances →
    //   1 VPS news search → Haiku synthesis (~$0.005).
    //   Falls back to VPS-news-only if no FEC match found.
    // Non-federal: Haiku + web_search with max_uses: 3 (~$0.05–0.07)
    // ========================================
    async function researchOpponent(params, userId, ownerId) {
      const { name, office, state, loc, year, myCandidateName, myParty } = params;
      const officeLower = (office || '').toLowerCase();
      let fecCode = null;
      if (officeLower.includes('house') || officeLower.includes('congress') || officeLower.includes('representative')) fecCode = 'H';
      else if (officeLower.includes('senate') || officeLower.includes('senator')) fecCode = 'S';
      else if (officeLower.includes('president')) fecCode = 'P';
      const isFederal = !!fecCode;
      const dm = fecCode === 'H' ? ((office + ' ' + loc).match(/district\s*(\d+)/i) || (office + ' ' + loc).match(/(\d+)(?:th|st|nd|rd)/i)) : null;
      const district = dm ? dm[1].padStart(2, '0') : '';

      let fecMatch = null;      // the roster entry for this opponent (candidate_id, party, etc.)
      let fecFinances = null;   // the /candidate/finances summary
      let newsContent = '';

      // Fuzzy-match an input name against FEC "LAST, FIRST MIDDLE" names.
      // Require every multi-char token of the input to appear in the FEC name.
      function fuzzyMatchFEC(inputName, fecName) {
        const input = (inputName || '').toLowerCase().trim();
        const fec = (fecName || '').toLowerCase().trim();
        if (!input || !fec) return false;
        const tokens = input.split(/[\s,]+/).filter(t => t.length > 1);
        if (tokens.length === 0) return false;
        return tokens.every(t => fec.indexOf(t) >= 0);
      }

      if (isFederal) {
        // 1) FEC race roster — get the candidate_id for this opponent.
        // 25s timeout because the research service sometimes cold-starts slowly.
        try {
          const rosterResp = await fetch('https://research.thecandidatestoolbox.com/candidates/federal', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Search-Key': 'tcb-search-2026' },
            body: JSON.stringify({ office: fecCode, state, district, election_year: year }),
            signal: AbortSignal.timeout(25000)
          });
          if (rosterResp.ok) {
            const r = await rosterResp.json();
            if (r && r.success && Array.isArray(r.candidates)) {
              fecMatch = r.candidates.find(c => fuzzyMatchFEC(name, c.name)) || null;
              if (fecMatch) {
                console.log('[Opponent FEC]', name, 'matched', fecMatch.name, fecMatch.candidate_id);
              } else {
                console.warn('[Opponent FEC]', name, 'no match among', r.candidates.length, 'candidates');
              }
            }
          } else { console.warn('[Opponent FEC] roster status', rosterResp.status); }
        } catch (e) { console.warn('[Opponent FEC] roster failed:', e.message); }

        // 2) FEC finances — only if we resolved a candidate_id.
        // Up to 2 attempts: the research service's upstream FEC connection
        // is flaky and occasionally times out on first call but succeeds on retry.
        if (fecMatch && fecMatch.candidate_id) {
          for (let attempt = 1; attempt <= 2; attempt++) {
            try {
              const finResp = await fetch('https://research.thecandidatestoolbox.com/candidate/finances', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Search-Key': 'tcb-search-2026' },
                body: JSON.stringify({ candidate_id: fecMatch.candidate_id }),
                signal: AbortSignal.timeout(25000)
              });
              if (finResp.ok) {
                const f = await finResp.json();
                if (f && f.success && f.has_data && f.summary) {
                  fecFinances = f.summary;
                  console.log('[Opponent FEC] finances', fecMatch.candidate_id, 'attempt', attempt, 'cash=$' + (f.summary.cash_on_hand||0), 'raised=$' + (f.summary.total_raised||0));
                  break;
                } else {
                  console.log('[Opponent FEC] finances', fecMatch.candidate_id, 'no data yet');
                  break;
                }
              } else {
                console.warn('[Opponent FEC] finances status', finResp.status, 'attempt', attempt);
                if (attempt < 2) await new Promise(r => setTimeout(r, 1500));
              }
            } catch (e) {
              console.warn('[Opponent FEC] finances failed attempt', attempt + ':', e.message);
              if (attempt < 2) await new Promise(r => setTimeout(r, 1500));
            }
          }
        }

        // 3) One VPS search for recent news
        try {
          const vpsBase = (env.VPS_SEARCH_URL || 'https://search.thecandidatestoolbox.com').replace(/\/+$/, '') + '/smart-search';
          const vpsResp = await fetch(vpsBase, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Search-Key': 'tcb-search-2026' },
            body: JSON.stringify({ query: name + ' ' + (office || '') + ' ' + (state || '') + ' campaign ' + year, max_results: 5, max_chars: 8000 }),
            signal: AbortSignal.timeout(15000)
          });
          if (vpsResp.ok) {
            const j = await vpsResp.json();
            if (j && j.content && j.content.length > 50) { newsContent = j.content; console.log('[Opponent VPS]', name, 'OK', j.content.length, 'chars'); }
          }
        } catch (e) { console.warn('[Opponent VPS] Failed:', e.message); }
      }

      const jsonShape = '{"party":"R|D|I|other","office":"string","bio":"2-3 sentences","background":"1-2 sentences on career/background","recentNews":"1-2 sentences on recent activity","campaignFocus":"1-2 sentences on issues and messaging","threatLevel":1-10 integer,"keyRisk":"one specific risk this opponent poses","subScores":{"financial":1-10,"nameRecognition":1-10,"momentum":1-10,"directThreat":1-10}}';

      const hasFederalData = isFederal && (fecMatch || newsContent);
      let apiBody, featureTag;

      if (hasFederalData) {
        featureTag = 'intel_opponent_fec';
        const ctxParts = [];
        if (fecMatch) {
          ctxParts.push('FEC ROSTER (authoritative identity/party/incumbency):\n' + JSON.stringify({
            name: fecMatch.name,
            candidate_id: fecMatch.candidate_id,
            party: fecMatch.party,
            party_short: fecMatch.party_short,
            incumbent_challenge: fecMatch.incumbent_challenge,
            office: fecMatch.office,
            state: fecMatch.state,
            district: fecMatch.district,
            activity_status: fecMatch.activity_status,
            first_file_date: fecMatch.first_file_date,
            committees: fecMatch.committees
          }));
        }
        if (fecFinances) {
          ctxParts.push('FEC FINANCES (authoritative — use exact numbers):\n' + JSON.stringify(fecFinances));
        } else if (fecMatch) {
          ctxParts.push('FEC FINANCES: no finance report filed yet (early-stage candidate). Set subScores.financial = 1-2.');
        }
        if (newsContent) ctxParts.push('RECENT NEWS (for bio/background/recentNews/campaignFocus):\n' + newsContent);

        const userMsg =
          'Analyze ' + name + ', an opponent of ' + (myCandidateName || 'my candidate') + ' (' + (myParty || 'unknown party') + ') running for ' + (office || 'unknown office') + ' in ' + (loc ? loc + ', ' : '') + (state || '') + ', ' + year + '.\n\n' +
          'Use ONLY this research data — do not invent facts. If a field is unknown, write "unknown".\n\n' +
          ctxParts.join('\n\n') + '\n\n' +
          'Return ONLY JSON in this exact shape:\n' + jsonShape + '\n\n' +
          'SCORING RULES (strict — use real FEC numbers if provided):\n' +
          '- subScores.financial is based on FEC cash_on_hand AND total_raised:\n' +
          '    $0-10k raised: 1-2\n' +
          '    $10k-100k raised: 3-4\n' +
          '    $100k-500k raised: 5-6\n' +
          '    $500k-1M raised: 7-8\n' +
          '    $1M+ raised: 9-10\n' +
          '  Boost +1 if cash_on_hand > $250k. Subtract 1 if debts exceed cash_on_hand.\n' +
          '- subScores.nameRecognition: incumbent_challenge="Incumbent"=9; prominent officeholder/celebrity=7; known local figure=5; first-time candidate=2-3.\n' +
          '- subScores.momentum: based on recent news volume + fundraising trajectory. Quiet + low raise = 2-3; active news + raising = 6-8.\n' +
          '- subScores.directThreat: same-party primary rival or strong general opponent in competitive district=high; wrong-party in safe district=low.\n' +
          '- threatLevel: overall (roughly average of sub-scores, weighted by financial + directThreat).\n' +
          '- party: use FEC party_short if present (REP=R, DEM=D, etc.). If roster says incumbent_challenge is "Incumbent" for someone other than the user\'s candidate, note it in keyRisk.';
        apiBody = {
          model: "claude-haiku-4-5-20251001",
          max_tokens: 2000,
          temperature: 0.2,
          system: [{ type: "text", text: 'You are a political research analyst. Return ONLY valid JSON matching the shape requested — no preamble, no markdown fences. Use only the research data provided — FEC data is authoritative. Do not include XML citation tags, <cite> tags, or any HTML/XML markup inside the JSON string values — return plain prose only. Current year is ' + new Date().getFullYear() + '.' }],
          messages: [{ role: "user", content: userMsg }]
        };
      } else {
        featureTag = 'intel_opponent_anthropic';
        const userMsg = 'Research ' + name + ', an opponent of ' + (myCandidateName || 'my candidate') + ' (' + (myParty || 'unknown party') + ') running for ' + (office || 'unknown office') + ' in ' + (loc ? loc + ', ' : '') + (state || '') + ', ' + year + '. Perform at most 3 web searches. Focus on: (1) bio/background, (2) recent news/campaign activity, (3) campaign focus and issues. Do not do exhaustive research.\n\nReturn ONLY JSON in this exact shape:\n' + jsonShape + '\n\nScoring: nameRecognition (incumbent=9, prominent=6, unknown=3), momentum (recent news+fundraising=8+, quiet=3), directThreat (strong same-lane=high).\n\nIMPORTANT: Do not wrap any text in <cite>, <cite index="...">, or any other XML/HTML tags. The JSON string values must be plain prose with no markup — just the sentences themselves.';
        apiBody = {
          model: "claude-haiku-4-5-20251001",
          max_tokens: 3000,
          temperature: 0.2,
          system: [{ type: "text", text: 'You are a political research analyst. Perform at most 3 web searches. Focus only on bio/background, recent news, and campaign focus — do not do exhaustive research. Return ONLY valid JSON — no preamble, no markdown fences. Do not include XML citation tags, <cite> tags, or any HTML/XML markup inside the JSON string values — return plain prose only. Current year is ' + new Date().getFullYear() + '.' }],
          tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }],
          messages: [{ role: "user", content: userMsg }]
        };
      }

      const apiResp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
        body: JSON.stringify(apiBody)
      });
      const apiData = await apiResp.json();
      await logApiUsage(featureTag, apiData, userId, ownerId);

      // Parse JSON from last text block
      const textBlocks = [];
      if (apiData.content && Array.isArray(apiData.content)) {
        apiData.content.forEach(b => { if (b.type === 'text' && b.text) textBlocks.push(b.text); });
      }
      const lastBlock = textBlocks[textBlocks.length - 1] || '';
      const jsonStr = lastBlock.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
      let card = null;
      try { card = JSON.parse(jsonStr); } catch (e) {
        const matches = jsonStr.match(/\{[\s\S]*\}/g);
        if (matches) { try { card = JSON.parse(matches[matches.length - 1]); } catch (e2) {} }
      }
      if (!card) { console.error('[Opponent]', name, 'JSON parse failed. Raw:', lastBlock.substring(0, 300)); throw new Error('Opponent research returned no parseable JSON'); }

      // Haiku sometimes wraps quoted source text in <cite index="..."> tags
      // (the web_search tool encourages citation markup). Strip them here so
      // the UI never shows raw tags and the D1-stored card stays plain prose.
      const stringFields = ['party', 'office', 'bio', 'background', 'recentNews', 'campaignFocus', 'keyRisk'];
      stringFields.forEach(function(f) {
        if (typeof card[f] === 'string') card[f] = stripCiteTags(card[f]);
      });

      card.source = hasFederalData ? 'fec_vps' : 'anthropic';
      // Stash FEC data alongside the card so the frontend can show exact numbers.
      if (fecFinances) card.finances = fecFinances;
      if (fecMatch && fecMatch.candidate_id) card.fecCandidateId = fecMatch.candidate_id;
      return card;
    }

    // Strip <cite index="...">inner</cite> wrappers and any orphan <cite>/</cite>
    // tags, preserving the inner text. Idempotent — safe to run over clean strings.
    function stripCiteTags(s) {
      if (typeof s !== 'string') return s;
      return s
        .replace(/<cite\b[^>]*>([\s\S]*?)<\/cite>/gi, '$1')
        .replace(/<\/?cite\b[^>]*>/gi, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
    }

    // ========================================
    // AUTH: Beta login (username/password)
    // ========================================
    if (url.pathname === '/auth/beta-login' && request.method === 'POST') {
      try {
        const { username, password } = await request.json();
        const BETA_USERS = { greg: 'Beta#01', shannan: 'Beta#01', cjc: 'Beta#01', jerry: 'Beta#01' };
        const cleanUser = (username || '').toLowerCase().trim();
        if (!BETA_USERS[cleanUser] || BETA_USERS[cleanUser] !== password) {
          return jsonResponse({ error: 'Invalid credentials' }, 401);
        }
        // Find or create D1 user
        let user = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(cleanUser + '@beta.tcb').first();
        if (!user) {
          const userId = generateId();
          await env.DB.prepare('INSERT INTO users (id, email) VALUES (?, ?)').bind(userId, cleanUser + '@beta.tcb').run();
          user = { id: userId };
        }
        // Create session (30 days)
        const sessionId = generateId(48);
        const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
        await env.DB.prepare(
          'INSERT INTO sessions (session_id, user_id, expires_at) VALUES (?, ?, ?)'
        ).bind(sessionId, user.id, expiresAt).run();
        return jsonResponse({ success: true, sessionId, userId: user.id, username: cleanUser });
      } catch (error) {
        return jsonResponse({ error: error.message }, 500);
      }
    }

    // ========================================
    // AUTH: Create account
    // ========================================
    if (url.pathname === '/api/auth/create-account' && request.method === 'POST') {
      try {
        const { username, email, password, fullName } = await request.json();
        if (!username || !email || !password || !fullName) return jsonResponse({ error: 'All fields required' }, 400);
        if (password.length < 8) return jsonResponse({ error: 'weak_password' }, 400);
        // Check username — both users and sub_users (cross-table uniqueness).
        // Same username can't exist in either table; collision is reported
        // with the same generic 'username_taken' error in both cases.
        const existingUser = await env.DB.prepare('SELECT id FROM users WHERE LOWER(username) = LOWER(?)').bind(username).first();
        const existingSubUser = await env.DB.prepare('SELECT id FROM sub_users WHERE LOWER(username) = LOWER(?)').bind(username).first();
        if (existingUser || existingSubUser) {
          const suggestions = [username + '2', username + '3', username.charAt(0) + fullName.split(' ').pop().toLowerCase() + '1'];
          return jsonResponse({ error: 'username_taken', suggestions }, 409);
        }
        // Check email
        const existingEmail = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email.toLowerCase()).first();
        if (existingEmail) return jsonResponse({ error: 'email_taken' }, 409);
        // Hash password
        const encoder = new TextEncoder();
        const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(password + '_tcb_salt_2026'));
        const hashHex = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
        const userId = generateId();
        const now = new Date().toISOString();
        const trialEnds = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
        await env.DB.prepare(
          'INSERT INTO users (id, username, email, password_hash, full_name, plan, trial_started, trial_ends, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        // BETA: All new accounts get 'beta' plan (no expiry). Change to 'trial' when billing activates.
        ).bind(userId, username.toLowerCase(), email.toLowerCase(), hashHex, fullName, 'beta', now, trialEnds, 'active', now).run();
        // Create session
        const sessionId = generateId(48);
        const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
        await env.DB.prepare('INSERT INTO sessions (session_id, user_id, expires_at) VALUES (?, ?, ?)').bind(sessionId, userId, expiresAt).run();
        return jsonResponse({ success: true, sessionId, userId, username: username.toLowerCase(), fullName, plan: 'beta' });
      } catch (error) {
        return jsonResponse({ error: error.message }, 500);
      }
    }

    // ========================================
    // AUTH: Unified login — handles owners AND sub-users in one endpoint.
    // /auth/subuser-login is kept as an alias of this route for back-compat.
    // See CLAUDE.md "Unified Login" section for design notes.
    // ========================================
    if ((url.pathname === '/api/auth/login' || url.pathname === '/auth/subuser-login')
        && request.method === 'POST') {
      try {
        const { username, password } = await request.json();
        if (!username || !password) return jsonResponse({ error: 'Username and password required' }, 400);
        const clean = (username || '').toLowerCase().trim();

        // ---- Rate-limit gate (CP-C) ----
        // Count success=0 attempts for this username in the last 15 min.
        // If >= 5, compute retry-after from the oldest failure in the
        // window and return 429 without running any further logic.
        const failStats = await env.DB.prepare(
          "SELECT COUNT(*) as n, MIN(attempted_at) as oldest FROM login_attempts WHERE username = ? AND success = 0 AND attempted_at > datetime('now', '-15 minutes')"
        ).bind(clean).first();
        if (failStats && failStats.n >= 5) {
          const oldestMs = Date.parse(failStats.oldest.replace(' ', 'T') + 'Z');
          const unlockMs = oldestMs + 15 * 60 * 1000;
          const retryAfterMinutes = Math.max(1, Math.ceil((unlockMs - Date.now()) / 60000));
          return new Response(JSON.stringify({
            error: 'too_many_attempts',
            message: 'Too many failed attempts. Try again in ' + retryAfterMinutes + ' minute' + (retryAfterMinutes === 1 ? '' : 's') + '.',
            retryAfterMinutes: retryAfterMinutes
          }), {
            status: 429,
            headers: {
              'Content-Type': 'application/json',
              'Retry-After': String(retryAfterMinutes * 60),
              ...corsHeaders
            }
          });
        }

        // Shared helpers for logging attempts + clearing failures on success.
        const logAttempt = async (ok) => {
          try {
            await env.DB.prepare('INSERT INTO login_attempts (id, username, success) VALUES (?, ?, ?)').bind(generateId(16), clean, ok ? 1 : 0).run();
          } catch (e) { /* logging failure should not block auth */ }
        };
        const clearFailures = async () => {
          try {
            await env.DB.prepare('DELETE FROM login_attempts WHERE username = ? AND success = 0').bind(clean).run();
          } catch (e) {}
        };

        // Hash once — used by both owner and sub-user comparisons.
        const encoder = new TextEncoder();
        const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(password + '_tcb_salt_2026'));
        const hashHex = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');

        // ---- Try owner row first ----
        // Match on users.username OR users.email. Owner rows have a
        // password_hash; @sub.tcb anchor rows do not (their hash field is
        // null), so a non-null password_hash guard keeps us on the owner
        // path without accidentally matching anchor rows.
        // LOWER() on both sides — owners are stored lowercased today
        // (create-account normalizes), but if any future insert path
        // skips normalization, case-sensitive match would silently
        // lock the user out. Cheap defense.
        const user = await env.DB.prepare('SELECT * FROM users WHERE LOWER(username) = ? OR LOWER(email) = ?').bind(clean, clean).first();
        if (user && user.password_hash) {
          if (user.status === 'deleted') {
            await logAttempt(false);
            return jsonResponse({ error: 'Account has been deleted' }, 401);
          }
          if (hashHex === user.password_hash) {
            // Owner login success.
            await logAttempt(true);
            await clearFailures();
            const sessionId = generateId(48);
            const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
            await env.DB.prepare('INSERT INTO sessions (session_id, user_id, expires_at) VALUES (?, ?, ?)').bind(sessionId, user.id, expiresAt).run();
            let trialDaysLeft = null;
            if (user.plan === 'trial' && user.trial_ends) {
              trialDaysLeft = Math.max(0, Math.ceil((new Date(user.trial_ends) - new Date()) / 86400000));
            }
            return jsonResponse({
              success: true,
              sessionId,
              userId: user.id,
              username: user.username || clean,
              fullName: user.full_name,
              plan: user.plan,
              trialDaysLeft,
              isSubUser: false
            });
          }
          // Wrong owner password — fall through to sub-user try in case
          // this username also exists in sub_users (rare but possible).
        }

        // ---- Try sub_users ----
        // Query WITHOUT the status filter so we can distinguish revoked
        // from not-found/invalid in the response.
        const sub = await env.DB.prepare(
          'SELECT * FROM sub_users WHERE LOWER(username) = ?'
        ).bind(clean).first();

        if (sub && sub.password_hash === hashHex) {
          // Password matched. Check status.
          if (sub.status === 'revoked') {
            // Correct password, but account is disabled. Not the user's
            // fault — log as success so the lockout doesn't punish them
            // for a valid credential.
            await logAttempt(true);
            return jsonResponse({
              error: 'revoked',
              message: 'Your access has been revoked. Contact the campaign owner.'
            }, 401);
          }
          // Active sub-user login success.
          await logAttempt(true);
          await clearFailures();
          // Ensure the @sub.tcb anchor row exists (first-login bootstrap).
          let anchor = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(clean + '@sub.tcb').first();
          if (!anchor) {
            const uid = generateId();
            await env.DB.prepare('INSERT INTO users (id, email) VALUES (?, ?)').bind(uid, clean + '@sub.tcb').run();
            anchor = { id: uid };
          }
          const sessionId = generateId(48);
          const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
          await env.DB.prepare('INSERT INTO sessions (session_id, user_id, expires_at) VALUES (?, ?, ?)').bind(sessionId, anchor.id, expiresAt).run();
          await env.DB.prepare('UPDATE sub_users SET last_login = datetime(\'now\') WHERE id = ?').bind(sub.id).run();
          let perms = {};
          try { perms = JSON.parse(sub.permissions_json || '{}'); } catch (e) {}
          return jsonResponse({
            success: true,
            sessionId,
            userId: anchor.id,
            username: sub.username,
            isSubUser: true,
            name: sub.name,
            role: sub.role,
            permissions: perms,
            ownerUserId: sub.owner_id,
            mustChangePassword: sub.must_change_password === 1
          });
        }

        // Neither owner nor sub-user matched. Generic invalid.
        await logAttempt(false);
        return jsonResponse({ error: 'Invalid credentials' }, 401);
      } catch (error) {
        return jsonResponse({ error: error.message }, 500);
      }
    }

    // ========================================
    // AUTH: Check username availability
    // ========================================
    if (url.pathname.startsWith('/api/auth/check-username/') && request.method === 'GET') {
      try {
        const checkUser = decodeURIComponent(url.pathname.split('/').pop()).toLowerCase();
        // Check both tables for cross-table uniqueness.
        const existingUser = await env.DB.prepare('SELECT id FROM users WHERE LOWER(username) = ?').bind(checkUser).first();
        const existingSub = await env.DB.prepare('SELECT id FROM sub_users WHERE LOWER(username) = ?').bind(checkUser).first();
        const existing = !!(existingUser || existingSub);
        const suggestions = [];
        if (existing) {
          for (let i = 2; i <= 4; i++) {
            const alt = checkUser + i;
            const eU = await env.DB.prepare('SELECT id FROM users WHERE LOWER(username) = ?').bind(alt).first();
            const eS = await env.DB.prepare('SELECT id FROM sub_users WHERE LOWER(username) = ?').bind(alt).first();
            if (!eU && !eS) suggestions.push(alt);
          }
        }
        return jsonResponse({ available: !existing, suggestions });
      } catch (error) { return jsonResponse({ error: error.message }, 500); }
    }

    // ========================================
    // AUTH: Verify session
    // ========================================
    if (url.pathname === '/api/auth/verify-session' && request.method === 'GET') {
      try {
        const userId = await getUserFromSession(request);
        if (!userId) return jsonResponse({ error: 'Invalid session' }, 401);
        const user = await env.DB.prepare('SELECT id, username, email, full_name, plan, trial_ends, status FROM users WHERE id = ?').bind(userId).first();
        if (!user || user.status === 'deleted') return jsonResponse({ error: 'Account not found' }, 401);
        let trialDaysLeft = null;
        if (user.plan === 'trial' && user.trial_ends) { trialDaysLeft = Math.max(0, Math.ceil((new Date(user.trial_ends) - new Date()) / 86400000)); }
        // If this is a sub-user (email ends with @sub.tcb), return their
        // current permissions so the client can reflect updates without a
        // logout/login cycle. Owner users get the same response as before.
        let isSubUser = false;
        let permissions = null;
        let mustChangePassword = false;
        if (user.email && user.email.endsWith('@sub.tcb')) {
          const subUsername = user.email.replace(/@sub\.tcb$/, '');
          const subRow = await env.DB.prepare(
            'SELECT status, permissions_json, must_change_password FROM sub_users WHERE LOWER(username) = ?'
          ).bind(subUsername).first();
          if (subRow) {
            if (subRow.status === 'revoked') return jsonResponse({ error: 'Access revoked' }, 401);
            isSubUser = true;
            try { permissions = JSON.parse(subRow.permissions_json || '{}'); } catch (e) { permissions = {}; }
            mustChangePassword = subRow.must_change_password === 1;
          }
        }
        return jsonResponse({ success: true, userId: user.id, username: user.username, fullName: user.full_name, plan: user.plan, trialDaysLeft, isSubUser, permissions, mustChangePassword });
      } catch (error) { return jsonResponse({ error: error.message }, 500); }
    }

    // ========================================
    // AUTH: Change password (sub-user only for now)
    // Used by the forced-password-change takeover on first login.
    // Authenticated via session; no currentPassword needed because the
    // session itself proves identity — the user literally just typed the
    // old password to get here.
    // ========================================
    if (url.pathname === '/api/auth/change-password' && request.method === 'POST') {
      try {
        const ctx = await getSessionContext(request);
        if (!ctx) return jsonResponse({ error: 'Not authenticated' }, 401);
        if (ctx.revoked) return denyRevoked();
        if (!ctx.isSubUser) return denyOwnerOnly();
        const { newPassword } = await request.json();
        if (!newPassword || typeof newPassword !== 'string') {
          return jsonResponse({ error: 'Password required' }, 400);
        }
        if (newPassword.length < 8) {
          return jsonResponse({ error: 'weak_password', message: 'Password must be at least 8 characters.' }, 400);
        }
        // Require at least one number or symbol (beta-level complexity).
        if (!/[0-9\W_]/.test(newPassword)) {
          return jsonResponse({ error: 'weak_password', message: 'Password must include at least one number or symbol.' }, 400);
        }
        // Resolve the sub_users row via the anchor's email.
        const anchor = await env.DB.prepare('SELECT email FROM users WHERE id = ?').bind(ctx.userId).first();
        if (!anchor || !anchor.email || !anchor.email.endsWith('@sub.tcb')) {
          return jsonResponse({ error: 'Sub-user record not found' }, 404);
        }
        const subUsername = anchor.email.replace(/@sub\.tcb$/, '');
        const sub = await env.DB.prepare('SELECT id, password_hash FROM sub_users WHERE LOWER(username) = ?').bind(subUsername).first();
        if (!sub) return jsonResponse({ error: 'Sub-user record not found' }, 404);
        // Hash new password.
        const encoder = new TextEncoder();
        const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(newPassword + '_tcb_salt_2026'));
        const newHash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
        if (newHash === sub.password_hash) {
          return jsonResponse({ error: 'same_password', message: 'New password must be different from your current password.' }, 400);
        }
        await env.DB.prepare(
          "UPDATE sub_users SET password_hash = ?, must_change_password = 0, last_password_change_at = datetime('now') WHERE id = ?"
        ).bind(newHash, sub.id).run();
        return jsonResponse({ success: true });
      } catch (error) {
        return jsonResponse({ error: error.message }, 500);
      }
    }

    // ========================================
    // API: List campaigns for user
    // ========================================
    if (url.pathname === '/api/campaigns/list' && request.method === 'GET') {
      try {
        const ctx = await getSessionContext(request);
        if (!ctx) return jsonResponse({ error: 'Not authenticated' }, 401);
        if (ctx.revoked) return denyRevoked();
        // Sub-users see the OWNER's campaign list — their workspace is the owner's.
        const result = await env.DB.prepare('SELECT * FROM campaigns WHERE owner_id = ? ORDER BY status ASC, updated_at DESC').bind(ctx.ownerId).all();
        return jsonResponse({ success: true, campaigns: result.results || [] });
      } catch (error) { return jsonResponse({ error: error.message }, 500); }
    }

    // ========================================
    // API: Create campaign
    // ========================================
    if (url.pathname === '/api/campaigns/create' && request.method === 'POST') {
      try {
        const ctx = await getSessionContext(request);
        if (!ctx) return jsonResponse({ error: 'Not authenticated' }, 401);
        if (ctx.revoked) return denyRevoked();
        // Campaigns belong to owners. Sub-users can't create them.
        if (ctx.isSubUser) return denyOwnerOnly();
        const body = await request.json();
        const campaignId = generateId();
        await env.DB.prepare(
          'INSERT INTO campaigns (id, owner_id, candidate_name, party, specific_office, office_level, location, state, election_date, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).bind(campaignId, ctx.ownerId, body.candidateName || '', body.party || '', body.specificOffice || '', body.officeLevel || '', body.location || '', body.state || '', body.electionDate || '', 'active').run();
        return jsonResponse({ success: true, campaignId });
      } catch (error) { return jsonResponse({ error: error.message }, 500); }
    }

    // ========================================
    // API: Switch active campaign
    // ========================================
    if (url.pathname === '/api/campaigns/switch' && request.method === 'POST') {
      try {
        const ctx = await getSessionContext(request);
        if (!ctx) return jsonResponse({ error: 'Not authenticated' }, 401);
        if (ctx.revoked) return denyRevoked();
        const { campaignId } = await request.json();
        // Verify the workspace owns this campaign (not the session user —
        // sub-users can switch between the owner's campaigns).
        const campaign = await env.DB.prepare('SELECT * FROM campaigns WHERE id = ? AND owner_id = ?').bind(campaignId, ctx.ownerId).first();
        if (!campaign) return jsonResponse({ error: 'Campaign not found' }, 404);
        // Update session
        const authHeader = request.headers.get('Authorization');
        const sessionId = authHeader ? authHeader.slice(7) : null;
        if (sessionId) await env.DB.prepare('UPDATE sessions SET campaign_id = ? WHERE session_id = ?').bind(campaignId, sessionId).run();
        return jsonResponse({ success: true, campaign });
      } catch (error) { return jsonResponse({ error: error.message }, 500); }
    }

    // ========================================
    // API: Archive/restore campaign (reversible — just flips status)
    // ========================================
    if (url.pathname === '/api/campaigns/archive' && request.method === 'POST') {
      try {
        const ctx = await getSessionContext(request);
        if (!ctx) return jsonResponse({ error: 'Not authenticated' }, 401);
        if (ctx.revoked) return denyRevoked();
        if (ctx.isSubUser) return denyOwnerOnly();
        const { campaignId, action } = await request.json();
        const newStatus = action === 'restore' ? 'active' : 'archived';
        await env.DB.prepare('UPDATE campaigns SET status = ? WHERE id = ? AND owner_id = ?').bind(newStatus, campaignId, ctx.ownerId).run();
        return jsonResponse({ success: true, status: newStatus });
      } catch (error) { return jsonResponse({ error: error.message }, 500); }
    }

    // ========================================
    // API: Delete campaign (HARD delete — cascades all related rows)
    // Every workspace-scoped table with a campaign_id column is cleared.
    // ========================================
    if (url.pathname === '/api/campaigns/delete' && request.method === 'POST') {
      try {
        const ctx = await getSessionContext(request);
        if (!ctx) return jsonResponse({ error: 'Not authenticated' }, 401);
        if (ctx.revoked) return denyRevoked();
        if (ctx.isSubUser) return denyOwnerOnly();
        const { campaignId } = await request.json();
        if (!campaignId) return jsonResponse({ error: 'campaignId required' }, 400);
        // Verify ownership before cascading anything.
        const campaign = await env.DB.prepare(
          'SELECT id FROM campaigns WHERE id = ? AND owner_id = ?'
        ).bind(campaignId, ctx.ownerId).first();
        if (!campaign) return jsonResponse({ error: 'Campaign not found' }, 404);

        // Cascade-delete every table that carries a campaign_id column.
        // Scoped by workspace_owner_id so sub-user-authored rows in this
        // workspace also get wiped. chat_history and profiles have user_id
        // PKs (no per-campaign rows) and usage_logs has no campaign_id.
        const tables = [
          'opponents', 'tasks', 'events', 'notes', 'folders',
          'endorsements', 'contributions', 'budget', 'briefings'
        ];
        const ops = tables.map(t =>
          env.DB.prepare('DELETE FROM ' + t + ' WHERE campaign_id = ? AND workspace_owner_id = ?').bind(campaignId, ctx.ownerId)
        );
        // api_usage: preserve billing records but clear campaign_id.
        ops.push(env.DB.prepare('UPDATE api_usage SET campaign_id = NULL WHERE campaign_id = ? AND workspace_owner_id = ?').bind(campaignId, ctx.ownerId));
        // Finally, the campaign row itself.
        ops.push(env.DB.prepare('DELETE FROM campaigns WHERE id = ? AND owner_id = ?').bind(campaignId, ctx.ownerId));
        const results = await env.DB.batch(ops);

        const deletedCounts = {};
        tables.forEach((t, i) => { deletedCounts[t] = results[i] && results[i].meta ? results[i].meta.changes : 0; });
        console.log('[Campaign delete]', campaignId, 'workspace', ctx.ownerId, 'cascade:', JSON.stringify(deletedCounts));
        return jsonResponse({ success: true, deletedCounts });
      } catch (error) {
        console.error('[Campaign delete] Error:', error.message);
        return jsonResponse({ error: error.message }, 500);
      }
    }

    // ========================================
    // API: Create sub-user
    // ========================================
    if (url.pathname === '/api/users/create' && request.method === 'POST') {
      try {
        const ctx = await getSessionContext(request);
        if (!ctx) return jsonResponse({ error: 'Not authenticated' }, 401);
        if (ctx.revoked) return denyRevoked();
        if (ctx.isSubUser) return denyOwnerOnly();
        const { name, role, username, password, permissions } = await request.json();
        if (!name || !role || !username || !password) return jsonResponse({ error: 'All fields required' }, 400);
        // Check username available — both tables (cross-table uniqueness so
        // a sub-user can't collide with an owner and break unified login).
        const existingSub = await env.DB.prepare('SELECT id FROM sub_users WHERE LOWER(username) = LOWER(?)').bind(username).first();
        const existingOwner = await env.DB.prepare('SELECT id FROM users WHERE LOWER(username) = LOWER(?)').bind(username).first();
        if (existingSub || existingOwner) {
          // Offer suggestions like the owner-create endpoint does.
          const lowered = username.toLowerCase();
          const suggestions = [];
          for (let i = 2; i <= 4; i++) {
            const alt = lowered + i;
            const eU = await env.DB.prepare('SELECT id FROM users WHERE LOWER(username) = ?').bind(alt).first();
            const eS = await env.DB.prepare('SELECT id FROM sub_users WHERE LOWER(username) = ?').bind(alt).first();
            if (!eU && !eS) suggestions.push(alt);
          }
          return jsonResponse({ error: 'Username taken', suggestions }, 409);
        }
        // Hash password (simple SHA-256 for beta — upgrade to bcrypt later)
        const encoder = new TextEncoder();
        const data = encoder.encode(password + '_tcb_salt_2026');
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
        const subUserId = generateId();
        await env.DB.prepare(
          'INSERT INTO sub_users (id, owner_id, username, password_hash, name, role, permissions_json, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        ).bind(subUserId, ctx.ownerId, username, hashHex, name, role, JSON.stringify(permissions || {}), 'active').run();
        // Log activity
        await env.DB.prepare('INSERT INTO activity_log (id, user_id, user_name, action, details) VALUES (?, ?, ?, ?, ?)').bind(generateId(16), ctx.ownerId, 'Owner', 'Created sub-user', name + ' (' + role + ')').run();
        return jsonResponse({ success: true, userId: subUserId, username });
      } catch (error) {
        return jsonResponse({ error: error.message }, 500);
      }
    }

    // ========================================
    // API: List sub-users
    // ========================================
    if (url.pathname === '/api/users/list' && request.method === 'GET') {
      try {
        const ctx = await getSessionContext(request);
        if (!ctx) return jsonResponse({ error: 'Not authenticated' }, 401);
        if (ctx.revoked) return denyRevoked();
        if (ctx.isSubUser) return denyOwnerOnly();
        const result = await env.DB.prepare('SELECT id, username, name, role, permissions_json, status, created_at, last_login FROM sub_users WHERE owner_id = ? ORDER BY created_at DESC').bind(ctx.ownerId).all();
        const users = (result.results || []).map(u => ({
          id: u.id, username: u.username, name: u.name, role: u.role,
          permissions: JSON.parse(u.permissions_json || '{}'),
          status: u.status, created_at: u.created_at, last_login: u.last_login
        }));
        return jsonResponse({ success: true, users });
      } catch (error) {
        return jsonResponse({ error: error.message }, 500);
      }
    }

    // ========================================
    // API: Update sub-user permissions
    // ========================================
    if (url.pathname === '/api/users/update-permissions' && request.method === 'POST') {
      try {
        const ctx = await getSessionContext(request);
        if (!ctx) return jsonResponse({ error: 'Not authenticated' }, 401);
        if (ctx.revoked) return denyRevoked();
        if (ctx.isSubUser) return denyOwnerOnly();
        const { subUserId, permissions } = await request.json();
        if (!subUserId) return jsonResponse({ error: 'subUserId required' }, 400);
        if (!permissions || typeof permissions !== 'object') return jsonResponse({ error: 'permissions object required' }, 400);
        const owned = await env.DB.prepare(
          'SELECT id FROM sub_users WHERE id = ? AND owner_id = ?'
        ).bind(subUserId, ctx.ownerId).first();
        if (!owned) return jsonResponse({ error: 'Team member not found' }, 404);
        await env.DB.prepare(
          'UPDATE sub_users SET permissions_json = ? WHERE id = ? AND owner_id = ?'
        ).bind(JSON.stringify(permissions), subUserId, ctx.ownerId).run();
        return jsonResponse({ success: true });
      } catch (error) { return jsonResponse({ error: error.message }, 500); }
    }

    // ========================================
    // API: Revoke sub-user
    // ========================================
    if (url.pathname === '/api/users/revoke' && request.method === 'POST') {
      try {
        const ctx = await getSessionContext(request);
        if (!ctx) return jsonResponse({ error: 'Not authenticated' }, 401);
        if (ctx.revoked) return denyRevoked();
        if (ctx.isSubUser) return denyOwnerOnly();
        const { subUserId } = await request.json();
        await env.DB.prepare('UPDATE sub_users SET status = ? WHERE id = ? AND owner_id = ?').bind('revoked', subUserId, ctx.ownerId).run();
        // Delete their sessions
        const sub = await env.DB.prepare('SELECT username FROM sub_users WHERE id = ?').bind(subUserId).first();
        if (sub) {
          // Anchor emails are always stored lowercased (login normalizes
          // before insert), but sub_users.username preserves the as-typed
          // casing. Lowercase the lookup value — otherwise revoking a
          // mixed-case sub-user (e.g. "Kelly-mgr1") fails to find the
          // anchor, their sessions aren't deleted, and they stay logged
          // in until natural 30-day expiry.
          const subUser = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(sub.username.toLowerCase() + '@sub.tcb').first();
          if (subUser) await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(subUser.id).run();
        }
        return jsonResponse({ success: true });
      } catch (error) {
        return jsonResponse({ error: error.message }, 500);
      }
    }

    // ========================================
    // API: Reset sub-user password
    // Owner-only. Generates a new temp password, hashes + stores it, forces
    // change-on-next-login, deletes all sessions for that sub-user, audits.
    // The plaintext password is returned in the response exactly once —
    // never logged, never stored.
    // ========================================
    if (url.pathname === '/api/users/reset-password' && request.method === 'POST') {
      try {
        const ctx = await getSessionContext(request);
        if (!ctx) return jsonResponse({ error: 'Not authenticated' }, 401);
        if (ctx.revoked) return denyRevoked();
        if (ctx.isSubUser) return denyOwnerOnly();
        const { subUserId } = await request.json();
        if (!subUserId) return jsonResponse({ error: 'subUserId required' }, 400);

        // Ownership + status gate. Only active sub-users belonging to the
        // caller's workspace can have their password reset. Revoked
        // accounts have to be re-activated first (separate flow).
        const sub = await env.DB.prepare(
          'SELECT id, owner_id, username, name, status FROM sub_users WHERE id = ? AND owner_id = ?'
        ).bind(subUserId, ctx.ownerId).first();
        if (!sub) return jsonResponse({ error: 'Team member not found' }, 404);
        if (sub.status !== 'active') {
          return jsonResponse({ error: 'Sub-user is not active. Re-activate before resetting.' }, 400);
        }

        // Rate limit: max 3 resets per sub-user per hour. Queries
        // activity_log which is already where we audit this action — no
        // separate table needed. We store subUserId inside details so this
        // LIKE query can find it back.
        const recent = await env.DB.prepare(
          "SELECT COUNT(*) as n FROM activity_log WHERE action = 'Reset sub-user password' AND details LIKE ? AND created_at > datetime('now', '-1 hour')"
        ).bind('%' + subUserId + '%').first();
        if (recent && recent.n >= 3) {
          return jsonResponse({ error: 'rate_limited', message: 'Too many resets for this user in the last hour. Try again later.' }, 429);
        }

        // Generate the temp password. 7 alphanumeric + 1 symbol (same shape
        // as the create-user flow). Uses crypto.getRandomValues for proper
        // CSPRNG output — Math.random() is not adequate here even though
        // the client-side create flow uses it (known gap, tracked for
        // later; server-side reset goes through this path so at least the
        // reset-generated passwords are cryptographically random).
        const charset = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
        const symbols = '#@!$';
        const randBytes = new Uint8Array(8);
        crypto.getRandomValues(randBytes);
        let newPassword = '';
        for (let i = 0; i < 7; i++) newPassword += charset[randBytes[i] % charset.length];
        newPassword += symbols[randBytes[7] % symbols.length];

        // Hash with the same salt/algorithm used by login + change-password.
        const hashBuf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(newPassword + '_tcb_salt_2026'));
        const newHash = Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');

        // Update sub_users: new hash, flip must_change_password back on so
        // the forced-takeover fires on next login, stamp last_password_change_at.
        await env.DB.prepare(
          "UPDATE sub_users SET password_hash = ?, must_change_password = 1, last_password_change_at = datetime('now') WHERE id = ? AND owner_id = ?"
        ).bind(newHash, subUserId, ctx.ownerId).run();

        // Kill all active sessions for this sub-user's anchor so any
        // already-open tabs / devices get bounced to login on their next
        // authed call. Anchor email is LOWER(username) || '@sub.tcb' — same
        // pattern the revoke endpoint uses after the case-sensitivity fix.
        const anchor = await env.DB.prepare(
          'SELECT id FROM users WHERE email = ?'
        ).bind(sub.username.toLowerCase() + '@sub.tcb').first();
        if (anchor) {
          await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(anchor.id).run();
        }

        // Audit. Details includes subUserId so the rate-limit query above
        // can find it via LIKE. Deliberately does NOT record the plaintext
        // password anywhere — the response is the only place it appears.
        await env.DB.prepare(
          'INSERT INTO activity_log (id, user_id, user_name, action, details) VALUES (?, ?, ?, ?, ?)'
        ).bind(
          generateId(16), ctx.ownerId, 'Owner',
          'Reset sub-user password', sub.name + ' (' + subUserId + ')'
        ).run();

        return jsonResponse({ success: true, newPassword });
      } catch (error) {
        return jsonResponse({ error: error.message }, 500);
      }
    }

    // ========================================
    // API: Check username availability
    // ========================================
    if (url.pathname.startsWith('/api/users/check-username/') && request.method === 'GET') {
      try {
        const checkUsername = decodeURIComponent(url.pathname.split('/').pop()).toLowerCase();
        // Check both tables — same cross-table rule as /api/users/create.
        const existingSub = await env.DB.prepare('SELECT id FROM sub_users WHERE LOWER(username) = ?').bind(checkUsername).first();
        const existingOwner = await env.DB.prepare('SELECT id FROM users WHERE LOWER(username) = ?').bind(checkUsername).first();
        const existing = !!(existingSub || existingOwner);
        const suggestions = [];
        if (existing) {
          for (let i = 2; i <= 4; i++) {
            const alt = checkUsername.replace(/\d*$/, '') + i;
            const eS = await env.DB.prepare('SELECT id FROM sub_users WHERE LOWER(username) = ?').bind(alt).first();
            const eU = await env.DB.prepare('SELECT id FROM users WHERE LOWER(username) = ?').bind(alt).first();
            if (!eS && !eU) suggestions.push(alt);
          }
        }
        return jsonResponse({ available: !existing, suggestions }, 200, corsHeaders);
      } catch (error) {
        return jsonResponse({ error: error.message }, 500);
      }
    }

    // NOTE: /auth/subuser-login is handled by the unified /api/auth/login
    // route above via the pathname alias. Old standalone handler removed.

    // ========================================
    // AUTH: Send magic link
    // ========================================
    if (url.pathname === '/auth/login' && request.method === 'POST') {
      try {
        const { email } = await request.json();
        if (!email || !email.includes('@')) {
          return jsonResponse({ error: 'Valid email required' }, 400);
        }
        const cleanEmail = email.toLowerCase().trim();

        // Find or create user
        let user = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(cleanEmail).first();
        if (!user) {
          const userId = generateId();
          await env.DB.prepare('INSERT INTO users (id, email) VALUES (?, ?)').bind(userId, cleanEmail).run();
          user = { id: userId };
        }

        // Create magic link token (expires in 15 minutes)
        const token = generateId(48);
        const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
        await env.DB.prepare(
          'INSERT INTO auth_tokens (token, user_id, expires_at) VALUES (?, ?, ?)'
        ).bind(token, user.id, expiresAt).run();

        // Build magic link
        const appUrl = 'https://thecandidatestoolbox.com/app';
        const magicLink = appUrl + '?auth_token=' + token;

        // Send email via Resend
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + env.RESEND_API_KEY,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            from: 'Candidate Tool Box <sam@thecandidatestoolbox.com>',
            to: [cleanEmail],
            subject: 'Your Candidate\'s Toolbox Login Link',
            html: '<div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 20px;">' +
              '<h2 style="color: #1a1a2e;">The Candidate\'s Toolbox</h2>' +
              '<p>Click the button below to log in. This link expires in 15 minutes.</p>' +
              '<a href="' + magicLink + '" style="display: inline-block; background: #16213e; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; margin: 16px 0;">Log In to Your Campaign</a>' +
              '<p style="color: #666; font-size: 13px;">If you didn\'t request this, you can ignore this email.</p>' +
              '</div>'
          })
        });

        return jsonResponse({ success: true, message: 'Check your email for a login link' });
      } catch (error) {
        return jsonResponse({ error: error.message }, 500);
      }
    }

    // ========================================
    // AUTH: Verify magic link token
    // ========================================
    if (url.pathname === '/auth/verify' && request.method === 'POST') {
      try {
        const { token } = await request.json();
        if (!token) return jsonResponse({ error: 'Token required' }, 400);

        const authToken = await env.DB.prepare(
          'SELECT user_id, used FROM auth_tokens WHERE token = ? AND expires_at > datetime(\'now\')'
        ).bind(token).first();

        if (!authToken) return jsonResponse({ error: 'Invalid or expired link' }, 401);
        if (authToken.used) return jsonResponse({ error: 'Link already used' }, 401);

        // Mark token as used
        await env.DB.prepare('UPDATE auth_tokens SET used = 1 WHERE token = ?').bind(token).run();

        // Create session (30 days)
        const sessionId = generateId(48);
        const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
        await env.DB.prepare(
          'INSERT INTO sessions (session_id, user_id, expires_at) VALUES (?, ?, ?)'
        ).bind(sessionId, authToken.user_id, expiresAt).run();

        // Get user email
        const user = await env.DB.prepare('SELECT email FROM users WHERE id = ?').bind(authToken.user_id).first();

        return jsonResponse({ success: true, sessionId, email: user.email });
      } catch (error) {
        return jsonResponse({ error: error.message }, 500);
      }
    }

    // ========================================
    // AUTH: Check session
    // ========================================
    if (url.pathname === '/auth/session' && request.method === 'POST') {
      try {
        const userId = await getUserFromSession(request);
        if (!userId) return jsonResponse({ error: 'Not authenticated' }, 401);
        const user = await env.DB.prepare('SELECT email FROM users WHERE id = ?').bind(userId).first();
        return jsonResponse({ success: true, email: user.email, userId });
      } catch (error) {
        return jsonResponse({ error: error.message }, 500);
      }
    }

    // ========================================
    // AUTH: Logout
    // ========================================
    if (url.pathname === '/auth/logout' && request.method === 'POST') {
      try {
        const authHeader = request.headers.get('Authorization');
        if (authHeader && authHeader.startsWith('Bearer ')) {
          const sessionId = authHeader.slice(7);
          await env.DB.prepare('DELETE FROM sessions WHERE session_id = ?').bind(sessionId).run();
        }
        return jsonResponse({ success: true });
      } catch (error) {
        return jsonResponse({ error: error.message }, 500);
      }
    }

    // ========================================
    // DATA API: Save Profile
    // ========================================
    if (url.pathname === '/api/profile/save' && request.method === 'POST') {
      try {
        const ctx = await getSessionContext(request);
        if (!ctx) return jsonResponse({ error: 'Not authenticated' }, 401);
        if (ctx.revoked) return denyRevoked();
        // Profile is the candidate/race identity. Owner-only.
        if (ctx.isSubUser) return denyOwnerOnly();

        const data = await request.json();

        await env.DB.prepare(`
          INSERT INTO profiles (user_id, candidate_name, specific_office, office_level, party, location, state, election_date, filing_status, win_number, win_number_data, onboarding_complete, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
          ON CONFLICT(user_id) DO UPDATE SET
            candidate_name = excluded.candidate_name,
            specific_office = excluded.specific_office,
            office_level = excluded.office_level,
            party = excluded.party,
            location = excluded.location,
            state = excluded.state,
            election_date = excluded.election_date,
            filing_status = excluded.filing_status,
            win_number = excluded.win_number,
            win_number_data = excluded.win_number_data,
            onboarding_complete = excluded.onboarding_complete,
            updated_at = datetime('now')
        `).bind(
          ctx.ownerId,
          data.candidate_name || null,
          data.specific_office || null,
          data.office_level || null,
          data.party || null,
          data.location || null,
          data.state || null,
          data.election_date || null,
          data.filing_status || null,
          data.win_number || null,
          data.win_number_data ? JSON.stringify(data.win_number_data) : null,
          data.onboarding_complete ? 1 : 0
        ).run();

        return jsonResponse({ success: true });
      } catch (error) {
        return jsonResponse({ error: error.message }, 500);
      }
    }

    // ========================================
    // DATA API: Load Profile
    // ========================================
    if (url.pathname === '/api/profile/load' && request.method === 'GET') {
      try {
        const ctx = await getSessionContext(request);
        if (!ctx) return jsonResponse({ error: 'Not authenticated' }, 401);
        if (ctx.revoked) return denyRevoked();

        const profile = await env.DB.prepare(
          'SELECT * FROM profiles WHERE user_id = ?'
        ).bind(ctx.ownerId).first();

        if (!profile) return jsonResponse({ success: true, profile: null });

        // Parse win_number_data JSON if present
        if (profile.win_number_data) {
          try { profile.win_number_data = JSON.parse(profile.win_number_data); } catch (e) { /* leave as string */ }
        }

        return jsonResponse({ success: true, profile });
      } catch (error) {
        return jsonResponse({ error: error.message }, 500);
      }
    }

    // ========================================
    // DATA API: Sync Tasks (full replace)
    // @deprecated 2026-04-22 — use /api/tasks/save + /api/tasks/delete.
    // The per-row endpoints fix the stale-client write race. Remove this
    // sync endpoint after a week of clean traffic against the per-row path.
    // ========================================
    if (url.pathname === '/api/tasks/sync' && request.method === 'POST') {
      try {
        const ctx = await getSessionContext(request);
        if (!ctx) return jsonResponse({ error: 'Not authenticated' }, 401);
        if (ctx.revoked) return denyRevoked();
        if (!requirePermission(ctx, 'calendar', 'full')) return denyPermission('calendar');

        const { tasks } = await request.json();
        const list = tasks || [];
        const incomingIds = list.map(t => String(t.id));

        // Delete workspace rows that are NOT in the incoming set (handles
        // client-side deletions without wiping rows others created).
        if (incomingIds.length > 0) {
          const placeholders = incomingIds.map(() => '?').join(',');
          await env.DB.prepare('DELETE FROM tasks WHERE workspace_owner_id = ? AND id NOT IN (' + placeholders + ')').bind(ctx.ownerId, ...incomingIds).run();
        } else {
          await env.DB.prepare('DELETE FROM tasks WHERE workspace_owner_id = ?').bind(ctx.ownerId).run();
        }

        // Upsert each task. ON CONFLICT preserves the original user_id (the
        // row's author), workspace_owner_id, and created_at — so a sub-user's
        // sync doesn't rewrite attribution on rows they didn't create.
        if (list.length > 0) {
          const stmt = env.DB.prepare(
            'INSERT INTO tasks (id, user_id, workspace_owner_id, name, date, category, completed, campaign_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
            'ON CONFLICT(id) DO UPDATE SET name = excluded.name, date = excluded.date, category = excluded.category, completed = excluded.completed, campaign_id = excluded.campaign_id'
          );
          const batch = list.map(t => stmt.bind(
            String(t.id),
            ctx.userId,
            ctx.ownerId,
            t.name || t.text || '',
            t.date || null,
            t.category || 'other',
            t.completed ? 1 : 0,
            t.campaign_id || null,
            t.created_at || new Date().toISOString()
          ));
          await env.DB.batch(batch);
        }

        return jsonResponse({ success: true, count: list.length });
      } catch (error) {
        return jsonResponse({ error: error.message }, 500);
      }
    }

    // ========================================
    // DATA API: Load Tasks
    // ========================================
    if (url.pathname === '/api/tasks/load' && request.method === 'GET') {
      try {
        const ctx = await getSessionContext(request);
        if (!ctx) return jsonResponse({ error: 'Not authenticated' }, 401);
        if (ctx.revoked) return denyRevoked();
        if (!requirePermission(ctx, 'calendar', 'read')) return denyPermission('calendar');

        const result = await env.DB.prepare(
          'SELECT * FROM tasks WHERE workspace_owner_id = ? ORDER BY date ASC'
        ).bind(ctx.ownerId).all();

        // Convert D1 rows back to app format. user_id exposed for
        // attribution ("Added by [Name]") rendering on the client.
        const tasks = (result.results || []).map(row => ({
          id: parseFloat(row.id) || row.id,
          name: row.name,
          text: row.name,
          date: row.date,
          category: row.category,
          completed: row.completed === 1,
          created_at: row.created_at,
          user_id: row.user_id
        }));

        return jsonResponse({ success: true, tasks });
      } catch (error) {
        return jsonResponse({ error: error.message }, 500);
      }
    }

    // ========================================
    // DATA API: Sync Events (full replace)
    // @deprecated 2026-04-22 — use /api/events/save + /api/events/delete.
    // ========================================
    if (url.pathname === '/api/events/sync' && request.method === 'POST') {
      try {
        const ctx = await getSessionContext(request);
        if (!ctx) return jsonResponse({ error: 'Not authenticated' }, 401);
        if (ctx.revoked) return denyRevoked();
        if (!requirePermission(ctx, 'calendar', 'full')) return denyPermission('calendar');

        const { events } = await request.json();
        const list = events || [];
        const incomingIds = list.map(e => String(e.id));

        if (incomingIds.length > 0) {
          const placeholders = incomingIds.map(() => '?').join(',');
          await env.DB.prepare('DELETE FROM events WHERE workspace_owner_id = ? AND id NOT IN (' + placeholders + ')').bind(ctx.ownerId, ...incomingIds).run();
        } else {
          await env.DB.prepare('DELETE FROM events WHERE workspace_owner_id = ?').bind(ctx.ownerId).run();
        }

        if (list.length > 0) {
          const stmt = env.DB.prepare(
            'INSERT INTO events (id, user_id, workspace_owner_id, name, date, time, end_time, location, campaign_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
            'ON CONFLICT(id) DO UPDATE SET name = excluded.name, date = excluded.date, time = excluded.time, end_time = excluded.end_time, location = excluded.location, campaign_id = excluded.campaign_id'
          );
          const batch = list.map(e => stmt.bind(
            String(e.id),
            ctx.userId,
            ctx.ownerId,
            e.name || e.title || '',
            e.date || null,
            e.time || null,
            e.end_time || e.endTime || null,
            e.location || null,
            e.campaign_id || null,
            e.created_at || new Date().toISOString()
          ));
          await env.DB.batch(batch);
        }

        return jsonResponse({ success: true, count: list.length });
      } catch (error) {
        return jsonResponse({ error: error.message }, 500);
      }
    }

    // ========================================
    // DATA API: Load Events
    // ========================================
    if (url.pathname === '/api/events/load' && request.method === 'GET') {
      try {
        const ctx = await getSessionContext(request);
        if (!ctx) return jsonResponse({ error: 'Not authenticated' }, 401);
        if (ctx.revoked) return denyRevoked();
        if (!requirePermission(ctx, 'calendar', 'read')) return denyPermission('calendar');

        const result = await env.DB.prepare(
          'SELECT * FROM events WHERE workspace_owner_id = ? ORDER BY date ASC'
        ).bind(ctx.ownerId).all();

        const events = (result.results || []).map(row => ({
          id: parseFloat(row.id) || row.id,
          name: row.name,
          title: row.name,
          date: row.date,
          time: row.time,
          end_time: row.end_time,
          endTime: row.end_time,
          location: row.location,
          created_at: row.created_at,
          user_id: row.user_id
        }));

        return jsonResponse({ success: true, events });
      } catch (error) {
        return jsonResponse({ error: error.message }, 500);
      }
    }

    // ========================================
    // DATA API: Save Budget
    // ========================================
    if (url.pathname === '/api/budget/save' && request.method === 'POST') {
      try {
        const ctx = await getSessionContext(request);
        if (!ctx) return jsonResponse({ error: 'Not authenticated' }, 401);
        if (ctx.revoked) return denyRevoked();
        if (!requirePermission(ctx, 'budget', 'full')) return denyPermission('budget');

        const { budget } = await request.json();

        // Budget is per-workspace. One row keyed to owner's users.id.
        // workspace_owner_id == user_id == owner's id (redundant for
        // consistency with other tables' scoping queries).
        //
        // Categories serialization: the client historically pre-stringified
        // categories before sending, then this endpoint stringified again,
        // resulting in a double-encoded JSON-string-of-a-string in D1.
        // Both halves of that bug are being fixed in the same commit:
        //   - Client now sends the categories OBJECT directly.
        //   - Worker normalizes: if input is a string (in-flight requests
        //     from cached old client code), parse it and re-stringify
        //     cleanly; if object, stringify once. Result is always a
        //     single-encoded JSON string in the column.
        let catsRaw = budget.categories;
        if (typeof catsRaw === 'string') {
          try { catsRaw = JSON.parse(catsRaw); } catch (e) { catsRaw = {}; }
        }
        const categoriesJson = JSON.stringify(catsRaw || {});
        // NOTE: budget table is keyed on user_id (one row per workspace
        // owner) and does NOT have a separate workspace_owner_id column.
        // Earlier code referenced workspace_owner_id in the INSERT — that
        // was a bug left over from the C5 write refactor and caused
        // every budget save to fail silently (d1Write is fire-and-forget,
        // so the SQLITE_ERROR was swallowed). Schema confirmed via PRAGMA:
        // budget has user_id, total, categories, updated_at, campaign_id.
        await env.DB.prepare(`
          INSERT INTO budget (user_id, total, categories, updated_at)
          VALUES (?, ?, ?, datetime('now'))
          ON CONFLICT(user_id) DO UPDATE SET
            total = excluded.total,
            categories = excluded.categories,
            updated_at = datetime('now')
        `).bind(
          ctx.ownerId,
          budget.total || 0,
          categoriesJson
        ).run();

        return jsonResponse({ success: true });
      } catch (error) {
        return jsonResponse({ error: error.message }, 500);
      }
    }

    // ========================================
    // DATA API: Load Budget
    // ========================================
    if (url.pathname === '/api/budget/load' && request.method === 'GET') {
      try {
        const ctx = await getSessionContext(request);
        if (!ctx) return jsonResponse({ error: 'Not authenticated' }, 401);
        if (ctx.revoked) return denyRevoked();
        if (!requirePermission(ctx, 'budget', 'read')) return denyPermission('budget');

        // Budget is per-workspace — one row keyed to the owner's users.id.
        const row = await env.DB.prepare(
          'SELECT * FROM budget WHERE user_id = ?'
        ).bind(ctx.ownerId).first();

        if (!row) return jsonResponse({ success: true, budget: null });

        // Defensive parse: legacy rows are double-encoded (a JSON string
        // wrapping another JSON string) due to the old client/worker
        // both stringifying. Single parse leaves a string; check and
        // parse again if so. New writes (post-fix) are single-encoded
        // and the second parse is skipped.
        let cats = JSON.parse(row.categories || '{}');
        if (typeof cats === 'string') {
          try { cats = JSON.parse(cats); } catch (e) { cats = {}; }
        }
        const budget = {
          total: row.total,
          categories: cats,
          updated_at: row.updated_at
        };

        return jsonResponse({ success: true, budget });
      } catch (error) {
        return jsonResponse({ error: error.message }, 500);
      }
    }

    // ========================================
    // DATA API: Sam's Take Today (budget coaching)
    //
    // Generates or returns a cached 3-4 sentence coaching paragraph for
    // the candidate's current budget state. Cached for 24 hours per
    // workspace in budget_sams_take. Refresh button on the client is
    // disabled until the cache is older than 24h; the server enforces
    // the same TTL so manual API hits can't burn quota.
    //
    // Request body shape (client supplies the snapshot — expenses live
    // in client localStorage today, so the spent figures are NOT
    // server-authoritative; we accept what the client sends, persist it
    // into budget_snapshot for audit, and feed it to the prompt):
    //   {
    //     campaign_id?: string,
    //     forceRefresh?: boolean,
    //     budgetSnapshot: {
    //       total: number,
    //       categories: { [key]: { label, allocated, spent } },
    //       daysToElection: number | null,
    //       raisedSoFar: number
    //     }
    //   }
    //
    // Response:
    //   {
    //     success: true,
    //     content: string,
    //     generatedAt: string (ISO),
    //     fromCache: boolean,
    //     nextRefreshAvailableAt: string (ISO)
    //   }
    // ========================================
    if (url.pathname === '/api/budget/sams-take' && request.method === 'POST') {
      try {
        const ctx = await getSessionContext(request);
        if (!ctx) return jsonResponse({ error: 'Not authenticated' }, 401);
        if (ctx.revoked) return denyRevoked();
        if (!requirePermission(ctx, 'budget', 'read')) return denyPermission('budget');

        const body = await request.json().catch(() => ({}));
        const forceRefresh = !!body.forceRefresh;
        const campaignId = body.campaign_id || null;
        const snap = body.budgetSnapshot || {};

        // Read cached row.
        const cached = await env.DB.prepare(
          'SELECT content, generated_at, campaign_id FROM budget_sams_take WHERE workspace_owner_id = ?'
        ).bind(ctx.ownerId).first();

        const isFresh = (gen) => {
          if (!gen) return false;
          // generated_at stored as 'YYYY-MM-DD HH:MM:SS' (datetime('now') format)
          // or ISO. Parse robustly.
          const t = Date.parse(gen.replace(' ', 'T') + (gen.indexOf('Z') >= 0 ? '' : 'Z'));
          if (isNaN(t)) return false;
          return (Date.now() - t) < 24 * 60 * 60 * 1000;
        };

        if (cached && isFresh(cached.generated_at) && !forceRefresh) {
          const genIso = cached.generated_at.replace(' ', 'T') + (cached.generated_at.indexOf('Z') >= 0 ? '' : 'Z');
          const next = new Date(Date.parse(genIso) + 24 * 60 * 60 * 1000).toISOString();
          return jsonResponse({
            success: true,
            content: cached.content,
            generatedAt: new Date(Date.parse(genIso)).toISOString(),
            fromCache: true,
            nextRefreshAvailableAt: next
          });
        }

        // Force-refresh-while-fresh is rejected unless 24h elapsed. Belt
        // and suspenders for the client's button-disable: a malicious or
        // buggy client can't bypass quota by just sending forceRefresh.
        if (cached && isFresh(cached.generated_at) && forceRefresh) {
          const genIso = cached.generated_at.replace(' ', 'T') + (cached.generated_at.indexOf('Z') >= 0 ? '' : 'Z');
          const next = new Date(Date.parse(genIso) + 24 * 60 * 60 * 1000).toISOString();
          return jsonResponse({
            success: true,
            content: cached.content,
            generatedAt: new Date(Date.parse(genIso)).toISOString(),
            fromCache: true,
            nextRefreshAvailableAt: next,
            note: 'Refresh not yet available; returning cached.'
          });
        }

        // Cache miss or expired — generate. Pull race profile from D1
        // for context the client doesn't need to send.
        const profile = await env.DB.prepare(
          'SELECT candidate_name, specific_office, office_level, party, location, state, election_date FROM profiles WHERE user_id = ?'
        ).bind(ctx.ownerId).first();

        // Build the budget data block for the prompt. Numbers come from
        // the client snapshot; if categories[key] is missing fields, fall
        // back to 0. We deliberately do NOT enrich with anything Sam
        // could mistake for an external benchmark.
        //
        // Custom categories — those with isCustom: true on the snapshot —
        // are inline-tagged "(custom)" so Sam can see at a glance which
        // names are user-defined and apply rule 6 (no fabricated planning
        // ranges for them). The label used is displayName for custom
        // rows, falling through to label / key for canonical.
        const cats = snap.categories || {};
        const lines = [];
        for (const k of Object.keys(cats)) {
          const c = cats[k] || {};
          const isCustom = c.isCustom === true;
          const label = isCustom
            ? (c.displayName || c.label || k)
            : (c.label || k);
          const allocated = Number(c.allocated || 0);
          const spent = Number(c.spent || 0);
          const tag = isCustom ? ' (custom)' : '';
          lines.push('  - ' + label + tag + ': $' + allocated.toLocaleString('en-US') + ' allocated / $' + spent.toLocaleString('en-US') + ' spent');
        }
        const total = Number(snap.total || 0);
        const raised = Number(snap.raisedSoFar || 0);
        const days = snap.daysToElection;
        const daysLine = (days != null && !isNaN(days)) ? (days + ' days') : 'unknown';

        const candidateName = (profile && profile.candidate_name) || 'the candidate';
        const office = (profile && profile.specific_office) || 'office';
        const officeLevel = (profile && profile.office_level) || '';
        const party = (profile && profile.party) || '';
        const loc = [profile && profile.location, profile && profile.state].filter(Boolean).join(', ');

        const systemPrompt =
          'You are Sam, a campaign budget coach speaking to ' + candidateName + '. ' +
          'Generate exactly 3-4 sentences of coaching about their current budget state. ' +
          'Plain text, no markdown, no bullet points, no headings.\n\n' +
          'CONTEXT (the only data you may reference for specific numbers):\n' +
          '  Race: ' + (party ? party + ' ' : '') + (officeLevel ? officeLevel + ' ' : '') + office + (loc ? ' in ' + loc : '') + '\n' +
          '  Days to election: ' + daysLine + '\n' +
          '  Total budget reserve: $' + total.toLocaleString('en-US') + '\n' +
          '  Total raised so far: $' + raised.toLocaleString('en-US') + '\n' +
          '  Categories (allocated / spent):\n' +
          (lines.length > 0 ? lines.join('\n') : '  - (no categories set yet)') +
          '\n\n' +
          'RULES (strict):\n' +
          '  1. FACTUAL DISCIPLINE. Every dollar amount or percentage in your output must come from the data above. ' +
          'Never invent specific competitor figures, peer benchmarks, or external statistics. If you reference an ' +
          'allocation guideline, frame it as a planning range ("a common planning range is 20-25%") rather than as ' +
          'an asserted fact about other candidates.\n' +
          '  2. AVOID ALARMISM. No urgency theatrics. No "you must act now or you will lose." Calm, professional, ' +
          'factual tone — like a trusted advisor reviewing a balance sheet, not a direct-mail fundraiser.\n' +
          '  3. ACKNOWLEDGE WHAT IS WORKING. If categories are on track, lead with that before pointing at problems. ' +
          'If everything is on track, say so plainly. Pure criticism is not the deliverable.\n' +
          '  4. CITE AT LEAST ONE SPECIFIC CATEGORY by name (over-allocated, under-allocated, or on track), using ' +
          'the labels exactly as written above.\n' +
          '  5. END WITH ONE CONCRETE NEXT ACTION the candidate can take. No vague "consider reviewing your spend"; ' +
          'something specific like "redirect $X from Reserve into Direct Mail" or "set an allocation for Polling, ' +
          'currently at $0".\n' +
          '  5a. DAYS-TO-ELECTION PLACEHOLDER. When you reference the days-until-election count anywhere in your ' +
          'output, write the literal token [DAYS] instead of the actual number. Example: write "you have [DAYS] days ' +
          'until election day" — NOT "you have ' + daysLine + ' until election day". The app substitutes the live ' +
          'count at render time so your coaching stays accurate as time passes (the cache is 24h, but the day count ' +
          'changes every 24h). Use the actual number from the data block above for your own reasoning about ' +
          'urgency / phase / pacing — just never write it as a digit in the output. The "[DAYS]" string must appear ' +
          'literally in your text wherever you would otherwise have written a day count.\n' +
          '  6. CUSTOM CATEGORIES are user-defined (tagged "(custom)" in the data above) and may not match standard ' +
          'campaign categories. Don\'t make assumptions about what they should be funded at — there is no peer ' +
          'benchmark for items like "Religious Outreach" or "Video Production". Reference them by their exact name ' +
          'when commenting on over- or under-budget situations, but DO NOT cite planning-range percentages for them ' +
          '(no "a typical 5–10% planning range" — that\'s only valid for canonical categories you have benchmarks for). ' +
          'Treat them the same as canonical categories for over/under-budget commentary; just skip the benchmark.';

        const apiResp = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 400,
            temperature: 0.4,
            system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
            messages: [{ role: 'user', content: 'Generate the coaching paragraph now.' }]
          })
        });
        const apiData = await apiResp.json();
        await logApiUsage('sams_take_anthropic', apiData, ctx.userId, ctx.ownerId);

        let content = '';
        if (apiData && apiData.content && Array.isArray(apiData.content)) {
          for (const block of apiData.content) {
            if (block.type === 'text' && block.text) content += block.text;
          }
        }
        content = (content || '').trim();
        if (!content) {
          return jsonResponse({ error: 'generation_failed', message: 'Sam could not generate a take right now. Try again in a moment.' }, 502);
        }

        // Persist (UPSERT — one row per workspace).
        const nowIso = new Date().toISOString();
        await env.DB.prepare(
          'INSERT INTO budget_sams_take (workspace_owner_id, campaign_id, content, generated_at, budget_snapshot) VALUES (?, ?, ?, ?, ?) ' +
          'ON CONFLICT(workspace_owner_id) DO UPDATE SET campaign_id = excluded.campaign_id, content = excluded.content, generated_at = excluded.generated_at, budget_snapshot = excluded.budget_snapshot'
        ).bind(
          ctx.ownerId,
          campaignId,
          content,
          nowIso,
          JSON.stringify(snap)
        ).run();

        const next = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
        return jsonResponse({
          success: true,
          content,
          generatedAt: nowIso,
          fromCache: false,
          nextRefreshAvailableAt: next
        });
      } catch (error) {
        return jsonResponse({ error: error.message }, 500);
      }
    }

    // ========================================
    // FORENSICS: Sam per-turn log
    //
    // Built 2026-04-25 after the lookup_jurisdiction-was-ignored bug
    // (Sam called the tool, received the correct exclusion list, then
    // hallucinated Altamonte Springs anyway). The worker only sees
    // sam_chat token counts via api_usage; tool execution happens
    // client-side and is opaque server-side. This endpoint accepts a
    // structured per-turn forensic log so we can later query for
    // "Sam called tool X but her response contradicts the result".
    //
    // Fire-and-forget from the client. Logging failure must NEVER
    // block the chat flow — endpoint always returns 200.
    // ========================================
    if (url.pathname === '/api/sam/turn-log' && request.method === 'POST') {
      try {
        const ctx = await getSessionContext(request);
        if (!ctx) return jsonResponse({ success: true, skipped: 'unauth' });
        const body = await request.json().catch(() => ({}));
        const trunc = (s, n) => {
          if (s == null) return null;
          const str = String(s);
          return str.length > n ? str.slice(0, n) + '…' : str;
        };
        await env.DB.prepare(
          'INSERT INTO sam_turn_logs (id, user_id, workspace_owner_id, conversation_id, user_message, tool_calls, response_excerpt) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).bind(
          generateId(16),
          ctx.userId,
          ctx.ownerId,
          body.conversation_id || null,
          trunc(body.user_message, 500),
          JSON.stringify(body.tool_calls || []),
          trunc(body.response_excerpt, 800)
        ).run();
        return jsonResponse({ success: true });
      } catch (error) {
        // Swallow errors — logging must not break chat.
        return jsonResponse({ success: true, error: error.message });
      }
    }

    // ========================================
    // SAM CONVERSATION RESET
    //
    // Purges sam_tool_memory rows for a conversation_id. Called by
    // the client when the user fires /new chat — the client rotates
    // to a fresh conversation_id and asks the server to drop the
    // old conversation's tool memory so it can't bleed into the
    // next conversation. (Orphan rows from conversations that ended
    // without an explicit reset will sit until a sweep cron is
    // built; harmless, just space.)
    //
    // Auth: requires a session. Scoped to the caller's
    // workspace_owner_id so a sub-user can only purge memory in
    // their own workspace, not someone else's.
    // ========================================
    if (url.pathname === '/api/sam/conversation/reset' && request.method === 'POST') {
      try {
        const ctx = await getSessionContext(request);
        if (!ctx) return jsonResponse({ success: false, error: 'unauthenticated' }, 401);
        if (ctx.revoked) return denyRevoked();
        const body = await request.json().catch(() => ({}));
        const conversationId = body.conversation_id;
        if (!conversationId) return jsonResponse({ success: false, error: 'conversation_id required' }, 400);
        const result = await env.DB.prepare(
          'DELETE FROM sam_tool_memory WHERE conversation_id = ? AND (workspace_owner_id = ? OR workspace_owner_id IS NULL)'
        ).bind(conversationId, ctx.ownerId || '').run();
        return jsonResponse({ success: true, purged: result.meta ? result.meta.changes : 0 });
      } catch (error) {
        return jsonResponse({ success: false, error: error.message }, 500);
      }
    }

    // ========================================
    // DATA API: lookup_jurisdiction
    //
    // Returns the verified list of incorporated municipalities and
    // unincorporated areas inside a candidate's race jurisdiction.
    // Backs the lookup_jurisdiction Sam tool — gives her a real source
    // of geographic truth so she stops hallucinating adjacent-county
    // cities (the bug that prompted this: she suggested Altamonte
    // Springs / Sanford for an Orange County FL race; both are in
    // Seminole County).
    //
    // Cache: 90 days, keyed on (office, state, jurisdiction_name) via
    // a UNIQUE index. Jurisdiction containment is stable data;
    // refresh-by-deletion if the user reports a stale entry post-
    // redistricting.
    //
    // Source cascade per the spec: Census → OpenStates → Wikipedia.
    // In practice each source covers different jurisdiction types:
    //   - county / city  → Wikipedia category-members API (structured,
    //                      no scraping; returns clean municipality
    //                      lists for any US county)
    //   - us_house_district / state_legislative_district → not yet
    //                      implemented; returns a "source: unsupported"
    //                      result so Sam can fall back gracefully
    //                      (Census Tigerweb + OpenStates are the
    //                      planned paths; out of scope today)
    //   - city           → identity (the city IS the jurisdiction; no
    //                      sub-jurisdictions to enumerate)
    // ========================================
    if (url.pathname === '/api/jurisdiction/lookup' && request.method === 'POST') {
      try {
        const ctx = await getSessionContext(request);
        if (!ctx) return jsonResponse({ error: 'Not authenticated' }, 401);
        if (ctx.revoked) return denyRevoked();
        const body = await request.json().catch(() => ({}));
        const office = (body.office || '').trim();
        const state = (body.state || '').trim();
        const jurisdictionName = (body.jurisdiction_name || '').trim();
        if (!office || !state || !jurisdictionName) {
          return jsonResponse({ error: 'office, state, jurisdiction_name required' }, 400);
        }

        // Cache check (90-day TTL).
        const cached = await env.DB.prepare(
          "SELECT jurisdiction_type, official_name, incorporated_municipalities, major_unincorporated_areas, source, last_updated FROM jurisdiction_lookups WHERE office = ? AND state = ? AND jurisdiction_name = ? AND created_at > datetime('now', '-90 days')"
        ).bind(office, state, jurisdictionName).first();

        if (cached) {
          return jsonResponse({
            jurisdiction_type: cached.jurisdiction_type,
            official_name: cached.official_name,
            incorporated_municipalities: JSON.parse(cached.incorporated_municipalities || '[]'),
            major_unincorporated_areas: JSON.parse(cached.major_unincorporated_areas || '[]'),
            source: cached.source,
            last_updated: cached.last_updated,
            cached: true
          });
        }

        // Cache miss — resolve via the appropriate source for this
        // jurisdiction type.
        const type = detectJurisdictionType(office, jurisdictionName);
        let result;
        if (type === 'county') {
          result = await resolveCountyViaWikipedia(jurisdictionName, state);
        } else if (type === 'city') {
          // Identity: the city IS the jurisdiction. No external lookup.
          result = {
            jurisdiction_type: 'city',
            official_name: jurisdictionName + ', ' + expandStateName(state),
            incorporated_municipalities: [jurisdictionName],
            major_unincorporated_areas: [],
            source: 'identity',
            last_updated: new Date().toISOString().split('T')[0]
          };
        } else {
          // us_house_district / state_legislative_district / unknown.
          // Census Tigerweb (US House) + OpenStates (state) are planned
          // here. For now return an explicit "unsupported" so Sam can
          // fall back to broad guidance and flag the gap.
          result = {
            jurisdiction_type: type,
            official_name: jurisdictionName,
            incorporated_municipalities: [],
            major_unincorporated_areas: [],
            source: 'unsupported',
            last_updated: new Date().toISOString().split('T')[0],
            note: 'District-level lookup not implemented yet. Sam should tell the user she does not have verified geographic data for this jurisdiction type.'
          };
        }

        // Persist (UPSERT via UNIQUE index).
        await env.DB.prepare(
          'INSERT INTO jurisdiction_lookups (id, office, state, jurisdiction_name, jurisdiction_type, official_name, incorporated_municipalities, major_unincorporated_areas, source, last_updated) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
          'ON CONFLICT(office, state, jurisdiction_name) DO UPDATE SET ' +
          '  jurisdiction_type = excluded.jurisdiction_type, ' +
          '  official_name = excluded.official_name, ' +
          '  incorporated_municipalities = excluded.incorporated_municipalities, ' +
          '  major_unincorporated_areas = excluded.major_unincorporated_areas, ' +
          '  source = excluded.source, ' +
          '  last_updated = excluded.last_updated, ' +
          '  created_at = datetime(\'now\')'
        ).bind(
          generateId(16), office, state, jurisdictionName,
          result.jurisdiction_type, result.official_name,
          JSON.stringify(result.incorporated_municipalities || []),
          JSON.stringify(result.major_unincorporated_areas || []),
          result.source, result.last_updated
        ).run();

        return jsonResponse({ ...result, cached: false });
      } catch (error) {
        return jsonResponse({ error: error.message }, 500);
      }
    }

    // ========================================
    // DATA API: Sync Folders & Notes (DELETE-NOT-IN + UPSERT)
    // @deprecated 2026-04-22 — use /api/folders/save + /delete and
    // /api/notes/save + /delete. The folder-delete endpoint cascades
    // to notes. DELETE-NOT-IN mitigation here is a band-aid; the per-row
    // endpoints close the race completely.
    // ========================================
    if (url.pathname === '/api/notes/sync' && request.method === 'POST') {
      try {
        const ctx = await getSessionContext(request);
        if (!ctx) return jsonResponse({ error: 'Not authenticated' }, 401);
        if (ctx.revoked) return denyRevoked();
        if (!requirePermission(ctx, 'notes', 'full')) return denyPermission('notes');

        const { folders } = await request.json();

        // DELETE-NOT-IN + UPSERT pattern — matches /api/events/sync.
        //
        // The previous full-replace (DELETE FROM … WHERE workspace_owner_id = ?
        // then INSERT every row) lost data when a stale client synced: if
        // another tab had saved a new folder/note in the meantime, this
        // client's stale payload (missing that row) would permanently wipe
        // it. That caused a live data-loss incident — see conversation on
        // 2026-04-22. We now preserve rows the payload doesn't mention, and
        // keep user_id / created_at attribution on existing rows so a
        // sub-user's edit doesn't rewrite the original author.
        //
        // Trade-off: deleting a folder or note now requires the client to
        // omit it from the payload AND ensure no other tab is holding the
        // stale version. This is the correct trade-off — losing an intended
        // delete is recoverable (resave), losing an intended save is not.

        const incomingFolders = (folders || []);
        const incomingFolderIds = incomingFolders.map(f => String(f.id || ''));
        const incomingNotes = [];
        for (const folder of incomingFolders) {
          const folderId = String(folder.id || '');
          if (folder.notes && folder.notes.length > 0) {
            for (const n of folder.notes) {
              incomingNotes.push({ folderId, note: n });
            }
          }
        }
        const incomingNoteIds = incomingNotes.map(n => String(n.note.id || ''));

        // Delete only rows the client explicitly dropped — preserves rows
        // created by other tabs that this client never saw.
        if (incomingNoteIds.length > 0) {
          const placeholders = incomingNoteIds.map(() => '?').join(',');
          await env.DB.prepare(
            'DELETE FROM notes WHERE workspace_owner_id = ? AND id NOT IN (' + placeholders + ')'
          ).bind(ctx.ownerId, ...incomingNoteIds).run();
        } else {
          // Empty payload: don't wipe. An empty notes array almost always
          // means "nothing changed on the notes side" or a stale client
          // with no notes loaded yet, not "delete everything." If the user
          // genuinely wants to clear notes, they'd hit a per-row delete.
          // This is the belt-and-suspenders guard against the original
          // data-loss path.
        }
        if (incomingFolderIds.length > 0) {
          const placeholders = incomingFolderIds.map(() => '?').join(',');
          await env.DB.prepare(
            'DELETE FROM folders WHERE workspace_owner_id = ? AND id NOT IN (' + placeholders + ')'
          ).bind(ctx.ownerId, ...incomingFolderIds).run();
        }

        // UPSERT folders — preserve user_id and created_at on existing rows.
        if (incomingFolders.length > 0) {
          const folderStmt = env.DB.prepare(
            'INSERT INTO folders (id, user_id, workspace_owner_id, name, campaign_id, created_at) VALUES (?, ?, ?, ?, ?, ?) ' +
            'ON CONFLICT(id) DO UPDATE SET name = excluded.name, campaign_id = excluded.campaign_id'
          );
          const folderBatch = incomingFolders.map(f => folderStmt.bind(
            String(f.id || generateId(16)),
            ctx.userId,
            ctx.ownerId,
            f.name || '',
            f.campaign_id || null,
            f.created_at || new Date().toISOString()
          ));
          await env.DB.batch(folderBatch);
        }

        // UPSERT notes — preserve user_id and created_at on existing rows.
        if (incomingNotes.length > 0) {
          const noteStmt = env.DB.prepare(
            'INSERT INTO notes (id, folder_id, user_id, workspace_owner_id, title, content, campaign_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
            'ON CONFLICT(id) DO UPDATE SET folder_id = excluded.folder_id, title = excluded.title, content = excluded.content, campaign_id = excluded.campaign_id, updated_at = excluded.updated_at'
          );
          const noteBatch = incomingNotes.map(({ folderId, note: n }) => noteStmt.bind(
            String(n.id || generateId(16)),
            folderId,
            ctx.userId,
            ctx.ownerId,
            n.title || '',
            n.content || '',
            n.campaign_id || null,
            n.created_at || new Date().toISOString(),
            n.updated_at || new Date().toISOString()
          ));
          await env.DB.batch(noteBatch);
        }

        return jsonResponse({ success: true });
      } catch (error) {
        return jsonResponse({ error: error.message }, 500);
      }
    }

    // ========================================
    // DATA API: Load Folders & Notes
    // ========================================
    if (url.pathname === '/api/notes/load' && request.method === 'GET') {
      try {
        const ctx = await getSessionContext(request);
        if (!ctx) return jsonResponse({ error: 'Not authenticated' }, 401);
        if (ctx.revoked) return denyRevoked();
        if (!requirePermission(ctx, 'notes', 'read')) return denyPermission('notes');

        const foldersResult = await env.DB.prepare(
          'SELECT * FROM folders WHERE workspace_owner_id = ? ORDER BY created_at ASC'
        ).bind(ctx.ownerId).all();

        const notesResult = await env.DB.prepare(
          'SELECT * FROM notes WHERE workspace_owner_id = ? ORDER BY created_at ASC'
        ).bind(ctx.ownerId).all();

        // Assemble folders with their notes
        const folders = (foldersResult.results || []).map(f => ({
          id: f.id,
          name: f.name,
          created_at: f.created_at,
          notes: (notesResult.results || [])
            .filter(n => n.folder_id === f.id)
            .map(n => ({
              id: n.id,
              title: n.title,
              content: n.content,
              created_at: n.created_at,
              updated_at: n.updated_at
            }))
        }));

        return jsonResponse({ success: true, folders });
      } catch (error) {
        return jsonResponse({ error: error.message }, 500);
      }
    }

    // ========================================
    // DATA API: Save Briefing
    // ========================================
    if (url.pathname === '/api/briefing/save' && request.method === 'POST') {
      try {
        const ctx = await getSessionContext(request);
        if (!ctx) return jsonResponse({ error: 'Not authenticated' }, 401);
        if (ctx.revoked) return denyRevoked();
        // Morning brief is a workspace resource generated on behalf of the
        // candidate. Owner-only write — sub-users only read it.
        if (ctx.isSubUser) return denyOwnerOnly();

        const { date, text } = await request.json();

        await env.DB.prepare(`
          INSERT INTO briefings (user_id, workspace_owner_id, date, text)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(user_id, date) DO UPDATE SET
            text = excluded.text
        `).bind(ctx.ownerId, ctx.ownerId, date, text).run();

        return jsonResponse({ success: true });
      } catch (error) {
        return jsonResponse({ error: error.message }, 500);
      }
    }

    // ========================================
    // DATA API: Load Briefing
    // ========================================
    if (url.pathname === '/api/briefing/load' && request.method === 'GET') {
      try {
        const ctx = await getSessionContext(request);
        if (!ctx) return jsonResponse({ error: 'Not authenticated' }, 401);
        if (ctx.revoked) return denyRevoked();
        // No permission gate: morning brief is a shared workspace resource.

        const row = await env.DB.prepare(
          'SELECT * FROM briefings WHERE workspace_owner_id = ? ORDER BY date DESC LIMIT 1'
        ).bind(ctx.ownerId).first();

        return jsonResponse({ success: true, briefing: row || null });
      } catch (error) {
        return jsonResponse({ error: error.message }, 500);
      }
    }

    // ========================================
    // DATA API: Save Chat History
    // ========================================
    if (url.pathname === '/api/chat-history/save' && request.method === 'POST') {
      try {
        const userId = await getUserFromSession(request);
        if (!userId) return jsonResponse({ error: 'Not authenticated' }, 401);

        const { messages } = await request.json();

        await env.DB.prepare(`
          INSERT INTO chat_history (user_id, messages, updated_at)
          VALUES (?, ?, datetime('now'))
          ON CONFLICT(user_id) DO UPDATE SET
            messages = excluded.messages,
            updated_at = datetime('now')
        `).bind(userId, JSON.stringify(messages)).run();

        return jsonResponse({ success: true });
      } catch (error) {
        return jsonResponse({ error: error.message }, 500);
      }
    }

    // ========================================
    // DATA API: Load Chat History
    // ========================================
    if (url.pathname === '/api/chat-history/load' && request.method === 'GET') {
      try {
        const userId = await getUserFromSession(request);
        if (!userId) return jsonResponse({ error: 'Not authenticated' }, 401);

        const row = await env.DB.prepare(
          'SELECT messages FROM chat_history WHERE user_id = ?'
        ).bind(userId).first();

        let messages = [];
        if (row && row.messages) {
          try { messages = JSON.parse(row.messages); } catch (e) { /* empty */ }
        }

        return jsonResponse({ success: true, messages });
      } catch (error) {
        return jsonResponse({ error: error.message }, 500);
      }
    }

    // ========================================
    // DATA API: Sync Endorsements (full replace)
    // @deprecated 2026-04-22 — use /api/endorsements/save + /delete.
    // ========================================
    if (url.pathname === '/api/endorsements/sync' && request.method === 'POST') {
      try {
        const ctx = await getSessionContext(request);
        if (!ctx) return jsonResponse({ error: 'Not authenticated' }, 401);
        if (ctx.revoked) return denyRevoked();
        if (!requirePermission(ctx, 'endorsements', 'full')) return denyPermission('endorsements');
        const { endorsements } = await request.json();
        const list = endorsements || [];
        const incomingIds = list.map(e => String(e.id));
        if (incomingIds.length > 0) {
          const placeholders = incomingIds.map(() => '?').join(',');
          await env.DB.prepare('DELETE FROM endorsements WHERE workspace_owner_id = ? AND id NOT IN (' + placeholders + ')').bind(ctx.ownerId, ...incomingIds).run();
        } else {
          await env.DB.prepare('DELETE FROM endorsements WHERE workspace_owner_id = ?').bind(ctx.ownerId).run();
        }
        if (list.length > 0) {
          const stmt = env.DB.prepare(
            'INSERT INTO endorsements (id, user_id, workspace_owner_id, name, title, status, notes, date, added_by_sam, campaign_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
            'ON CONFLICT(id) DO UPDATE SET name = excluded.name, title = excluded.title, status = excluded.status, notes = excluded.notes, date = excluded.date, added_by_sam = excluded.added_by_sam, campaign_id = excluded.campaign_id'
          );
          const batch = list.map(e => stmt.bind(
            String(e.id), ctx.userId, ctx.ownerId, e.name || '', e.title || '', e.status || 'Pursuing',
            e.notes || '', e.date || null, e.addedBySam ? 1 : 0, e.campaign_id || null, e.created_at || new Date().toISOString()
          ));
          await env.DB.batch(batch);
        }
        return jsonResponse({ success: true, count: list.length });
      } catch (error) {
        return jsonResponse({ error: error.message }, 500);
      }
    }

    // ========================================
    // DATA API: Load Endorsements
    // ========================================
    if (url.pathname === '/api/endorsements/load' && request.method === 'GET') {
      try {
        const ctx = await getSessionContext(request);
        if (!ctx) return jsonResponse({ error: 'Not authenticated' }, 401);
        if (ctx.revoked) return denyRevoked();
        if (!requirePermission(ctx, 'endorsements', 'read')) return denyPermission('endorsements');
        const result = await env.DB.prepare(
          'SELECT * FROM endorsements WHERE workspace_owner_id = ? ORDER BY created_at DESC'
        ).bind(ctx.ownerId).all();
        const endorsements = (result.results || []).map(row => ({
          id: parseFloat(row.id) || row.id, name: row.name, title: row.title,
          status: row.status, notes: row.notes, date: row.date,
          addedBySam: row.added_by_sam === 1, created_at: row.created_at
        }));
        return jsonResponse({ success: true, endorsements });
      } catch (error) {
        return jsonResponse({ error: error.message }, 500);
      }
    }

    // ========================================
    // DATA API: Sync Contributions (full replace)
    // @deprecated 2026-04-22 — use /api/contributions/save + /delete.
    // ========================================
    if (url.pathname === '/api/contributions/sync' && request.method === 'POST') {
      try {
        const ctx = await getSessionContext(request);
        if (!ctx) return jsonResponse({ error: 'Not authenticated' }, 401);
        if (ctx.revoked) return denyRevoked();
        if (!requirePermission(ctx, 'budget', 'full')) return denyPermission('budget');
        const { contributions } = await request.json();
        const list = contributions || [];
        const incomingIds = list.map(c => String(c.id));
        if (incomingIds.length > 0) {
          const placeholders = incomingIds.map(() => '?').join(',');
          await env.DB.prepare('DELETE FROM contributions WHERE workspace_owner_id = ? AND id NOT IN (' + placeholders + ')').bind(ctx.ownerId, ...incomingIds).run();
        } else {
          await env.DB.prepare('DELETE FROM contributions WHERE workspace_owner_id = ?').bind(ctx.ownerId).run();
        }
        if (list.length > 0) {
          const stmt = env.DB.prepare(
            'INSERT INTO contributions (id, user_id, workspace_owner_id, donor_name, amount, source, date, employer, occupation, notes, campaign_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
            'ON CONFLICT(id) DO UPDATE SET donor_name = excluded.donor_name, amount = excluded.amount, source = excluded.source, date = excluded.date, employer = excluded.employer, occupation = excluded.occupation, notes = excluded.notes, campaign_id = excluded.campaign_id'
          );
          const batch = list.map(c => stmt.bind(
            String(c.id), ctx.userId, ctx.ownerId, c.donorName || '', c.amount || 0, c.source || 'individual',
            c.date || null, c.employer || '', c.occupation || '', c.notes || '',
            c.campaign_id || null, c.created_at || new Date().toISOString()
          ));
          await env.DB.batch(batch);
        }
        return jsonResponse({ success: true, count: list.length });
      } catch (error) {
        return jsonResponse({ error: error.message }, 500);
      }
    }

    // ========================================
    // DATA API: Load Contributions
    // ========================================
    if (url.pathname === '/api/contributions/load' && request.method === 'GET') {
      try {
        const ctx = await getSessionContext(request);
        if (!ctx) return jsonResponse({ error: 'Not authenticated' }, 401);
        if (ctx.revoked) return denyRevoked();
        if (!requirePermission(ctx, 'budget', 'read')) return denyPermission('budget');
        const result = await env.DB.prepare(
          'SELECT * FROM contributions WHERE workspace_owner_id = ? ORDER BY date DESC'
        ).bind(ctx.ownerId).all();
        const contributions = (result.results || []).map(row => ({
          id: parseFloat(row.id) || row.id, donorName: row.donor_name, amount: row.amount,
          source: row.source, date: row.date, employer: row.employer,
          occupation: row.occupation, notes: row.notes, created_at: row.created_at
        }));
        return jsonResponse({ success: true, contributions });
      } catch (error) {
        return jsonResponse({ error: error.message }, 500);
      }
    }

    // ================================================================
    // PER-ROW SYNC ENDPOINTS (item #5 architectural fix)
    //
    // Replace the array-sync endpoints' "full workspace replace" shape
    // with per-row create/update/delete. Each mutation touches exactly
    // one row, so a stale client can't clobber another tab's work just
    // by having an out-of-date local array.
    //
    // Shared contract across all 12 endpoints:
    //   - getSessionContext → auth + revoked gates
    //   - requirePermission(ctx, tab, 'full') — writes always need full
    //   - Every query hard-filters on workspace_owner_id = ctx.ownerId,
    //     including the DELETE WHERE clauses (so a sub-user can't nuke
    //     another workspace's row by guessing ids)
    //   - Save endpoints UPSERT with ON CONFLICT(id) DO UPDATE SET
    //     <mutable fields only> — preserves user_id and created_at for
    //     attribution when a sub-user edits an owner-created row
    //   - Delete endpoints return { success, deleted: <rows affected> }
    //     so the client can tell if the row existed
    //
    // The older /api/<table>/sync endpoints below are kept in place
    // and marked @deprecated — one-release deprecation window before
    // removal, per the migration plan.
    // ================================================================

    // ---- EVENTS ----
    if (url.pathname === '/api/events/save' && request.method === 'POST') {
      try {
        const ctx = await getSessionContext(request);
        if (!ctx) return jsonResponse({ error: 'Not authenticated' }, 401);
        if (ctx.revoked) return denyRevoked();
        if (!requirePermission(ctx, 'calendar', 'full')) return denyPermission('calendar');
        const { event: e } = await request.json();
        if (!e || !e.id) return jsonResponse({ error: 'event.id required' }, 400);
        await env.DB.prepare(
          'INSERT INTO events (id, user_id, workspace_owner_id, name, date, time, end_time, location, campaign_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
          'ON CONFLICT(id) DO UPDATE SET name = excluded.name, date = excluded.date, time = excluded.time, end_time = excluded.end_time, location = excluded.location, campaign_id = excluded.campaign_id'
        ).bind(
          String(e.id), ctx.userId, ctx.ownerId,
          e.name || e.title || '', e.date || null, e.time || null,
          e.end_time || e.endTime || null, e.location || null,
          e.campaign_id || null, e.created_at || new Date().toISOString()
        ).run();
        return jsonResponse({ success: true, id: String(e.id) });
      } catch (error) { return jsonResponse({ error: error.message }, 500); }
    }

    if (url.pathname === '/api/events/delete' && request.method === 'POST') {
      try {
        const ctx = await getSessionContext(request);
        if (!ctx) return jsonResponse({ error: 'Not authenticated' }, 401);
        if (ctx.revoked) return denyRevoked();
        if (!requirePermission(ctx, 'calendar', 'full')) return denyPermission('calendar');
        const { id } = await request.json();
        if (!id) return jsonResponse({ error: 'id required' }, 400);
        const r = await env.DB.prepare(
          'DELETE FROM events WHERE id = ? AND workspace_owner_id = ?'
        ).bind(String(id), ctx.ownerId).run();
        return jsonResponse({ success: true, deleted: (r.meta && r.meta.changes) || 0 });
      } catch (error) { return jsonResponse({ error: error.message }, 500); }
    }

    // ---- TASKS ----
    if (url.pathname === '/api/tasks/save' && request.method === 'POST') {
      try {
        const ctx = await getSessionContext(request);
        if (!ctx) return jsonResponse({ error: 'Not authenticated' }, 401);
        if (ctx.revoked) return denyRevoked();
        if (!requirePermission(ctx, 'calendar', 'full')) return denyPermission('calendar');
        const { task: t } = await request.json();
        if (!t || !t.id) return jsonResponse({ error: 'task.id required' }, 400);
        await env.DB.prepare(
          'INSERT INTO tasks (id, user_id, workspace_owner_id, name, date, category, completed, campaign_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
          'ON CONFLICT(id) DO UPDATE SET name = excluded.name, date = excluded.date, category = excluded.category, completed = excluded.completed, campaign_id = excluded.campaign_id'
        ).bind(
          String(t.id), ctx.userId, ctx.ownerId,
          t.name || t.text || '', t.date || null, t.category || 'general',
          t.completed ? 1 : 0, t.campaign_id || null,
          t.created_at || new Date().toISOString()
        ).run();
        return jsonResponse({ success: true, id: String(t.id) });
      } catch (error) { return jsonResponse({ error: error.message }, 500); }
    }

    if (url.pathname === '/api/tasks/delete' && request.method === 'POST') {
      try {
        const ctx = await getSessionContext(request);
        if (!ctx) return jsonResponse({ error: 'Not authenticated' }, 401);
        if (ctx.revoked) return denyRevoked();
        if (!requirePermission(ctx, 'calendar', 'full')) return denyPermission('calendar');
        const { id } = await request.json();
        if (!id) return jsonResponse({ error: 'id required' }, 400);
        const r = await env.DB.prepare(
          'DELETE FROM tasks WHERE id = ? AND workspace_owner_id = ?'
        ).bind(String(id), ctx.ownerId).run();
        return jsonResponse({ success: true, deleted: (r.meta && r.meta.changes) || 0 });
      } catch (error) { return jsonResponse({ error: error.message }, 500); }
    }

    // ---- FOLDERS ----
    if (url.pathname === '/api/folders/save' && request.method === 'POST') {
      try {
        const ctx = await getSessionContext(request);
        if (!ctx) return jsonResponse({ error: 'Not authenticated' }, 401);
        if (ctx.revoked) return denyRevoked();
        if (!requirePermission(ctx, 'notes', 'full')) return denyPermission('notes');
        const { folder: f } = await request.json();
        if (!f || !f.id) return jsonResponse({ error: 'folder.id required' }, 400);
        await env.DB.prepare(
          'INSERT INTO folders (id, user_id, workspace_owner_id, name, campaign_id, created_at) VALUES (?, ?, ?, ?, ?, ?) ' +
          'ON CONFLICT(id) DO UPDATE SET name = excluded.name, campaign_id = excluded.campaign_id'
        ).bind(
          String(f.id), ctx.userId, ctx.ownerId,
          f.name || '', f.campaign_id || null,
          f.created_at || new Date().toISOString()
        ).run();
        return jsonResponse({ success: true, id: String(f.id) });
      } catch (error) { return jsonResponse({ error: error.message }, 500); }
    }

    // Folder delete cascades to notes in the same workspace — keeps the
    // client simple and prevents orphaned notes if the client forgets to
    // delete children first. Both deletes share the workspace_owner_id
    // scope guard, so no cross-workspace leakage.
    if (url.pathname === '/api/folders/delete' && request.method === 'POST') {
      try {
        const ctx = await getSessionContext(request);
        if (!ctx) return jsonResponse({ error: 'Not authenticated' }, 401);
        if (ctx.revoked) return denyRevoked();
        if (!requirePermission(ctx, 'notes', 'full')) return denyPermission('notes');
        const { id } = await request.json();
        if (!id) return jsonResponse({ error: 'id required' }, 400);
        const notesR = await env.DB.prepare(
          'DELETE FROM notes WHERE folder_id = ? AND workspace_owner_id = ?'
        ).bind(String(id), ctx.ownerId).run();
        const foldersR = await env.DB.prepare(
          'DELETE FROM folders WHERE id = ? AND workspace_owner_id = ?'
        ).bind(String(id), ctx.ownerId).run();
        return jsonResponse({
          success: true,
          deleted: (foldersR.meta && foldersR.meta.changes) || 0,
          notesDeleted: (notesR.meta && notesR.meta.changes) || 0
        });
      } catch (error) { return jsonResponse({ error: error.message }, 500); }
    }

    // ---- NOTES ----
    if (url.pathname === '/api/notes/save' && request.method === 'POST') {
      try {
        const ctx = await getSessionContext(request);
        if (!ctx) return jsonResponse({ error: 'Not authenticated' }, 401);
        if (ctx.revoked) return denyRevoked();
        if (!requirePermission(ctx, 'notes', 'full')) return denyPermission('notes');
        const { note: n } = await request.json();
        if (!n || !n.id) return jsonResponse({ error: 'note.id required' }, 400);
        if (!n.folder_id) return jsonResponse({ error: 'note.folder_id required' }, 400);
        await env.DB.prepare(
          'INSERT INTO notes (id, folder_id, user_id, workspace_owner_id, title, content, campaign_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
          'ON CONFLICT(id) DO UPDATE SET folder_id = excluded.folder_id, title = excluded.title, content = excluded.content, campaign_id = excluded.campaign_id, updated_at = excluded.updated_at'
        ).bind(
          String(n.id), String(n.folder_id), ctx.userId, ctx.ownerId,
          n.title || '', n.content || '', n.campaign_id || null,
          n.created_at || new Date().toISOString(),
          n.updated_at || new Date().toISOString()
        ).run();
        return jsonResponse({ success: true, id: String(n.id) });
      } catch (error) { return jsonResponse({ error: error.message }, 500); }
    }

    if (url.pathname === '/api/notes/delete' && request.method === 'POST') {
      try {
        const ctx = await getSessionContext(request);
        if (!ctx) return jsonResponse({ error: 'Not authenticated' }, 401);
        if (ctx.revoked) return denyRevoked();
        if (!requirePermission(ctx, 'notes', 'full')) return denyPermission('notes');
        const { id } = await request.json();
        if (!id) return jsonResponse({ error: 'id required' }, 400);
        const r = await env.DB.prepare(
          'DELETE FROM notes WHERE id = ? AND workspace_owner_id = ?'
        ).bind(String(id), ctx.ownerId).run();
        return jsonResponse({ success: true, deleted: (r.meta && r.meta.changes) || 0 });
      } catch (error) { return jsonResponse({ error: error.message }, 500); }
    }

    // ---- ENDORSEMENTS ----
    if (url.pathname === '/api/endorsements/save' && request.method === 'POST') {
      try {
        const ctx = await getSessionContext(request);
        if (!ctx) return jsonResponse({ error: 'Not authenticated' }, 401);
        if (ctx.revoked) return denyRevoked();
        if (!requirePermission(ctx, 'endorsements', 'full')) return denyPermission('endorsements');
        const { endorsement: e } = await request.json();
        if (!e || !e.id) return jsonResponse({ error: 'endorsement.id required' }, 400);
        await env.DB.prepare(
          'INSERT INTO endorsements (id, user_id, workspace_owner_id, name, title, status, notes, date, added_by_sam, campaign_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
          'ON CONFLICT(id) DO UPDATE SET name = excluded.name, title = excluded.title, status = excluded.status, notes = excluded.notes, date = excluded.date, added_by_sam = excluded.added_by_sam, campaign_id = excluded.campaign_id'
        ).bind(
          String(e.id), ctx.userId, ctx.ownerId,
          e.name || '', e.title || '', e.status || 'Pursuing',
          e.notes || '', e.date || null,
          e.addedBySam ? 1 : 0,
          e.campaign_id || null,
          e.created_at || new Date().toISOString()
        ).run();
        return jsonResponse({ success: true, id: String(e.id) });
      } catch (error) { return jsonResponse({ error: error.message }, 500); }
    }

    if (url.pathname === '/api/endorsements/delete' && request.method === 'POST') {
      try {
        const ctx = await getSessionContext(request);
        if (!ctx) return jsonResponse({ error: 'Not authenticated' }, 401);
        if (ctx.revoked) return denyRevoked();
        if (!requirePermission(ctx, 'endorsements', 'full')) return denyPermission('endorsements');
        const { id } = await request.json();
        if (!id) return jsonResponse({ error: 'id required' }, 400);
        const r = await env.DB.prepare(
          'DELETE FROM endorsements WHERE id = ? AND workspace_owner_id = ?'
        ).bind(String(id), ctx.ownerId).run();
        return jsonResponse({ success: true, deleted: (r.meta && r.meta.changes) || 0 });
      } catch (error) { return jsonResponse({ error: error.message }, 500); }
    }

    // ---- CONTRIBUTIONS ----
    if (url.pathname === '/api/contributions/save' && request.method === 'POST') {
      try {
        const ctx = await getSessionContext(request);
        if (!ctx) return jsonResponse({ error: 'Not authenticated' }, 401);
        if (ctx.revoked) return denyRevoked();
        if (!requirePermission(ctx, 'budget', 'full')) return denyPermission('budget');
        const { contribution: c } = await request.json();
        if (!c || !c.id) return jsonResponse({ error: 'contribution.id required' }, 400);
        await env.DB.prepare(
          'INSERT INTO contributions (id, user_id, workspace_owner_id, donor_name, amount, source, date, employer, occupation, notes, campaign_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
          'ON CONFLICT(id) DO UPDATE SET donor_name = excluded.donor_name, amount = excluded.amount, source = excluded.source, date = excluded.date, employer = excluded.employer, occupation = excluded.occupation, notes = excluded.notes, campaign_id = excluded.campaign_id'
        ).bind(
          String(c.id), ctx.userId, ctx.ownerId,
          c.donorName || c.donor_name || '', c.amount || 0,
          c.source || 'individual', c.date || null,
          c.employer || '', c.occupation || '', c.notes || '',
          c.campaign_id || null,
          c.created_at || new Date().toISOString()
        ).run();
        return jsonResponse({ success: true, id: String(c.id) });
      } catch (error) { return jsonResponse({ error: error.message }, 500); }
    }

    if (url.pathname === '/api/contributions/delete' && request.method === 'POST') {
      try {
        const ctx = await getSessionContext(request);
        if (!ctx) return jsonResponse({ error: 'Not authenticated' }, 401);
        if (ctx.revoked) return denyRevoked();
        if (!requirePermission(ctx, 'budget', 'full')) return denyPermission('budget');
        const { id } = await request.json();
        if (!id) return jsonResponse({ error: 'id required' }, 400);
        const r = await env.DB.prepare(
          'DELETE FROM contributions WHERE id = ? AND workspace_owner_id = ?'
        ).bind(String(id), ctx.ownerId).run();
        return jsonResponse({ success: true, deleted: (r.meta && r.meta.changes) || 0 });
      } catch (error) { return jsonResponse({ error: error.message }, 500); }
    }

    // ========================================
    // DATA API: Load All (bulk load on login)
    // ========================================
    if (url.pathname === '/api/data/load-all' && request.method === 'GET') {
      try {
        const ctx = await getSessionContext(request);
        if (!ctx) return jsonResponse({ error: 'Not authenticated' }, 401);
        if (ctx.revoked) return denyRevoked();

        // Profile, tasks, events, budget, notes/folders, briefings,
        // endorsements, contributions are workspace-scoped (filter on
        // workspace_owner_id = ctx.ownerId). chat_history stays per-user
        // (each collaborator has their own Sam conversation).
        //
        // Per-tab permission is enforced here by returning empty arrays for
        // tabs the sub-user can't see, rather than 403-ing the whole bundle
        // (sub-users still need the profile + campaign context to render
        // anything at all).
        const canCalendar     = requirePermission(ctx, 'calendar', 'read');
        const canBudget       = requirePermission(ctx, 'budget', 'read');
        const canNotes        = requirePermission(ctx, 'notes', 'read');
        const canEndorsements = requirePermission(ctx, 'endorsements', 'read');

        const empty = Promise.resolve({ results: [] });
        const emptyFirst = Promise.resolve(null);

        const [profileRow, tasksResult, eventsResult, budgetRow, foldersResult, notesResult, briefingRow, chatRow, endorseResult, contribResult] = await Promise.all([
          env.DB.prepare('SELECT * FROM profiles WHERE user_id = ?').bind(ctx.ownerId).first(),
          canCalendar ? env.DB.prepare('SELECT * FROM tasks WHERE workspace_owner_id = ? ORDER BY date ASC').bind(ctx.ownerId).all() : empty,
          canCalendar ? env.DB.prepare('SELECT * FROM events WHERE workspace_owner_id = ? ORDER BY date ASC').bind(ctx.ownerId).all() : empty,
          canBudget ? env.DB.prepare('SELECT * FROM budget WHERE user_id = ?').bind(ctx.ownerId).first() : emptyFirst,
          canNotes ? env.DB.prepare('SELECT * FROM folders WHERE workspace_owner_id = ? ORDER BY created_at ASC').bind(ctx.ownerId).all() : empty,
          canNotes ? env.DB.prepare('SELECT * FROM notes WHERE workspace_owner_id = ? ORDER BY created_at ASC').bind(ctx.ownerId).all() : empty,
          env.DB.prepare('SELECT * FROM briefings WHERE workspace_owner_id = ? ORDER BY date DESC LIMIT 1').bind(ctx.ownerId).first(),
          env.DB.prepare('SELECT messages FROM chat_history WHERE user_id = ?').bind(ctx.userId).first(),
          canEndorsements ? env.DB.prepare('SELECT * FROM endorsements WHERE workspace_owner_id = ? ORDER BY created_at DESC').bind(ctx.ownerId).all().catch(() => ({ results: [] })) : empty,
          canBudget ? env.DB.prepare('SELECT * FROM contributions WHERE workspace_owner_id = ? ORDER BY date DESC').bind(ctx.ownerId).all().catch(() => ({ results: [] })) : empty
        ]);

        // Format profile
        let profile = profileRow || null;
        if (profile && profile.win_number_data) {
          try { profile.win_number_data = JSON.parse(profile.win_number_data); } catch (e) { /* leave as string */ }
        }

        // Format tasks (user_id exposed for attribution rendering)
        const tasks = (tasksResult.results || []).map(row => ({
          id: parseFloat(row.id) || row.id,
          name: row.name,
          text: row.name,
          date: row.date,
          category: row.category,
          completed: row.completed === 1,
          created_at: row.created_at,
          user_id: row.user_id
        }));

        // Format events
        const events = (eventsResult.results || []).map(row => ({
          id: parseFloat(row.id) || row.id,
          name: row.name,
          title: row.name,
          date: row.date,
          time: row.time,
          end_time: row.end_time,
          endTime: row.end_time,
          location: row.location,
          created_at: row.created_at,
          user_id: row.user_id
        }));

        // Format budget
        let budget = null;
        if (budgetRow) {
          // Same defensive double-parse as /api/budget/load — handles
          // legacy double-encoded rows transparently.
          let cats = JSON.parse(budgetRow.categories || '{}');
          if (typeof cats === 'string') {
            try { cats = JSON.parse(cats); } catch (e) { cats = {}; }
          }
          budget = {
            total: budgetRow.total,
            categories: cats,
            updated_at: budgetRow.updated_at
          };
        }

        // Format folders with notes
        const folders = (foldersResult.results || []).map(f => ({
          id: f.id,
          name: f.name,
          created_at: f.created_at,
          user_id: f.user_id,
          notes: (notesResult.results || [])
            .filter(n => n.folder_id === f.id)
            .map(n => ({
              id: n.id,
              title: n.title,
              content: n.content,
              created_at: n.created_at,
              updated_at: n.updated_at,
              user_id: n.user_id
            }))
        }));

        // Format briefing
        const briefing = briefingRow || null;

        // Format chat history
        let chatHistory = [];
        if (chatRow && chatRow.messages) {
          try { chatHistory = JSON.parse(chatRow.messages); } catch (e) { /* empty */ }
        }

        // Format endorsements
        const endorsements = (endorseResult.results || []).map(row => ({
          id: parseFloat(row.id) || row.id, name: row.name, title: row.title,
          status: row.status, notes: row.notes, date: row.date,
          addedBySam: row.added_by_sam === 1, created_at: row.created_at,
          user_id: row.user_id
        }));

        // Format contributions
        const contributions = (contribResult.results || []).map(row => ({
          id: parseFloat(row.id) || row.id, donorName: row.donor_name, amount: row.amount,
          source: row.source, date: row.date, employer: row.employer,
          occupation: row.occupation, notes: row.notes, created_at: row.created_at,
          user_id: row.user_id
        }));

        // Build workspace members map {user_id → display name} so the
        // client can render attribution without a second fetch. Includes
        // the owner + every sub_user (active or revoked — revoked users'
        // past contributions still need names).
        const workspaceMembers = {};
        const ownerInfo = await env.DB.prepare(
          'SELECT u.id, u.full_name, u.username, p.candidate_name FROM users u LEFT JOIN profiles p ON p.user_id = u.id WHERE u.id = ?'
        ).bind(ctx.ownerId).first();
        if (ownerInfo) {
          workspaceMembers[ownerInfo.id] = ownerInfo.candidate_name || ownerInfo.full_name || ownerInfo.username || 'Owner';
        }
        // LOWER(s.username) in the JOIN — anchor emails are stored
        // lowercased but sub_users.username preserves as-typed casing.
        // Without LOWER(), mixed-case sub-users silently drop out of
        // workspaceMembers and their attribution badges render blank.
        const subList = await env.DB.prepare(
          'SELECT s.name, u.id FROM sub_users s JOIN users u ON u.email = LOWER(s.username) || \'@sub.tcb\' WHERE s.owner_id = ?'
        ).bind(ctx.ownerId).all();
        (subList.results || []).forEach(s => { workspaceMembers[s.id] = s.name; });

        return jsonResponse({ success: true, profile, tasks, events, budget, folders, briefing, chatHistory, endorsements, contributions, workspaceMembers, ownerUserId: ctx.ownerId, isSubUser: ctx.isSubUser, permissions: ctx.permissions || null });
      } catch (error) {
        return jsonResponse({ error: error.message }, 500);
      }
    }

    // ========================================
    // DATA API: Reset All User Data
    // ========================================
    if (url.pathname === '/api/data/reset' && request.method === 'POST') {
      try {
        const ctx = await getSessionContext(request);
        if (!ctx) return jsonResponse({ error: 'Not authenticated' }, 401);
        if (ctx.revoked) return denyRevoked();
        if (ctx.isSubUser) return denyOwnerOnly();

        // Full workspace reset. Deletes every row in this workspace across
        // every workspace-scoped table. api_usage rows are kept (billing
        // history) but their campaign_id is nulled. chat_history is scoped
        // by user_id (per-user) — only the owner's chat gets wiped here;
        // sub-user chat history survives reset (intentional — their
        // conversations with Sam are their own).
        const results = await env.DB.batch([
          env.DB.prepare('DELETE FROM tasks WHERE workspace_owner_id = ?').bind(ctx.ownerId),
          env.DB.prepare('DELETE FROM events WHERE workspace_owner_id = ?').bind(ctx.ownerId),
          env.DB.prepare('DELETE FROM budget WHERE user_id = ?').bind(ctx.ownerId),
          env.DB.prepare('DELETE FROM notes WHERE workspace_owner_id = ?').bind(ctx.ownerId),
          env.DB.prepare('DELETE FROM folders WHERE workspace_owner_id = ?').bind(ctx.ownerId),
          env.DB.prepare('DELETE FROM briefings WHERE workspace_owner_id = ?').bind(ctx.ownerId),
          env.DB.prepare('DELETE FROM chat_history WHERE user_id = ?').bind(ctx.ownerId),
          env.DB.prepare('DELETE FROM endorsements WHERE workspace_owner_id = ?').bind(ctx.ownerId),
          env.DB.prepare('DELETE FROM contributions WHERE workspace_owner_id = ?').bind(ctx.ownerId),
          env.DB.prepare('DELETE FROM opponents WHERE workspace_owner_id = ?').bind(ctx.ownerId),
          env.DB.prepare('DELETE FROM campaigns WHERE owner_id = ?').bind(ctx.ownerId),
          env.DB.prepare('UPDATE api_usage SET campaign_id = NULL WHERE workspace_owner_id = ?').bind(ctx.ownerId),
          env.DB.prepare('DELETE FROM profiles WHERE user_id = ?').bind(ctx.ownerId)
        ]);

        const tables = ['tasks','events','budget','notes','folders','briefings','chat_history','endorsements','contributions','opponents','campaigns'];
        const counts = {};
        tables.forEach((t, i) => { counts[t] = results[i] && results[i].meta ? results[i].meta.changes : 0; });
        console.log('[Data reset]', userId, 'cleared:', JSON.stringify(counts));
        return jsonResponse({ success: true, message: 'All user data reset', deletedCounts: counts });
      } catch (error) {
        console.error('[Data reset] Error:', error.message);
        return jsonResponse({ error: error.message }, 500);
      }
    }

    // ========================================
    // SERVICE INTEREST EMAIL ENDPOINT
    // ========================================
    if (url.pathname === '/service-interest' && request.method === 'POST') {
      try {
        const data = await request.json();
        
        const emailHtml = `
          <h2>New Campaign Services Interest</h2>
          <table style="border-collapse: collapse; width: 100%;">
            <tr><td style="padding: 8px; font-weight: bold; border-bottom: 1px solid #eee;">Service:</td><td style="padding: 8px; border-bottom: 1px solid #eee;">${data.service}</td></tr>
            <tr><td style="padding: 8px; font-weight: bold; border-bottom: 1px solid #eee;">Name:</td><td style="padding: 8px; border-bottom: 1px solid #eee;">${data.candidate}</td></tr>
            <tr><td style="padding: 8px; font-weight: bold; border-bottom: 1px solid #eee;">Email:</td><td style="padding: 8px; border-bottom: 1px solid #eee;">${data.email}</td></tr>
            <tr><td style="padding: 8px; font-weight: bold; border-bottom: 1px solid #eee;">Phone:</td><td style="padding: 8px; border-bottom: 1px solid #eee;">${data.phone}</td></tr>
            <tr><td style="padding: 8px; font-weight: bold; border-bottom: 1px solid #eee;">Office:</td><td style="padding: 8px; border-bottom: 1px solid #eee;">${data.office}</td></tr>
            <tr><td style="padding: 8px; font-weight: bold; border-bottom: 1px solid #eee;">Location:</td><td style="padding: 8px; border-bottom: 1px solid #eee;">${data.location}</td></tr>
            <tr><td style="padding: 8px; font-weight: bold; border-bottom: 1px solid #eee;">Election Date:</td><td style="padding: 8px; border-bottom: 1px solid #eee;">${data.electionDate || 'Not set'}</td></tr>
            <tr><td style="padding: 8px; font-weight: bold;">Submitted:</td><td style="padding: 8px;">${data.submitted}</td></tr>
          </table>
        `;

        const emailResponse = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + env.RESEND_API_KEY,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            from: 'Candidate Tool Box <sam@thecandidatestoolbox.com>',
            to: ['grgsorrell@gmail.com'],
            subject: 'Campaign Services Interest: ' + data.service + ' - ' + data.candidate,
            html: emailHtml
          })
        });

        const result = await emailResponse.json();
        
        return new Response(JSON.stringify({ success: true, id: result.id }), {
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        });
      } catch (error) {
        return new Response(JSON.stringify({ success: false, error: error.message }), {
          status: 500,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        });
      }
    }

    // ========================================
    // CONTACT FORM EMAIL ENDPOINT
    // ========================================
    if (url.pathname === '/contact' && request.method === 'POST') {
      try {
        const data = await request.json();
        
        const emailHtml = `
          <h2>New Contact Form Message</h2>
          <table style="border-collapse: collapse; width: 100%;">
            <tr><td style="padding: 8px; font-weight: bold; border-bottom: 1px solid #eee;">Name:</td><td style="padding: 8px; border-bottom: 1px solid #eee;">${data.name}</td></tr>
            <tr><td style="padding: 8px; font-weight: bold; border-bottom: 1px solid #eee;">Email:</td><td style="padding: 8px; border-bottom: 1px solid #eee;">${data.email}</td></tr>
            <tr><td style="padding: 8px; font-weight: bold; border-bottom: 1px solid #eee;">Phone:</td><td style="padding: 8px; border-bottom: 1px solid #eee;">${data.phone}</td></tr>
            <tr><td style="padding: 8px; font-weight: bold; border-bottom: 1px solid #eee;">Office:</td><td style="padding: 8px; border-bottom: 1px solid #eee;">${data.office || 'Not set'}</td></tr>
            <tr><td style="padding: 8px; font-weight: bold; border-bottom: 1px solid #eee;">Location:</td><td style="padding: 8px; border-bottom: 1px solid #eee;">${data.location || 'Not set'}</td></tr>
            <tr><td style="padding: 8px; font-weight: bold; border-bottom: 1px solid #eee;">Submitted:</td><td style="padding: 8px; border-bottom: 1px solid #eee;">${data.submitted}</td></tr>
          </table>
          <div style="margin-top: 20px; padding: 16px; background: #f8f8f8; border-radius: 8px;">
            <p style="font-weight: bold; margin: 0 0 8px 0;">Message:</p>
            <p style="margin: 0; white-space: pre-wrap;">${data.message}</p>
          </div>
        `;

        const emailResponse = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + env.RESEND_API_KEY,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            from: 'Candidate Tool Box <sam@thecandidatestoolbox.com>',
            to: ['grgsorrell@gmail.com'],
            subject: 'Contact Form: ' + data.name + ' - ' + (data.office || 'General Inquiry'),
            html: emailHtml,
            reply_to: data.email
          })
        });

        const result = await emailResponse.json();
        
        return new Response(JSON.stringify({ success: true, id: result.id }), {
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        });
      } catch (error) {
        return new Response(JSON.stringify({ success: false, error: error.message }), {
          status: 500,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        });
      }
    }

    // ========================================
    // BILLING: All endpoints guarded by STRIPE_ACTIVE
    // ========================================
    const STRIPE_ACTIVE = env.STRIPE_ACTIVE === 'true';

    if (url.pathname === '/api/billing/status' && request.method === 'GET') {
      return jsonResponse({ active: STRIPE_ACTIVE });
    }

    if (url.pathname === '/api/billing/create-checkout' && request.method === 'POST') {
      if (!STRIPE_ACTIVE) return jsonResponse({ error: 'billing_inactive' }, 503);
      try {
        const userId = await getUserFromSession(request);
        if (!userId) return jsonResponse({ error: 'Not authenticated' }, 401);
        const user = await env.DB.prepare('SELECT email FROM users WHERE id = ?').bind(userId).first();
        const { plan, billingPeriod } = await request.json();
        const priceMap = {
          'starter_monthly': env.STRIPE_STARTER_MONTHLY, 'starter_annual': env.STRIPE_STARTER_ANNUAL,
          'campaign_monthly': env.STRIPE_CAMPAIGN_MONTHLY, 'campaign_annual': env.STRIPE_CAMPAIGN_ANNUAL,
          'pro_monthly': env.STRIPE_PRO_MONTHLY, 'pro_annual': env.STRIPE_PRO_ANNUAL,
          'consultant_monthly': env.STRIPE_CONSULTANT_MONTHLY, 'consultant_annual': env.STRIPE_CONSULTANT_ANNUAL
        };
        const priceId = priceMap[plan + '_' + (billingPeriod || 'monthly')];
        if (!priceId) return jsonResponse({ error: 'Invalid plan' }, 400);
        const params = new URLSearchParams();
        params.append('mode', 'subscription');
        params.append('payment_method_types[0]', 'card');
        params.append('line_items[0][price]', priceId);
        params.append('line_items[0][quantity]', '1');
        params.append('success_url', 'https://tcb-beta.grgsorrell.workers.dev/app?upgraded=true');
        params.append('cancel_url', 'https://tcb-beta.grgsorrell.workers.dev/app?cancelled=true');
        if (user && user.email) params.append('customer_email', user.email);
        params.append('metadata[userId]', userId);
        params.append('metadata[plan]', plan);
        const resp = await fetch('https://api.stripe.com/v1/checkout/sessions', {
          method: 'POST',
          headers: { 'Authorization': 'Basic ' + btoa(env.STRIPE_SECRET_KEY + ':'), 'Content-Type': 'application/x-www-form-urlencoded' },
          body: params.toString()
        });
        const session = await resp.json();
        if (session.error) return jsonResponse({ error: session.error.message }, 400);
        return jsonResponse({ success: true, checkoutUrl: session.url });
      } catch (error) { return jsonResponse({ error: error.message }, 500); }
    }

    if (url.pathname === '/api/billing/create-portal' && request.method === 'POST') {
      if (!STRIPE_ACTIVE) return jsonResponse({ error: 'billing_inactive' }, 503);
      try {
        const userId = await getUserFromSession(request);
        if (!userId) return jsonResponse({ error: 'Not authenticated' }, 401);
        const sub = await env.DB.prepare('SELECT stripe_customer_id FROM subscriptions WHERE user_id = ?').bind(userId).first();
        if (!sub || !sub.stripe_customer_id) return jsonResponse({ error: 'No subscription found' }, 404);
        const params = new URLSearchParams();
        params.append('customer', sub.stripe_customer_id);
        params.append('return_url', 'https://tcb-beta.grgsorrell.workers.dev/app');
        const resp = await fetch('https://api.stripe.com/v1/billing_portal/sessions', {
          method: 'POST',
          headers: { 'Authorization': 'Basic ' + btoa(env.STRIPE_SECRET_KEY + ':'), 'Content-Type': 'application/x-www-form-urlencoded' },
          body: params.toString()
        });
        const session = await resp.json();
        return jsonResponse({ success: true, portalUrl: session.url });
      } catch (error) { return jsonResponse({ error: error.message }, 500); }
    }

    if (url.pathname === '/api/billing/subscription' && request.method === 'GET') {
      if (!STRIPE_ACTIVE) return jsonResponse({ active: false, plan: 'beta' });
      try {
        const userId = await getUserFromSession(request);
        if (!userId) return jsonResponse({ error: 'Not authenticated' }, 401);
        const sub = await env.DB.prepare('SELECT * FROM subscriptions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1').bind(userId).first();
        if (!sub) return jsonResponse({ success: true, subscription: null });
        const pm = await env.DB.prepare('SELECT brand, last4 FROM payment_methods WHERE user_id = ? AND is_default = 1').bind(userId).first();
        return jsonResponse({ success: true, subscription: { plan: sub.plan, status: sub.status, billingPeriod: sub.billing_period, currentPeriodEnd: sub.current_period_end, cancelAtPeriodEnd: sub.cancel_at_period_end === 1, paymentMethod: pm || null } });
      } catch (error) { return jsonResponse({ error: error.message }, 500); }
    }

    if (url.pathname === '/api/billing/webhook' && request.method === 'POST') {
      if (!STRIPE_ACTIVE) return new Response('OK', { status: 200 });
      try {
        const body = await request.text();
        const sig = request.headers.get('stripe-signature');
        // TODO: Verify webhook signature with env.STRIPE_WEBHOOK_SECRET
        const event = JSON.parse(body);
        switch (event.type) {
          case 'customer.subscription.created':
          case 'customer.subscription.updated': {
            const sub = event.data.object;
            const userId = sub.metadata?.userId;
            if (userId) {
              await env.DB.prepare(
                'INSERT INTO subscriptions (id, user_id, stripe_customer_id, stripe_subscription_id, plan, status, current_period_start, current_period_end, cancel_at_period_end) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(stripe_subscription_id) DO UPDATE SET status = excluded.status, current_period_start = excluded.current_period_start, current_period_end = excluded.current_period_end, cancel_at_period_end = excluded.cancel_at_period_end, updated_at = datetime(\'now\')'
              ).bind(generateId(16), userId, sub.customer, sub.id, sub.metadata?.plan || 'starter', sub.status, new Date(sub.current_period_start * 1000).toISOString(), new Date(sub.current_period_end * 1000).toISOString(), sub.cancel_at_period_end ? 1 : 0).run();
              await env.DB.prepare('UPDATE users SET plan = ? WHERE id = ?').bind(sub.metadata?.plan || 'starter', userId).run();
            }
            break;
          }
          case 'customer.subscription.deleted': {
            const sub = event.data.object;
            const userId = sub.metadata?.userId;
            if (userId) {
              await env.DB.prepare('UPDATE subscriptions SET status = ? WHERE stripe_subscription_id = ?').bind('canceled', sub.id).run();
              await env.DB.prepare('UPDATE users SET plan = ? WHERE id = ?').bind('trial', userId).run();
            }
            break;
          }
          case 'invoice.payment_succeeded': {
            const inv = event.data.object;
            await env.DB.prepare(
              'INSERT OR IGNORE INTO invoices (id, user_id, stripe_invoice_id, amount, status, paid_at) VALUES (?, ?, ?, ?, ?, ?)'
            ).bind(generateId(16), inv.metadata?.userId || '', inv.id, (inv.amount_paid || 0) / 100, 'paid', new Date().toISOString()).run();
            break;
          }
        }
        return new Response('OK', { status: 200, headers: corsHeaders });
      } catch (error) { return new Response('Webhook error', { status: 400, headers: corsHeaders }); }
    }

    // Plan limit check helper (used by other endpoints)
    function checkPlanLimit(plan, resource, current) {
      if (!STRIPE_ACTIVE) return { allowed: true };
      const limits = { starter: { users: 1, campaigns: 1 }, campaign: { users: 3, campaigns: 3 }, pro: { users: 10, campaigns: 10 }, consultant: { users: 999, campaigns: 999 }, beta: { users: 999, campaigns: 999 } };
      var limit = (limits[plan] || limits.starter)[resource] || 1;
      return current >= limit ? { allowed: false, limit: limit, upgradeRequired: true } : { allowed: true };
    }

    // ========================================
    // ========================================
    // ADMIN: API Usage Report
    // ========================================
    if (url.pathname === '/api/admin/api-usage' && request.method === 'GET') {
      try {
        const adminPass = request.headers.get('X-Admin-Key');
        if (!adminPass || adminPass !== env.ADMIN_PASSWORD) return jsonResponse({ error: 'Unauthorized' }, 401);
        const summary = await env.DB.prepare(
          'SELECT feature, COUNT(*) as calls, SUM(input_tokens) as total_input, SUM(output_tokens) as total_output, SUM(estimated_cost) as total_cost FROM api_usage GROUP BY feature ORDER BY total_cost DESC'
        ).all();
        const recent = await env.DB.prepare(
          'SELECT feature, input_tokens, output_tokens, estimated_cost, created_at FROM api_usage ORDER BY created_at DESC LIMIT 50'
        ).all();
        const totalCost = await env.DB.prepare('SELECT SUM(estimated_cost) as total FROM api_usage').first();
        return jsonResponse({ success: true, totalCost: totalCost ? totalCost.total : 0, byFeature: summary.results || [], recentCalls: recent.results || [] });
      } catch (error) { return jsonResponse({ error: error.message }, 500); }
    }

    // ========================================
    // ADMIN: Dashboard Stats
    // ========================================
    if (url.pathname === '/api/admin/stats' && request.method === 'GET') {
      try {
        const adminPass = request.headers.get('X-Admin-Key');
        if (!adminPass || adminPass !== env.ADMIN_PASSWORD) {
          return jsonResponse({ error: 'Unauthorized' }, 401);
        }

        const today = new Date().toISOString().split('T')[0];
        const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
        const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

        const [
          totalUsers,
          activeToday,
          activeWeek,
          activeMonth,
          messagesToday,
          messagesTotal,
          onboardingComplete,
          totalTasks,
          totalEvents,
          budgetsSet
        ] = await Promise.all([
          env.DB.prepare('SELECT COUNT(*) as count FROM users').first(),
          env.DB.prepare('SELECT COUNT(DISTINCT user_id) as count FROM usage_logs WHERE date = ?').bind(today).first(),
          env.DB.prepare('SELECT COUNT(DISTINCT user_id) as count FROM usage_logs WHERE date >= ?').bind(weekAgo).first(),
          env.DB.prepare('SELECT COUNT(DISTINCT user_id) as count FROM usage_logs WHERE date >= ?').bind(monthAgo).first(),
          env.DB.prepare('SELECT COALESCE(SUM(message_count), 0) as count FROM usage_logs WHERE date = ?').bind(today).first(),
          env.DB.prepare('SELECT COALESCE(SUM(message_count), 0) as count FROM usage_logs').first(),
          env.DB.prepare('SELECT COUNT(*) as count FROM profiles WHERE onboarding_complete = 1').first(),
          env.DB.prepare('SELECT COUNT(*) as count FROM tasks').first(),
          env.DB.prepare('SELECT COUNT(*) as count FROM events').first(),
          env.DB.prepare('SELECT COUNT(*) as count FROM budget').first()
        ]);

        // Messages per day (last 14 days)
        const dailyMessages = await env.DB.prepare(
          'SELECT date, SUM(message_count) as messages, COUNT(DISTINCT user_id) as users FROM usage_logs WHERE date >= ? GROUP BY date ORDER BY date DESC'
        ).bind(new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]).all();

        return jsonResponse({
          success: true,
          stats: {
            totalUsers: totalUsers.count,
            activeToday: activeToday.count,
            activeWeek: activeWeek.count,
            activeMonth: activeMonth.count,
            messagesToday: messagesToday.count,
            messagesTotal: messagesTotal.count,
            onboardingComplete: onboardingComplete.count,
            totalTasks: totalTasks.count,
            totalEvents: totalEvents.count,
            budgetsSet: budgetsSet.count,
            dailyMessages: dailyMessages.results || []
          }
        });
      } catch (error) {
        return jsonResponse({ error: error.message }, 500);
      }
    }

    // ========================================
    // ADMIN: User List
    // ========================================
    if (url.pathname === '/api/admin/users' && request.method === 'GET') {
      try {
        const adminPass = request.headers.get('X-Admin-Key');
        if (!adminPass || adminPass !== env.ADMIN_PASSWORD) {
          return jsonResponse({ error: 'Unauthorized' }, 401);
        }

        const users = await env.DB.prepare(`
          SELECT 
            u.id,
            u.email,
            u.created_at,
            p.candidate_name,
            p.specific_office,
            p.location,
            p.state,
            p.party,
            p.election_date,
            p.onboarding_complete,
            COALESCE(msg.total_messages, 0) as total_messages,
            msg.last_active,
            COALESCE(t.task_count, 0) as task_count,
            COALESCE(e.event_count, 0) as event_count
          FROM users u
          LEFT JOIN profiles p ON u.id = p.user_id
          LEFT JOIN (
            SELECT user_id, SUM(message_count) as total_messages, MAX(date) as last_active 
            FROM usage_logs GROUP BY user_id
          ) msg ON u.id = msg.user_id
          LEFT JOIN (
            SELECT user_id, COUNT(*) as task_count FROM tasks GROUP BY user_id
          ) t ON u.id = t.user_id
          LEFT JOIN (
            SELECT user_id, COUNT(*) as event_count FROM events GROUP BY user_id
          ) e ON u.id = e.user_id
          ORDER BY msg.last_active DESC NULLS LAST
        `).all();

        return jsonResponse({ success: true, users: users.results || [] });
      } catch (error) {
        return jsonResponse({ error: error.message }, 500);
      }
    }

    // ========================================
    // INTEL: List opponents (STRICT scope — user_id + campaign_id only)
    // GET /api/opponents/list?campaign_id=<id>
    // No campaign_id → empty list. No fallback to NULL-campaign rows. No
    // exceptions. This prevents opponents from bleeding into campaigns they
    // don't belong to (including into brand-new campaigns that haven't saved
    // any opponents yet).
    // ========================================
    if (url.pathname === '/api/opponents/list' && request.method === 'GET') {
      try {
        const ctx = await getSessionContext(request);
        if (!ctx) return jsonResponse({ error: 'Not authenticated' }, 401);
        if (ctx.revoked) return denyRevoked();
        if (!requirePermission(ctx, 'intel', 'read')) return denyPermission('intel');
        const campaignIdParam = url.searchParams.get('campaign_id');
        if (!campaignIdParam || !campaignIdParam.trim()) {
          return jsonResponse({ success: true, opponents: [] });
        }
        const rows = await env.DB.prepare(
          'SELECT id, name, data, last_researched_at, created_at FROM opponents WHERE workspace_owner_id = ? AND campaign_id = ? ORDER BY created_at ASC'
        ).bind(ctx.ownerId, campaignIdParam.trim()).all();
        const opponents = (rows.results || []).map(r => ({
          id: r.id,
          name: r.name,
          data: r.data ? (function(){ try { return JSON.parse(r.data); } catch(e) { return {}; } })() : {},
          last_researched_at: r.last_researched_at,
          created_at: r.created_at
        }));
        return jsonResponse({ success: true, opponents });
      } catch (error) { return jsonResponse({ error: error.message }, 500); }
    }

    // ========================================
    // INTEL: Add opponent (creates row + runs initial research)
    // Scoped per user + campaign. Rejects duplicates (case-insensitive,
    // trimmed name) within the same campaign.
    // ========================================
    if (url.pathname === '/api/opponents/add' && request.method === 'POST') {
      try {
        const ctx = await getSessionContext(request);
        if (!ctx) return jsonResponse({ error: 'Not authenticated' }, 401);
        if (ctx.revoked) return denyRevoked();
        if (!requirePermission(ctx, 'intel', 'full')) return denyPermission('intel');
        const body = await request.json();
        const name = (body.name || '').trim();
        if (!name) return jsonResponse({ error: 'Name required' }, 400);
        const campaignId = body.campaignId && String(body.campaignId).trim() ? String(body.campaignId).trim() : null;
        if (!campaignId) return jsonResponse({ error: 'campaign_id required' }, 400);
        // Verify the workspace owns this campaign (sub-users can attach
        // opponents to any of the owner's campaigns, not someone else's).
        const ownsCampaign = await env.DB.prepare(
          'SELECT id FROM campaigns WHERE id = ? AND owner_id = ?'
        ).bind(campaignId, ctx.ownerId).first();
        if (!ownsCampaign) return jsonResponse({ error: 'Campaign not found' }, 404);

        // Dedup check — workspace + campaign + case-insensitive trimmed name.
        const dupCheck = await env.DB.prepare(
          "SELECT id, name FROM opponents WHERE workspace_owner_id = ? AND campaign_id = ? AND LOWER(TRIM(name)) = LOWER(?) LIMIT 1"
        ).bind(ctx.ownerId, campaignId, name).first();
        if (dupCheck) {
          return jsonResponse({
            error: 'duplicate',
            message: dupCheck.name + ' is already in your opponents list.'
          }, 409);
        }

        const card = await researchOpponent({
          name,
          office: body.office || '',
          state: body.state || '',
          loc: body.location || '',
          year: body.year || new Date().getFullYear(),
          myCandidateName: body.myCandidateName || '',
          myParty: body.myParty || ''
        }, ctx.userId, ctx.ownerId);

        const id = generateId(16);
        const now = new Date().toISOString();
        await env.DB.prepare(
          'INSERT INTO opponents (id, user_id, workspace_owner_id, campaign_id, name, data, last_researched_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        ).bind(id, ctx.userId, ctx.ownerId, campaignId, name, JSON.stringify(card), now, now).run();

        return jsonResponse({ success: true, opponent: { id, name, data: card, last_researched_at: now, created_at: now } });
      } catch (error) {
        console.error('[Opponents add] Error:', error.message);
        return jsonResponse({ error: error.message }, 500);
      }
    }

    // ========================================
    // INTEL: Refresh opponent (72h cooldown enforced)
    // ========================================
    if (url.pathname === '/api/opponents/refresh' && request.method === 'POST') {
      try {
        const ctx = await getSessionContext(request);
        if (!ctx) return jsonResponse({ error: 'Not authenticated' }, 401);
        if (ctx.revoked) return denyRevoked();
        if (!requirePermission(ctx, 'intel', 'full')) return denyPermission('intel');
        const body = await request.json();
        if (!body.id) return jsonResponse({ error: 'id required' }, 400);

        const row = await env.DB.prepare(
          'SELECT name, last_researched_at FROM opponents WHERE id = ? AND workspace_owner_id = ?'
        ).bind(body.id, ctx.ownerId).first();
        if (!row) return jsonResponse({ error: 'Opponent not found' }, 404);

        if (row.last_researched_at) {
          const hoursSince = (Date.now() - new Date(row.last_researched_at).getTime()) / (1000 * 60 * 60);
          if (hoursSince < 72) {
            return jsonResponse({ error: 'cooldown', hoursLeft: Math.ceil(72 - hoursSince) }, 429);
          }
        }

        const card = await researchOpponent({
          name: row.name,
          office: body.office || '',
          state: body.state || '',
          loc: body.location || '',
          year: body.year || new Date().getFullYear(),
          myCandidateName: body.myCandidateName || '',
          myParty: body.myParty || ''
        }, ctx.userId, ctx.ownerId);
        const now = new Date().toISOString();
        await env.DB.prepare(
          'UPDATE opponents SET data = ?, last_researched_at = ? WHERE id = ? AND workspace_owner_id = ?'
        ).bind(JSON.stringify(card), now, body.id, ctx.ownerId).run();

        return jsonResponse({ success: true, opponent: { id: body.id, name: row.name, data: card, last_researched_at: now } });
      } catch (error) {
        console.error('[Opponents refresh] Error:', error.message);
        return jsonResponse({ error: error.message }, 500);
      }
    }

    // ========================================
    // INTEL: Remove opponent
    // ========================================
    if (url.pathname === '/api/opponents/remove' && request.method === 'POST') {
      try {
        const ctx = await getSessionContext(request);
        if (!ctx) return jsonResponse({ error: 'Not authenticated' }, 401);
        if (ctx.revoked) return denyRevoked();
        if (!requirePermission(ctx, 'intel', 'full')) return denyPermission('intel');
        const { id } = await request.json();
        if (!id) return jsonResponse({ error: 'id required' }, 400);
        await env.DB.prepare('DELETE FROM opponents WHERE id = ? AND workspace_owner_id = ?').bind(id, ctx.ownerId).run();
        return jsonResponse({ success: true });
      } catch (error) { return jsonResponse({ error: error.message }, 500); }
    }

    // Only allow POST for the main chat endpoint
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers: corsHeaders });
    }


    // ========================================
    // MAIN CHAT ENDPOINT (default)
    // ========================================
    try {
      const body = await request.json();
      const {
        message, state, officeType, electionDate, party,
        needsOnboarding, filingStatus, candidateName,
        specificOffice, location, history, mode,
        additionalContext, budget, winNumber,
        daysToElection, govLevel, candidateBrief,
        startingAmount, fundraisingGoal, totalRaised,
        donorCount, intelContext, raceProfile,
        conversation_id
      } = body;

      // ========================================
      // RATE LIMITING: 100 messages per user per day.
      // Rate limit is per-user (each collaborator has their own 100/day
      // quota). Cost attribution (billing) goes to the workspace owner.
      // ========================================
      const chatCtx = await getSessionContext(request);
      if (chatCtx && chatCtx.revoked) return denyRevoked();
      const rateLimitUserId = chatCtx ? chatCtx.userId : null;
      const chatOwnerId = chatCtx ? chatCtx.ownerId : null;
      if (rateLimitUserId) {
        const rateLimitDate = new Date().toISOString().split('T')[0];
        const usage = await env.DB.prepare(
          'SELECT message_count FROM usage_logs WHERE user_id = ? AND date = ?'
        ).bind(rateLimitUserId, rateLimitDate).first();
        if (usage && usage.message_count >= 100) {
          return jsonResponse({ error: 'Daily message limit reached. Sam will be ready again tomorrow!' }, 429);
        }
        await env.DB.prepare(
          'INSERT INTO usage_logs (user_id, date, message_count) VALUES (?, ?, 1) ON CONFLICT(user_id, date) DO UPDATE SET message_count = message_count + 1'
        ).bind(rateLimitUserId, rateLimitDate).run();
      }

      // ========================================
      // HELPER: Multi-query VPS search (parallel, free)
      // ========================================
      async function multiSearch(queries, maxCharsPerQuery) {
        const vpsBase = (env.VPS_SEARCH_URL || 'https://search.thecandidatestoolbox.com').replace(/\/+$/, '') + '/smart-search';
        const promises = queries.map(q =>
          fetch(vpsBase, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Search-Key': 'tcb-search-2026' },
            body: JSON.stringify({ query: q, max_results: 5, max_chars: maxCharsPerQuery || 5000 }),
            signal: AbortSignal.timeout(15000)
          }).then(r => r.json()).catch(() => null)
        );
        const responses = await Promise.all(promises);
        let combined = '';
        let ok = 0;
        for (let i = 0; i < responses.length; i++) {
          const r = responses[i];
          if (r && r.content && r.content.length > 30) {
            combined += '\n\n===== Search: ' + queries[i] + ' =====\n' + r.content;
            ok++;
          }
        }
        console.log('[Search] multiSearch:', ok + '/' + queries.length, 'succeeded,', combined.length, 'chars total');
        return combined.length > 100 ? { content: combined, ok, total: queries.length } : null;
      }

      // ========================================
      // RESEARCH MODE — multi-query VPS search, Anthropic fallback
      // ========================================
      if (mode === 'research') {
        // Detect feature for logging. Opponent research has its own endpoint
        // (/api/opponents/*) and is not routed here.
        var researchFeature = 'research';
        if (message.indexOf('morning briefing') >= 0) researchFeature = 'morning_brief';
        else if (message.indexOf('recent news, events, and issues') >= 0) researchFeature = 'intel_pulse';
        else if (message.indexOf('Research the following candidate') >= 0 || message.indexOf('research candidates') >= 0) researchFeature = 'candidate_brief';
        else if (message.indexOf('district pain points') >= 0 || message.indexOf('local news') >= 0) researchFeature = 'day1_brief';

        // Build targeted multi-query search based on feature type
        const yr = new Date().getFullYear();
        const office = specificOffice || 'office';
        const loc = location || '';
        const st = state || '';
        const cn = candidateName || '';
        let searchQueries = [];

        // Build natural district description for better search results
        const fullDistrict = office + ' ' + (loc ? loc + ' ' : '') + st;

        if (researchFeature === 'intel_pulse') {
          searchQueries = [
            cn + ' ' + st + ' news ' + yr,
            fullDistrict + ' politics news ' + yr,
            st + ' political news this week ' + yr,
            loc + ' ' + st + ' election news ' + yr
          ];
        } else if (researchFeature === 'morning_brief') {
          searchQueries = [
            cn + ' ' + st + ' news ' + yr,
            st + ' ' + (body.party || '') + ' politics news today',
            fullDistrict + ' ' + yr + ' campaign',
            loc + ' ' + st + ' news this week'
          ];
        } else if (researchFeature === 'candidate_brief') {
          searchQueries = [
            cn + ' biography background ' + st,
            cn + ' voting record political positions',
            fullDistrict + ' ' + yr + ' election race',
            cn + ' campaign ' + st + ' ' + yr,
            cn + ' endorsements ' + st
          ];
        } else {
          searchQueries = [
            cn + ' ' + fullDistrict + ' ' + yr,
            fullDistrict + ' politics ' + yr,
            cn + ' ' + st + ' news ' + yr
          ];
        }

        // candidate_brief uses Anthropic web_search directly (deeper research).
        // Pulse, morning_brief, day1_brief use multi-query VPS search (free, fast).
        const useAnthropicDirect = researchFeature === 'candidate_brief';
        const vpsResult = useAnthropicDirect ? null : await multiSearch(searchQueries, 5000);

        if (vpsResult) {
          // VPS succeeded — call Haiku WITHOUT web_search tool (much cheaper)
          const enrichedMessage = message + '\n\nHere is current research data you MUST use to answer. Do NOT search the web — use ONLY this data:\n\n' + vpsResult.content;
          const vpsResponse = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
            body: JSON.stringify({
              model: "claude-haiku-4-5-20251001",
              max_tokens: 8000,
              temperature: 0.2,
              system: [{ type: "text", text: 'You are a political research analyst. ' + (researchFeature === 'morning_brief' || researchFeature === 'day1_brief' ? 'Write in plain text, no JSON. Be conversational and concise.' : 'Return ONLY valid JSON. No preamble, no explanation.') + ' Be specific with real names, dates, percentages. Current year is ' + new Date().getFullYear() + '. Use the provided research data to answer. Do not make up data.' }],
              messages: [{ role: "user", content: enrichedMessage }],
            }),
          });
          const vpsData = await vpsResponse.json();
          await logApiUsage(researchFeature + '_vps', vpsData, rateLimitUserId, chatOwnerId);
          return new Response(JSON.stringify(vpsData), { headers: { "Content-Type": "application/json", ...corsHeaders } });
        }

        // VPS failed — fall back to Anthropic web_search (expensive but reliable)
        console.log('[Search] Falling back to Anthropic web_search for', researchFeature);
        const researchSystemPrompt = `You are a political research analyst. Your job is to use web search to research candidates and races, then return structured data as JSON.

RULES:
1. You MUST use web_search to find current, accurate information. Search multiple times if needed.
2. Return ONLY a valid JSON object. No preamble, no explanation, no markdown code fences, no text before or after the JSON.
3. If you cannot find information for a field, use null or an empty string — never omit the field.
4. Be specific: use real names, real dates, real percentages. Do not make up data.
5. Current year is ${new Date().getFullYear()}.`;

        const researchResponse = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
          body: JSON.stringify({
            model: "claude-haiku-4-5-20251001",
            max_tokens: 8000,
            temperature: 0.2,
            system: [{ type: "text", text: researchSystemPrompt }],
            tools: [{ type: "web_search_20250305", name: "web_search" }],
            messages: [{ role: "user", content: message }],
          }),
        });

        const researchData = await researchResponse.json();
        await logApiUsage(researchFeature + '_anthropic', researchData, rateLimitUserId, chatOwnerId);
        return new Response(JSON.stringify(researchData), { headers: { "Content-Type": "application/json", ...corsHeaders } });
      }

      // ========================================
      // HELPER: Determine geographic scope
      // ========================================
      function determineScope(office, level, st, loc) {
        const o = (office || '').toLowerCase();
        const statewideOffices = ['governor','lieutenant governor','attorney general',
          'secretary of state','state treasurer','comptroller','us senator',
          'u.s. senator','united states senator','state senate','state senator',
          'state assembly','state representative','state rep'];
        const isStatewide = statewideOffices.some(x => o.includes(x)) || level === 'state';
        const isFederal = level === 'federal' || o.includes('congress') ||
          (o.includes('representative') && !o.includes('state')) ||
          o.includes('house') || (o.includes('senate') && !o.includes('state'));
        if (isStatewide) return {
          scope: 'statewide', researchArea: `all of ${st}`,
          voterBase: `all registered voters across ${st}`,
          briefScope: `statewide ${st} news and politics`
        };
        if (isFederal) return {
          scope: 'district', researchArea: `${loc} area congressional district in ${st}`,
          voterBase: `district voters`, briefScope: `${loc} district news and federal politics`
        };
        return {
          scope: 'local', researchArea: `${loc}, ${st}`,
          voterBase: `local voters in ${loc}`, briefScope: `${loc} local news and politics`
        };
      }

      // ========================================
      // HELPER: Build timezone-aware date
      // ========================================
      const stateTimezones = {
        'TX':'America/Chicago','CA':'America/Los_Angeles','NY':'America/New_York',
        'FL':'America/New_York','IL':'America/Chicago','PA':'America/New_York',
        'OH':'America/New_York','GA':'America/New_York','NC':'America/New_York',
        'MI':'America/New_York','NJ':'America/New_York','VA':'America/New_York',
        'WA':'America/Los_Angeles','AZ':'America/Phoenix','MA':'America/New_York',
        'TN':'America/Chicago','IN':'America/New_York','MO':'America/Chicago',
        'MD':'America/New_York','WI':'America/Chicago','CO':'America/Denver',
        'MN':'America/Chicago','SC':'America/New_York','AL':'America/Chicago',
        'LA':'America/Chicago','KY':'America/New_York','OR':'America/Los_Angeles',
        'OK':'America/Chicago','CT':'America/New_York','UT':'America/Denver',
        'IA':'America/Chicago','NV':'America/Los_Angeles','AR':'America/Chicago',
        'MS':'America/Chicago','KS':'America/Chicago','NM':'America/Denver',
        'NE':'America/Chicago','ID':'America/Boise','WV':'America/New_York',
        'HI':'Pacific/Honolulu','NH':'America/New_York','ME':'America/New_York',
        'MT':'America/Denver','RI':'America/New_York','DE':'America/New_York',
        'SD':'America/Chicago','ND':'America/Chicago','AK':'America/Anchorage',
        'VT':'America/New_York','WY':'America/Denver','DC':'America/New_York'
      };
      const stateAbbr = (state || '').toUpperCase().trim();
      const tz = stateTimezones[stateAbbr] || 'America/Chicago';
      const today = new Date();
      const currentDate = today.toLocaleDateString('en-US', {
        timeZone: tz, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
      });
      const localParts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit'
      }).formatToParts(today);
      const isoYear = localParts.find(p => p.type === 'year').value;
      const isoMonth = localParts.find(p => p.type === 'month').value;
      const isoDay = localParts.find(p => p.type === 'day').value;
      const isoToday = `${isoYear}-${isoMonth}-${isoDay}`;

      // ========================================
      // HELPER: Build CALENDAR REFERENCE block
      //
      // Turns a math/recall problem into retrieval. Haiku has been
      // making date arithmetic mistakes ("next Saturday is May 3rd"
      // when today is Sunday April 26 and next Saturday is May 2nd)
      // because it tries to compute the answer in its head. This
      // block hands it the full day-by-day mapping so it just looks
      // up the answer.
      //
      // All dates are anchored to UTC noon of the candidate-local
      // calendar date (isoToday is already TZ-corrected). Adding
      // days via 86_400_000 ms preserves the calendar offset across
      // DST transitions because the noon anchor is far from the
      // 2am-3am switch.
      //
      // Week semantics: Monday-Sunday week containing today (per
      // checkpoint spec). When today is Sunday, "this week's Sat"
      // is yesterday and "next week's Sat" is six days from today.
      //
      // Generated fresh every turn. ~250 tokens, ~$0.0003/turn.
      // ========================================
      function buildCalendarReference(isoTodayStr, electionDateRaw) {
        const SHORT = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
        const FULL = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
        const [y, m, d] = isoTodayStr.split('-').map(Number);
        const todayUTC = new Date(Date.UTC(y, m - 1, d, 12));
        const ymd = (dt) => `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
        const addDays = (dt, n) => new Date(dt.getTime() + n * 86400000);
        const dow = (dt) => dt.getUTCDay();
        const sh = (dt) => SHORT[dow(dt)];
        const fl = (dt) => FULL[dow(dt)];

        const yesterday = addDays(todayUTC, -1);
        const tomorrow = addDays(todayUTC, 1);

        // Last 7 days, oldest -> newest (yesterday is the 7th entry)
        const last7 = [];
        for (let i = 7; i >= 1; i--) last7.push(addDays(todayUTC, -i));

        // This week: Monday-Sunday containing today.
        // dow: 0=Sun, 1=Mon ... 6=Sat. daysFromMonday: Mon=0...Sun=6.
        const daysFromMonday = (dow(todayUTC) + 6) % 7;
        const thisMon = addDays(todayUTC, -daysFromMonday);
        const thisWeek = [];
        const nextWeek = [];
        const twoWeeks = [];
        for (let i = 0; i < 7; i++) {
          thisWeek.push(addDays(thisMon, i));
          nextWeek.push(addDays(thisMon, 7 + i));
          twoWeeks.push(addDays(thisMon, 14 + i));
        }

        // End of this/next month. Date.UTC handles year rollover via
        // month overflow (m=12 -> month index 12 = Jan next year, day 0
        // = last day of Dec).
        const eom = new Date(Date.UTC(y, m, 0, 12));
        const eonm = new Date(Date.UTC(y, m + 1, 0, 12));

        // Election day line — only when set + parseable.
        let electionLine = '';
        if (electionDateRaw && /^\d{4}-\d{2}-\d{2}$/.test(String(electionDateRaw).trim())) {
          const [ey, em, ed] = String(electionDateRaw).trim().split('-').map(Number);
          const electUTC = new Date(Date.UTC(ey, em - 1, ed, 12));
          const daysAway = Math.round((electUTC.getTime() - todayUTC.getTime()) / 86400000);
          if (daysAway > 0) {
            electionLine = `\n\nElection day: ${ymd(electUTC)} (${fl(electUTC)}) — ${daysAway} day${daysAway === 1 ? '' : 's'} away`;
          } else if (daysAway === 0) {
            electionLine = `\n\nElection day: ${ymd(electUTC)} (${fl(electUTC)}) — TODAY`;
          } else {
            const ago = -daysAway;
            electionLine = `\n\nElection was ${ymd(electUTC)} (${fl(electUTC)}) — ${ago} day${ago === 1 ? '' : 's'} ago`;
          }
        }

        const fmtRow = (arr) => arr.map(dt => `${sh(dt)} ${ymd(dt)}`).join(' | ');

        return `
================================================================
CALENDAR REFERENCE (use these mappings — do not calculate dates in your head)
================================================================
Today: ${fl(todayUTC)}, ${ymd(todayUTC)}
Yesterday: ${fl(yesterday)}, ${ymd(yesterday)}
Tomorrow: ${fl(tomorrow)}, ${ymd(tomorrow)}

Last 7 days:
${fmtRow(last7)}

This week (Monday-Sunday containing today):
${fmtRow(thisWeek)}

Next week (Monday-Sunday after current week):
${fmtRow(nextWeek)}

Two weeks out (Monday-Sunday):
${fmtRow(twoWeeks)}

This weekend: Sat ${ymd(thisWeek[5])} / Sun ${ymd(thisWeek[6])}
Next weekend: Sat ${ymd(nextWeek[5])} / Sun ${ymd(nextWeek[6])}

End of this month: ${fl(eom)}, ${ymd(eom)}
End of next month: ${fl(eonm)}, ${ymd(eonm)}${electionLine}
================================================================
`;
      }
      const calendarReference = buildCalendarReference(isoToday, electionDate);

      // Campaign phase
      const effectiveDays = daysToElection != null ? daysToElection : null;
      let campaignPhase = 'planning';
      if (effectiveDays != null && effectiveDays > 0) {
        if (effectiveDays <= 7) campaignPhase = 'final-push';
        else if (effectiveDays <= 14) campaignPhase = 'gotv';
        else if (effectiveDays <= 30) campaignPhase = 'closing';
        else if (effectiveDays <= 60) campaignPhase = 'peak-outreach';
        else if (effectiveDays <= 120) campaignPhase = 'building-momentum';
        else campaignPhase = 'early-campaign';
      } else if (effectiveDays != null && effectiveDays <= 0) {
        campaignPhase = 'post-election';
      }

      const geo = determineScope(specificOffice, govLevel || officeType, state, location);
      const effectiveGovLevel = govLevel || officeType || 'unknown';
      const budgetStr = (budget != null && budget > 0) ? '$' + Number(budget).toLocaleString() : 'not set';
      const winNumberStr = (winNumber != null && winNumber > 0) ? Number(winNumber).toLocaleString() + ' votes' : 'not yet calculated';
      const raisedStr = (totalRaised != null && totalRaised > 0) ? '$' + Number(totalRaised).toLocaleString() : '$0';
      const goalStr = (fundraisingGoal != null && fundraisingGoal > 0) ? '$' + Number(fundraisingGoal).toLocaleString() : 'not set';

      // ========================================
      // HELPER: Build candidate brief prose
      // ========================================
      let briefProse = '';
      const briefHasData = candidateBrief && typeof candidateBrief === 'object' &&
        (candidateBrief.incumbent != null || candidateBrief.generalOpponent || candidateBrief.districtPartisanLean || candidateBrief.keyLocalIssues);
      if (briefHasData) {
        const b = candidateBrief;
        let lines = [];
        if (b.incumbent != null) lines.push(b.incumbent ? `${candidateName} is the INCUMBENT.` : `${candidateName} is the CHALLENGER.`);
        if (b.incumbentSince) lines.push(`Incumbent since ${b.incumbentSince}.`);
        if (b.primaryStatus === 'won') {
          lines.push(`${candidateName} WON the primary${b.primaryDate ? ' on ' + b.primaryDate : ''}${b.primaryResult ? ' (' + b.primaryResult + ')' : ''}. The primary is OVER.`);
        } else if (b.primaryStatus) {
          lines.push(`Primary status: ${b.primaryStatus}${b.primaryDate ? ' on ' + b.primaryDate : ''}.`);
        }
        if (b.generalOpponent && b.generalOpponent.name) {
          const opp = b.generalOpponent;
          lines.push(`GENERAL ELECTION OPPONENT: ${opp.name}${opp.party ? ' (' + opp.party + ')' : ''}.`);
          if (opp.background) lines.push(`Opponent background: ${opp.background}.`);
        }
        if (b.districtPartisanLean) lines.push(`District lean: ${b.districtPartisanLean}.`);
        if (b.keyLocalIssues) {
          const issues = Array.isArray(b.keyLocalIssues) ? b.keyLocalIssues.join('; ') : b.keyLocalIssues;
          lines.push(`Key issues: ${issues}.`);
        }
        if (b.countiesOrAreas) {
          const areas = Array.isArray(b.countiesOrAreas) ? b.countiesOrAreas.join(', ') : b.countiesOrAreas;
          lines.push(`Counties/areas: ${areas}.`);
        }
        if (b.recentElectionResults) {
          const results = Array.isArray(b.recentElectionResults) ? b.recentElectionResults.join('; ') : b.recentElectionResults;
          lines.push(`Recent results: ${results}.`);
        }
        if (b.candidateBackground) lines.push(`Candidate background: ${b.candidateBackground}.`);
        if (b.campaignStrategicPriorities) {
          const priorities = Array.isArray(b.campaignStrategicPriorities) ? b.campaignStrategicPriorities.join('; ') : b.campaignStrategicPriorities;
          lines.push(`Strategic priorities: ${priorities}.`);
        }
        if (b.intelligenceNotes) lines.push(`Intel: ${b.intelligenceNotes}.`);
        briefProse = lines.join('\n');
      } else if (candidateBrief && candidateBrief.raw) {
        briefProse = candidateBrief.raw;
      }

      // ========================================
      // HELPER: Build Intel Ground Truth
      // Pulls from the user's opponents (D1) and district pulse (localStorage cache).
      // ========================================
      let intelGroundTruth = '';
      const hasOpps = intelContext && Array.isArray(intelContext.opponents) && intelContext.opponents.length > 0;
      const hasPulse = intelContext && Array.isArray(intelContext.pulseItems) && intelContext.pulseItems.length > 0;
      if (hasOpps || hasPulse) {
        intelGroundTruth = `\nAUTHORITATIVE INTEL — DO NOT CONTRADICT OR SEARCH FRESH:\nSource: user's Intel panel.`;
        if (hasOpps) {
          intelGroundTruth += `\n\nOPPONENTS (${intelContext.opponents.length}):\n` + intelContext.opponents.map(o =>
            `- ${o.name} (${o.party || 'unknown'})${o.office ? ' [' + o.office + ']' : ''} — threat ${o.threatLevel != null ? o.threatLevel + '/10' : 'unknown'}${o.keyRisk ? ' | risk: ' + o.keyRisk : ''}${o.campaignFocus ? ' | focus: ' + o.campaignFocus : ''}`
          ).join('\n');
        }
        if (hasPulse) {
          intelGroundTruth += `\n\nDISTRICT PULSE (recent):\n` + intelContext.pulseItems.slice(0, 6).map(p =>
            `- [${p.category || 'news'}] ${p.headline || ''}${p.summary ? ' — ' + p.summary : ''}`
          ).join('\n');
        }
      } else {
        intelGroundTruth = `\nRACE DATA: No opponents added and no pulse data yet. When asked about opponents, direct the candidate to the Intel panel's My Opponents tab to add and research them. Do not guess opponent names.`;
      }

      // ========================================
      // BUILD SYSTEM PROMPT — Sam 2.0
      // ========================================
      const isNewUser = needsOnboarding === true;
      const isReturningUser = !isNewUser && officeType && officeType !== 'unknown';

      // ========================================
      // TOOL MEMORY — write + read for this turn
      //
      // Generalized fix for the multi-turn tool-result-evaporation
      // problem (yesterday's jurisdiction validator only addressed
      // the geographic case via a bespoke cache table). Walks
      // incoming `messages` for tool_use/tool_result pairs from the
      // current multi-round loop, persists them to sam_tool_memory
      // keyed on conversation_id (deduped on tool_use_id), then
      // loads the 5 most recent rows for this conversation and
      // formats them into a RECENT TOOL RESULTS block injected
      // into the system prompt below.
      //
      // Token budget: per-result capped at 2000 tokens (~8000
      // chars); total block capped at 8000 tokens (~32000 chars).
      // Truncation drops the oldest row(s) until the total fits.
      //
      // No conversation_id → no-op (back-compat with old clients).
      // ========================================
      const TM_CHARS_PER_TOKEN = 4;
      const TM_PER_RESULT_CHARS = 2000 * TM_CHARS_PER_TOKEN;
      const TM_TOTAL_CHARS = 8000 * TM_CHARS_PER_TOKEN;

      function extractToolPairs(msgs) {
        if (!Array.isArray(msgs)) return [];
        const usesByID = new Map();
        const pairs = [];
        for (const m of msgs) {
          if (!m || !Array.isArray(m.content)) continue;
          if (m.role === 'assistant') {
            for (const blk of m.content) {
              if (blk && blk.type === 'tool_use' && blk.id) {
                usesByID.set(blk.id, { tool_use_id: blk.id, name: blk.name, input: blk.input });
              }
            }
          } else if (m.role === 'user') {
            for (const blk of m.content) {
              if (blk && blk.type === 'tool_result' && blk.tool_use_id && usesByID.has(blk.tool_use_id)) {
                const use = usesByID.get(blk.tool_use_id);
                let resultStr;
                if (typeof blk.content === 'string') resultStr = blk.content;
                else { try { resultStr = JSON.stringify(blk.content); } catch (e) { resultStr = String(blk.content); } }
                pairs.push({
                  tool_use_id: use.tool_use_id,
                  name: use.name,
                  input: use.input,
                  result: resultStr
                });
              }
            }
          }
        }
        return pairs;
      }

      async function persistToolMemory(pairs, convId, ownerId) {
        if (!convId || !pairs || pairs.length === 0) return;
        for (const p of pairs) {
          try {
            await env.DB.prepare(
              'INSERT OR IGNORE INTO sam_tool_memory (id, conversation_id, workspace_owner_id, tool_name, tool_use_id, parameters, result) VALUES (?, ?, ?, ?, ?, ?, ?)'
            ).bind(
              generateId(16),
              convId,
              ownerId || null,
              p.name || 'unknown',
              p.tool_use_id || null,
              JSON.stringify(p.input || {}),
              (p.result || '').slice(0, 50000)
            ).run();
          } catch (e) {
            console.warn('[tool_memory] write failed for', p.tool_use_id, e.message);
          }
        }
      }

      async function loadRecentToolMemory(convId) {
        if (!convId) return [];
        try {
          const r = await env.DB.prepare(
            'SELECT tool_name, parameters, result, created_at FROM sam_tool_memory WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 5'
          ).bind(convId).all();
          return (r && r.results) ? r.results : [];
        } catch (e) {
          console.warn('[tool_memory] load failed:', e.message);
          return [];
        }
      }

      function formatToolMemoryBlock(rows) {
        if (!rows || rows.length === 0) return '';
        const entries = rows.map(r => {
          let resultStr = r.result || '';
          if (resultStr.length > TM_PER_RESULT_CHARS) {
            resultStr = resultStr.slice(0, TM_PER_RESULT_CHARS) + '\n... [truncated; full result preserved server-side]';
          }
          const ts = (r.created_at || '').replace(' ', 'T') + 'Z';
          return `[Tool: ${r.tool_name} at ${ts}]\nParameters: ${r.parameters || '{}'}\nResult: ${resultStr}`;
        });
        // Drop oldest rows (entries.pop() — list is newest-first) until total fits.
        const sep = '\n\n';
        while (entries.join(sep).length > TM_TOTAL_CHARS && entries.length > 1) {
          entries.pop();
        }
        return '\n================================================================\nRECENT TOOL RESULTS (within this conversation; authoritative — use instead of memory)\n================================================================\n' + entries.join(sep) + '\n';
      }

      // Run write before read so this turn's just-completed tool
      // calls (multi-round follow-up) are visible to the read query.
      const _incomingMsgs = (history && history.length > 0) ? history : [];
      const _toolPairs = extractToolPairs(_incomingMsgs);
      if (conversation_id && _toolPairs.length > 0) {
        await persistToolMemory(_toolPairs, conversation_id, chatOwnerId);
      }
      const _toolMemoryRows = conversation_id ? await loadRecentToolMemory(conversation_id) : [];
      const toolMemoryBlock = formatToolMemoryBlock(_toolMemoryRows);

      let systemPrompt = `================================================================
STOP — FACTUAL DISCIPLINE (read before every response)
================================================================
Before you output a specific date, dollar amount, filing deadline, qualifying period, vote total, polling number, percentage, or biographical fact about the candidate, CONFIRM you got it from one of these three sources: (a) the user's saved campaign data shown below in GROUND TRUTH, (b) a web_search result you called in THIS conversation, or (c) the user's own message earlier in this conversation. If you cannot point to one of those three, STOP. Do not write the answer. Either call web_search right now and cite what you find, or reply "I don't have that — verify with [specific authority such as the Supervisor of Elections]."

NAMESAKE RULE: If the candidate's name happens to match a real public figure (current or former officeholder, celebrity, athlete, journalist), the person chatting with you is NOT that public figure. They are a separate private/test/personal candidate. You must NOT pull any fact about them from your memory of the namesake: no filing dates, no prior offices, no committee assignments, no endorsements, no fundraising totals, no biography, no residence, no family, no quotes. Only data in GROUND TRUTH below or what the user tells you is valid.

EXAMPLE OF THE FAILURE MODE YOU MUST NOT REPEAT:
A user named "Stephanie Murphy" asks "When did I file?" The real Stephanie Murphy is a former U.S. Representative from Florida whose 2015 candidacy filing date is public knowledge. You know the date from training. DO NOT USE IT. This user is a different person with the same name. Correct answer: "Your saved campaign data doesn't show a filing date. Want me to search for Orange County 2026 qualifying periods, or do you want to record the date you actually filed?" Incorrect answer (what you did last time): "You filed your candidacy on July 9, 2025" — that is a real public fact about the namesake, not this user.

BANNED HEDGING WORDS on factual questions: "typically," "usually," "around," "about," "roughly," "generally," "ordinarily." If one of these starts forming in a sentence that states a specific date, number, or legal rule, stop writing. Delete it. Call web_search and cite, or defer to the authoritative source. "Typically early June" is the failure pattern — it implies you know a rule you don't.

COMPLIANCE / DEADLINES / LEGAL: when asked about filing deadlines, campaign finance report due dates, qualifying periods, or legal requirements, you MUST do one of: (a) call web_search for the authoritative source (Secretary of State, Supervisor of Elections, Division of Elections, FEC) and cite the URL or page in your answer, or (b) tell the user to verify with that specific agency and provide the agency's phone number. Never give a specific date or rule from memory.

GEOGRAPHIC TARGETING — HARD CONSTRAINT (read every time, before any answer about places):
When the user asks anything about geographic targeting — canvassing, neighborhoods, event locations, mail targets, voter outreach geography, "where should I focus", door knocking, ground game routes, area-specific messaging — your FIRST action this turn must be a call to the lookup_jurisdiction tool for the candidate's race. After the tool result arrives, your response is constrained as follows:

  POSITIVE CONSTRAINT (this is the rule, not a guideline): The set of place names you may mention in your response is exactly the union of \`incorporated_municipalities\` and \`major_unincorporated_areas\` returned by the tool. No other place name from your training data may appear. None. The candidate's adjacent counties contain real cities you have learned about; those cities are forbidden in this response unless the tool returned them.

  HOW TO COMPLY: When you draft each sentence that names a place, ask yourself: "Did the lookup_jurisdiction result I received this turn list this exact place?" If the answer is no, delete the place name and pick a different one from the result.

  EXAMPLE OF THE FAILURE MODE TO AVOID (this happened on 2026-04-25 with a real beta user): A user running for Orange County, FL Mayor asked where to canvass. The tool was called, the tool returned Apopka, Bay Lake, Belle Isle, Eatonville, Edgewood, Lake Buena Vista, Maitland, Oakland, Ocoee, Orlando, Windermere, Winter Garden, Winter Park, plus 49 unincorporated areas. None of those are Altamonte Springs or Sanford. Your prior response listed Altamonte Springs as a high-priority canvassing area. Altamonte Springs is in Seminole County, not Orange County. That response was factually wrong. You wrote a fabricated recommendation despite having the correct list in your context.

  IF YOU HAVE NO TOOL RESULT (the lookup returned source: 'unsupported' for district-level races): say to the user, "I don't have a verified place list for this jurisdiction type yet — I can recommend tactics but not specific neighborhoods. Want me to research the district's largest population centers via web_search?" Do not invent place names from training.

================================================================

You are Sam, a veteran political campaign manager with 20 years of experience. Direct, strategic, warm but no-nonsense. You speak in campaign language — earned media, persuadables, GOTV, burn rate, ground game, ballot position. You always have a strong opinion and a clear recommendation. When uncertain, say "let me verify that" — never "I don't know."

You work for ${candidateName || 'the candidate'}, who is running for ${specificOffice || 'office'} in ${location || 'their district'}, ${state || 'their state'}. The person chatting with you IS ${candidateName || 'the candidate'}.

================================================================
GROUND TRUTH — ${currentDate} (${isoToday})
================================================================
Candidate: ${candidateName || 'unknown'} | Office: ${specificOffice || officeType || 'unknown'} (${effectiveGovLevel})
Location: ${location || 'unknown'}, ${state || 'unknown'} | Party: ${party || 'not specified'}
Election: ${electionDate || 'not set'}${effectiveDays != null ? ' (' + effectiveDays + ' days away)' : ''} | Phase: ${campaignPhase}
Budget: ${budgetStr} | Win Number: ${winNumberStr}
Raised: ${raisedStr} of ${goalStr} goal | Donors: ${donorCount || 0}${startingAmount ? ' | Starting cash: $' + Number(startingAmount).toLocaleString() : ''}
Filed: ${filingStatus || 'unknown'}${effectiveDays != null && effectiveDays > 180 ? ' (early planning — do not ask about filing)' : ''}
${briefProse ? `\nRACE INTELLIGENCE:\n${briefProse}` : ''}
${intelGroundTruth}

${body.raceProfile && body.raceProfile.raceType !== 'political' ? `
RACE TYPE — THIS IS A ${(body.raceProfile.raceType || '').toUpperCase().replace(/_/g,' ')} RACE:
${body.raceProfile.raceNotes || ''}
Key endorsements: ${(body.raceProfile.keyEndorsements || []).join(', ')}
Messaging priorities: ${(body.raceProfile.messagingPriorities || []).join(', ')}
Budget priorities: ${(body.raceProfile.budgetPriorities || []).join(', ')}
Avoid: ${(body.raceProfile.avoidTactics || []).join(', ')}
Voter priorities: ${(body.raceProfile.voterPriorities || []).join(', ')}
${(body.raceProfile.specialRules || []).length ? 'Special rules: ' + body.raceProfile.specialRules.join(', ') : ''}
Adjust ALL advice for this race type. Never give generic political campaign advice when race-specific guidance exists.
` : ''}
RESEARCH SCOPE: ${geo.scope} race. Always research ${geo.researchArea}. Never limit to just ${location} for ${geo.scope !== 'local' ? 'this ' + geo.scope + ' race' : 'this race'}.

CURRENT CAMPAIGN STATUS:
${additionalContext || 'No additional context.'}
${calendarReference}${toolMemoryBlock}
================================================================
RULES (mandatory, ranked by priority)
================================================================
1. Always call the appropriate tool before confirming any action. Never claim you did something without a tool call. If you need multiple tools, call ALL of them before responding.
2. Never ask for information already in Ground Truth — use what you have. If a field says "not set" you may ask ONCE.
3. Dates: today is ${isoToday}. Never guess dates. Always cite your source. Use YYYY-MM-DD format for tools. Never state the day of the week. Never use relative dates like "tomorrow" or "next week."
4. Compliance: never tell a candidate they are "compliant" or "all set." Present information as "here is what I found" and recommend verification with their clerk or elections office.
5. Never narrate your research. No "Let me search..." or "Based on search results..." — just deliver the answer.
6. Geographic scope: for ${geo.scope} races, always research ${geo.researchArea}. Never limit to just the candidate's home city.
7. If Intel Ground Truth has candidate data, use it as authoritative. Never search for data that is already in Ground Truth. Never give a different candidate count.
8. Budget categories: digital, mail, broadcast, polling, fieldOps, fundraisingCompliance, consulting, reserveFund, signs, events, staffing, misc. Always map user language to these keys.
9. Services redirect: for voter lists, direct mail, TV ads, texting campaigns, door knocking, yard signs, campaign websites — give strategic advice but redirect implementation to "the Candidate's Toolbox services team."
10. After adding calendar items, confirm briefly and ask what to work on next. Do not explain your search process.
11. When writing documents (speeches, emails, scripts), write the FULL document ready to use. Ask 1-2 clarifying questions first if needed. Present the draft, then ask if the candidate wants it saved.
12. Calendar management: check the calendar context for duplicates before adding. Tasks = deadlines/to-dos. Events = activities at a time/place. Ask before adding unless the user explicitly requests it.
13. Win number: always research the state's primary system first. Top-two primary states (CA, WA) require top-two finish. Never simply divide total votes by candidates.
14. Keep responses to 2-3 sentences by default. Go longer only when asked for detail or writing documents. No bullet lists unless presenting 3+ items. Ask ONE question at a time.
15. End every response with one specific actionable recommendation or question.`;

      // Onboarding block
      if (isNewUser) {
        systemPrompt += `

ONBOARDING MODE — THIS OVERRIDES DEFAULT BEHAVIOR:
The candidate just completed setup. Profile is saved. Name: ${candidateName}. Office: ${specificOffice}. Location: ${location}, ${state}. Party: ${party}. Election: ${electionDate}. Filed: ${filingStatus}.

The app already showed a greeting. DO NOT greet again or introduce yourself.
1. Search for "${state} ${specificOffice} campaign finance report deadlines ${today.getFullYear()}"
2. Search for "${state} personal financial statement PFS filing deadline ${today.getFullYear()}"
3. DO NOT add anything to the calendar yet.
4. Present all deadlines found with dates and sources. Note any that have passed.
5. Say: "I'd recommend verifying all deadlines with your county clerk or elections office."
6. End with: "Want me to add these to your calendar?"`;
      } else if (isReturningUser) {
        systemPrompt += `

RETURNING USER: Greet warmly, reference their campaign naturally, jump right into helping. Don't re-explain who you are.`;
      }

      // Phase guidance
      if (effectiveDays != null && effectiveDays > 0) {
        const phaseAdvice = {
          'final-push': 'GOTV — getting supporters to the polls. Every hour counts.',
          'gotv': 'Voter contact is #1 — phone banks, door knocking, text banking, early voting reminders.',
          'closing': 'Final messaging, last fundraising pushes, media outreach, debate prep.',
          'peak-outreach': 'Maximum voter contact, community appearances, building name recognition.',
          'building-momentum': 'Fundraising, volunteer base, message development, earned media.',
          'early-campaign': 'Research, core team, initial fundraising, message development.'
        };
        if (phaseAdvice[campaignPhase]) {
          systemPrompt += `\n\nCAMPAIGN PHASE (${campaignPhase}, ${effectiveDays} days): ${phaseAdvice[campaignPhase]}`;
        }
      }

      // Mode hints
      if (mode === 'compliance') systemPrompt += `\nMODE: Compliance — search for current dates, name sources, recommend verification.`;
      else if (mode === 'writing') systemPrompt += `\nMODE: Content Writing — ask clarifying questions, then deliver ready-to-use drafts.`;
      else if (mode === 'fundraising') systemPrompt += `\nMODE: Fundraising — practical advice, scripts, templates for grassroots campaigns.`;
      else if (mode === 'strategy') systemPrompt += `\nMODE: Strategy — specific advice based on timeline, office type, and current calendar.`;
      // (Geographic targeting rule moved to the top of the prompt
      // alongside FACTUAL DISCIPLINE — placement after the mode block
      // was too far down and Sam was ignoring it. See the STOP block
      // at the start of the prompt.)

      // ========================================
      // TOOL DEFINITIONS — Sam 2.0 (consolidated)
      // ========================================
      const tools = [
        { type: "web_search_20250305", name: "web_search" },
        {
          name: "add_calendar_event",
          description: "Add a task OR event to the campaign calendar. Use type='task' for deadlines and to-dos (things to complete BY a date). Use type='event' for activities AT a specific time and place (town halls, fundraisers, meetings). Always include the date in YYYY-MM-DD format. Check the calendar context in Ground Truth before adding to avoid duplicates.",
          input_schema: {
            type: "object",
            properties: {
              name: { type: "string", description: "Name of the task or event" },
              date: { type: "string", description: "Date in YYYY-MM-DD format" },
              type: { type: "string", enum: ["task", "event"], description: "task = deadline/to-do, event = activity at a time/place" },
              time: { type: "string", description: "Start time in HH:MM 24h format (events only)" },
              end_time: { type: "string", description: "End time in HH:MM 24h format (optional)" },
              location: { type: "string", description: "Venue or address (events only)" },
              category: { type: "string", enum: ["compliance", "outreach", "fundraising", "internal", "deadline", "event", "other"], description: "Category for calendar display" },
              notes: { type: "string", description: "Optional notes" }
            },
            required: ["name", "date", "type"]
          }
        },
        {
          name: "update_task",
          description: "Update an existing task. Use the taskId from the UPCOMING TASKS list in context to target the exact task. Falls back to name matching if no ID provided.",
          input_schema: {
            type: "object",
            properties: {
              taskId: { type: "string", description: "The unique taskId from the tasks list in context (e.g., '1713200000.5'). Always prefer this over name matching." },
              task_name: { type: "string", description: "Fallback: task name for partial matching if taskId not available" },
              new_name: { type: "string", description: "New name (if changing)" },
              new_date: { type: "string", description: "New date in YYYY-MM-DD (if changing)" },
              new_category: { type: "string", description: "New category (if changing)" }
            },
            required: ["taskId"]
          }
        },
        {
          name: "delete_task",
          description: "Remove a task from the calendar. Use the taskId from the tasks list in context.",
          input_schema: {
            type: "object",
            properties: {
              taskId: { type: "string", description: "The unique taskId from the tasks list in context" },
              task_name: { type: "string", description: "Fallback: task name for partial matching" }
            },
            required: ["taskId"]
          }
        },
        {
          name: "complete_task",
          description: "Mark a task as completed. Use when the candidate says they finished, filed, or submitted something. Use the taskId from the tasks list in context.",
          input_schema: {
            type: "object",
            properties: {
              taskId: { type: "string", description: "The unique taskId from the tasks list in context" },
              task_name: { type: "string", description: "Fallback: task name for partial matching" }
            },
            required: ["taskId"]
          }
        },
        {
          name: "update_event",
          description: "Update an existing event. Use the eventId from the UPCOMING EVENTS list in context.",
          input_schema: {
            type: "object",
            properties: {
              eventId: { type: "string", description: "The unique eventId from the events list in context" },
              event_name: { type: "string", description: "Fallback: event name for partial matching" },
              new_name: { type: "string", description: "New name (if changing)" },
              new_date: { type: "string", description: "New date in YYYY-MM-DD (if changing)" },
              new_time: { type: "string", description: "New time in HH:MM 24h (if changing)" },
              new_location: { type: "string", description: "New location (if changing)" }
            },
            required: ["eventId"]
          }
        },
        {
          name: "delete_event",
          description: "Remove an event from the calendar. Use the eventId from the events list in context.",
          input_schema: {
            type: "object",
            properties: {
              eventId: { type: "string", description: "The unique eventId from the events list in context" },
              event_name: { type: "string", description: "Fallback: event name for partial matching" }
            },
            required: ["eventId"]
          }
        },
        {
          name: "add_expense",
          description: "Log a campaign expense. ALWAYS call this when the candidate asks to log, add, record, or track any expense. Map user language to category keys: signs/yard signs/banners=signs, Facebook/Google/digital ads=digital, mailers/direct mail=mail, TV/radio=broadcast, polling/surveys=polling, canvassing/doors=fieldOps, legal/filing fees=fundraisingCompliance, consultants=consulting, staff/salaries=staffing, events/rallies=events, emergency=reserveFund, other=misc.",
          input_schema: {
            type: "object",
            properties: {
              amount: { type: "number", description: "Expense amount in dollars" },
              category: { type: "string", enum: ["digital","mail","broadcast","polling","fieldOps","fundraisingCompliance","consulting","reserveFund","signs","events","staffing","misc"], description: "Budget category key" },
              description: { type: "string", description: "Brief description" },
              date: { type: "string", description: "Date in YYYY-MM-DD (defaults to today)" }
            },
            required: ["amount", "category", "description"]
          }
        },
        {
          name: "log_contribution",
          description: "Log a campaign donation. ALWAYS call when the candidate reports receiving money.",
          input_schema: {
            type: "object",
            properties: {
              donorName: { type: "string", description: "Donor name" },
              amount: { type: "number", description: "Dollar amount" },
              source: { type: "string", enum: ["individual","event","online","inkind"], description: "Source type" },
              date: { type: "string", description: "Date in YYYY-MM-DD" },
              employer: { type: "string", description: "Employer (required for >$200)" },
              occupation: { type: "string" },
              notes: { type: "string" }
            },
            required: ["donorName", "amount", "source"]
          }
        },
        {
          name: "set_budget",
          description: "Set or update campaign budget settings. You MUST include at least one of: total, startingAmount, or fundraisingGoal. Can set multiple in one call. Example: to set a $25K budget use {total: 25000}. To set a fundraising goal use {fundraisingGoal: 50000}.",
          input_schema: {
            type: "object",
            properties: {
              total: { type: "number", description: "Total campaign budget in dollars" },
              startingAmount: { type: "number", description: "Starting cash on hand in dollars" },
              fundraisingGoal: { type: "number", description: "Fundraising goal in dollars" }
            },
            required: []
          }
        },
        {
          name: "set_category_allocation",
          description: "Set budget allocation for a spending category.",
          input_schema: {
            type: "object",
            properties: {
              category: { type: "string", enum: ["digital","mail","broadcast","polling","fieldOps","fundraisingCompliance","consulting","reserveFund","signs","events","staffing","misc"], description: "Budget category key" },
              amount: { type: "number", description: "Dollar amount to allocate" }
            },
            required: ["category", "amount"]
          }
        },
        {
          name: "save_note",
          description: "Save any content to the notes system — speeches, talking points, emails, press releases, scripts, plans, research. Choose folder based on content type: 'Speeches', 'Talking Points', 'Email Drafts', 'Press Releases', 'Campaign Plan', 'Voter Outreach', 'Fundraising Scripts', or create a new folder name. CRITICAL: when the user confirms a save request (says 'yes', 'save it', 'save that', 'please save', or any affirmative to your save offer), you MUST call this tool in that same response. Do NOT reply with '✅ Saved' or similar in text alone — the text-only reply does nothing; only this tool persists the note. The tool is silent on success; the app shows its own confirmation.",
          input_schema: {
            type: "object",
            properties: {
              title: { type: "string", description: "Document title" },
              content: { type: "string", description: "Full content" },
              folder: { type: "string", description: "Folder name (created if doesn't exist)" },
              status: { type: "string", enum: ["Draft","Ready","In Progress"], description: "Document status (default: Ready)" },
              doc_type: { type: "string", enum: ["Speech","Talking Points","Email Draft","Press Release","Campaign Plan","Voter Outreach","Fundraising Script","Other"], description: "Document type" }
            },
            required: ["title", "content", "folder"]
          }
        },
        {
          name: "add_endorsement",
          description: "Add an endorsement to the endorsements panel.",
          input_schema: {
            type: "object",
            properties: {
              name: { type: "string", description: "Endorser name (person or organization)" },
              title: { type: "string", description: "Title or organization" },
              notes: { type: "string", description: "Notes about the endorsement" },
              status: { type: "string", enum: ["Announced","Pending","Pursuing"], description: "Endorsement status" }
            },
            required: ["name", "status"]
          }
        },
        {
          name: "navigate_to",
          description: "Switch the app to a specific view.",
          input_schema: {
            type: "object",
            properties: {
              view: { type: "string", enum: ["dashboard","calendar","budget","notes","toolbox","settings"], description: "View to navigate to" }
            },
            required: ["view"]
          }
        },
        {
          name: "save_win_number",
          description: "Save the calculated win number to the dashboard. Only call after researching last election data, calculating the target, and the candidate confirms. Pass win_number as a plain integer with no commas or formatting (e.g., 176650 not 176,650).",
          input_schema: {
            type: "object",
            properties: {
              win_number: { type: "number", description: "Votes needed to win (after safety margin)" },
              total_votes_last_election: { type: "number", description: "Total votes in last comparable election" },
              num_candidates: { type: "number", description: "Number of candidates including this one" },
              election_type: { type: "string", description: "'primary' or 'general'" }
            },
            required: ["win_number", "total_votes_last_election", "num_candidates", "election_type"]
          }
        },
        {
          name: "save_candidate_profile",
          description: "Update candidate profile data. Use during onboarding or when the candidate corrects their info.",
          input_schema: {
            type: "object",
            properties: {
              office: { type: "string" }, office_level: { type: "string", enum: ["local","state","federal"] },
              city: { type: "string" }, state: { type: "string" },
              election_date: { type: "string" }, has_filed: { type: "boolean" }
            },
            required: ["office", "office_level", "city", "state", "has_filed"]
          }
        },
        {
          name: "lookup_jurisdiction",
          description: "Look up the official list of municipalities and unincorporated areas inside a jurisdiction. CRITICAL: when the user asks about geographic targeting (canvassing, neighborhoods, event locations, mail targets, voter outreach geography, where to focus), call this tool FIRST for the candidate's race. Then recommend ONLY locations from the returned list. If you mention any city, town, or area not in the returned list, you are factually wrong. There are no exceptions to this rule.",
          input_schema: {
            type: "object",
            properties: {
              office: { type: "string", description: "The candidate's office, e.g. 'Mayor', 'US House', 'State House'" },
              state: { type: "string", description: "The state, e.g. 'Florida' or 'FL'" },
              jurisdiction_name: { type: "string", description: "The specific jurisdiction the candidate is running in, e.g. 'Orange County' or 'FL-7' or 'Apopka'" }
            },
            required: ["office", "state", "jurisdiction_name"]
          }
        }
      ];

      // ========================================
      // SERVER-SIDE TOOL LOOP — Sam 2.0
      // ========================================
      function acknowledgeToolCall(name, input) {
        const inp = input || {};
        switch (name) {
          case 'add_calendar_event':
            return { success: true, message: `${inp.type === 'task' ? 'Task' : 'Event'} "${inp.name}" added for ${inp.date}${inp.time ? ' at ' + inp.time : ''}` };
          case 'update_task': return { success: true, message: `Task "${inp.task_name}" updated` };
          case 'delete_task': return { success: true, message: `Task "${inp.task_name}" removed` };
          case 'complete_task': return { success: true, message: `Task "${inp.task_name}" completed` };
          case 'update_event': return { success: true, message: `Event "${inp.event_name}" updated` };
          case 'delete_event': return { success: true, message: `Event "${inp.event_name}" removed` };
          case 'add_expense': return { success: true, message: `$${inp.amount} expense logged for ${inp.description} in ${inp.category}` };
          case 'log_contribution': return { success: true, message: `$${inp.amount} contribution from ${inp.donorName} logged` };
          case 'set_budget': {
            const parts = [];
            if (inp.total) parts.push(`Budget: $${inp.total}`);
            if (inp.startingAmount) parts.push(`Starting cash: $${inp.startingAmount}`);
            if (inp.fundraisingGoal) parts.push(`Goal: $${inp.fundraisingGoal}`);
            return parts.length > 0
              ? { success: true, message: parts.join(', ') + ' set' }
              : { success: false, message: 'No budget fields provided — include total, startingAmount, or fundraisingGoal' };
          }
          case 'set_category_allocation': return { success: true, message: `${inp.category} allocation set to $${inp.amount}` };
          case 'save_note': return { success: true, message: `"${inp.title}" saved to ${inp.folder}` };
          case 'add_endorsement': return { success: true, message: `${inp.name} added as ${inp.status} endorsement` };
          case 'navigate_to': return { success: true, message: `Navigated to ${inp.view}` };
          case 'save_win_number': return { success: true, message: `Win number set to ${inp.win_number} votes` };
          case 'save_candidate_profile': return { success: true, message: `Profile saved` };
          default: return { success: true, message: `${name} executed` };
        }
      }

      async function callClaude(msgs) {
        const resp = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": env.ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: "claude-haiku-4-5-20251001",
            max_tokens: 10000,
            temperature: 0.4,
            system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
            tools: tools,
            messages: msgs,
          }),
        });
        const data = await resp.json();
        await logApiUsage('sam_chat', data, rateLimitUserId, chatOwnerId);
        return data;
      }

      // ============================================================
      // GEOGRAPHIC HALLUCINATION VALIDATOR
      //
      // Three prompt-rule iterations failed to stop Haiku 4.5 from
      // recommending adjacent-county cities (Altamonte Springs in
      // Seminole Co. for an Orange Co. FL race) even when the
      // lookup_jurisdiction tool returned the correct exclusion list.
      // Architectural fix: post-process Sam's response server-side
      // BEFORE delivery. If she names a place not in the tool result,
      // regenerate with explicit feedback (Option B); if regeneration
      // also fails, strip the offending sentences (Option A
      // fallback). One retry max — no infinite loops.
      // ============================================================

      // Cached-jurisdiction lookup keyed on the candidate's stable race
      // profile (office + state + location). Independent of conversation
      // history — works on every turn, including turns where Sam did
      // NOT call lookup_jurisdiction this turn but called it on a
      // previous turn (or in a previous conversation entirely; rows
      // live for 90 days).
      //
      // Why this exists: client-side chatHistory persists only plain
      // text. tool_use / tool_result blocks evaporate after the
      // multi-round loop. So walking `messages` for a tool_result
      // works ONLY for the same turn the tool fired. Turn 2 of any
      // conversation would skip validation entirely without this
      // path. (The cache table is the candidate's authoritative
      // jurisdiction record — fed by Sam's lookup_jurisdiction calls
      // and stable for the campaign.)
      //
      // Tolerant of state-format drift: Sam has historically called
      // the tool with both "FL" and "Florida", so we match either.
      async function lookupCachedJurisdictionForRace(office, stateCode, jurisdictionName) {
        if (!office || !stateCode || !jurisdictionName) return null;
        const stateExpanded = expandStateName(stateCode);
        try {
          const row = await env.DB.prepare(
            "SELECT jurisdiction_type, official_name, incorporated_municipalities, major_unincorporated_areas, source " +
            "FROM jurisdiction_lookups " +
            "WHERE LOWER(office) = LOWER(?) " +
            "  AND LOWER(jurisdiction_name) = LOWER(?) " +
            "  AND (LOWER(state) = LOWER(?) OR LOWER(state) = LOWER(?)) " +
            "  AND created_at > datetime('now', '-90 days') " +
            "ORDER BY created_at DESC LIMIT 1"
          ).bind(office, jurisdictionName, stateCode, stateExpanded).first();
          if (!row) return null;
          return {
            jurisdiction_type: row.jurisdiction_type,
            official_name: row.official_name,
            incorporated_municipalities: JSON.parse(row.incorporated_municipalities || '[]'),
            major_unincorporated_areas: JSON.parse(row.major_unincorporated_areas || '[]'),
            source: row.source
          };
        } catch (e) {
          console.warn('[validator] cache lookup failed:', e.message);
          return null;
        }
      }

      // Walk history backwards for the most recent lookup_jurisdiction
      // tool_result. Identified by the parsed JSON having
      // incorporated_municipalities (the shape of our lookup endpoint).
      // Used as a fallback when the candidate-profile cache lookup
      // misses (e.g., race profile not yet populated; jurisdiction
      // tool was called this turn with a name that doesn't match the
      // profile's `location` field exactly).
      function findMostRecentJurisdictionLookup(msgs) {
        for (let i = msgs.length - 1; i >= 0; i--) {
          const m = msgs[i];
          if (!m || m.role !== 'user' || !Array.isArray(m.content)) continue;
          for (const blk of m.content) {
            if (!blk || blk.type !== 'tool_result' || typeof blk.content !== 'string') continue;
            try {
              const parsed = JSON.parse(blk.content);
              if (parsed && Array.isArray(parsed.incorporated_municipalities)) {
                return parsed;
              }
            } catch (e) {}
          }
        }
        return null;
      }

      function extractTextFromContent(content) {
        if (!Array.isArray(content)) return '';
        let s = '';
        for (const b of content) {
          if (b && b.type === 'text' && typeof b.text === 'string') s += b.text;
        }
        return s.trim();
      }

      // Cheap Haiku call (~$0.001) to extract place names from Sam's
      // text and flag any not in the authorized list. Tagged
      // 'sam_validator' in api_usage so the cost is auditable.
      async function extractUnauthorizedPlaces(samText, authorizedList) {
        const prompt = 'You are a place-name auditor. Given a campaign coaching response and an authorized list of US places, return JSON.\n\n' +
          'RESPONSE:\n' + samText + '\n\n' +
          'AUTHORIZED LIST (case-insensitive — these are the only US cities, towns, neighborhoods, or unincorporated communities the response is allowed to mention):\n' +
          authorizedList.join(', ') + '\n\n' +
          'TASK: Extract every US city, town, neighborhood, or unincorporated community name mentioned in RESPONSE. For each, decide whether it appears (case-insensitive substring match) in AUTHORIZED LIST. Return JSON only — no preamble, no markdown:\n' +
          '{"mentioned": ["Place A", "Place B"], "unauthorized": ["Place B"]}\n\n' +
          'RULES:\n' +
          '- "mentioned" includes ALL specific places (cities, towns, neighborhoods, communities). Exclude state names, country names, county names, region words ("Florida", "the South", "Orange County"), and generic words ("downtown", "the city").\n' +
          '- "unauthorized" is the subset of mentioned that does NOT appear in AUTHORIZED LIST. Use case-insensitive substring; be lenient on suffixes (Apopka matches "South Apopka" as authorized via "Apopka").\n' +
          '- If no places mentioned: {"mentioned": [], "unauthorized": []}\n' +
          '- DO NOT add commentary. JSON only.';
        try {
          const resp = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': env.ANTHROPIC_API_KEY,
              'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
              model: 'claude-haiku-4-5-20251001',
              max_tokens: 600,
              temperature: 0,
              messages: [{ role: 'user', content: prompt }]
            })
          });
          const data = await resp.json();
          await logApiUsage('sam_validator', data, rateLimitUserId, chatOwnerId);
          let text = '';
          if (data && data.content && Array.isArray(data.content)) {
            for (const b of data.content) if (b && b.type === 'text' && b.text) text += b.text;
          }
          const m = text.match(/\{[\s\S]*\}/);
          if (!m) return { mentioned: [], unauthorized: [] };
          const parsed = JSON.parse(m[0]);
          return {
            mentioned: Array.isArray(parsed.mentioned) ? parsed.mentioned : [],
            unauthorized: Array.isArray(parsed.unauthorized) ? parsed.unauthorized : []
          };
        } catch (e) {
          // Validator failure → return empty (don't block delivery on auditor error)
          console.warn('[validator] extract failed:', e.message);
          return { mentioned: [], unauthorized: [] };
        }
      }

      // Option B: regenerate Sam's response with explicit feedback.
      // Append the bad response + correction to the history and re-call.
      async function regenerateWithFeedback(originalMsgs, badContent, unauthorized, authorized) {
        const retryMsgs = [
          ...originalMsgs,
          { role: 'assistant', content: badContent },
          { role: 'user', content:
            'STOP. Your previous response mentioned ' + unauthorized.join(', ') +
            ' — these are NOT in this race\'s jurisdiction and are forbidden. ' +
            'Regenerate the recommendation using ONLY these authorized places: ' +
            authorized.join(', ') +
            '. Reply with only the regenerated answer — no preamble, no acknowledgment of this correction.'
          }
        ];
        return await callClaude(retryMsgs);
      }

      // Option A fallback: drop any sentence/bullet that mentions an
      // unauthorized place. Threshold-checks the result so a near-empty
      // response gets a graceful generic instead.
      function stripUnauthorizedSentences(samText, unauthorized) {
        const sentences = samText.split(/(?<=[.!?])\s+|\n+/);
        const cleaned = sentences.filter(s => {
          const sLower = s.toLowerCase();
          return !unauthorized.some(u => u && sLower.includes(u.toLowerCase()));
        });
        let joined = cleaned.join(' ').replace(/\s+/g, ' ').trim();
        if (joined.length < 60) {
          return "I want to make sure I'm grounded in your specific jurisdiction before giving you a recommendation. Could you share a particular area or angle (high-density precincts, donor-rich neighborhoods, areas with low past turnout) and I'll work from there?";
        }
        return joined + '\n\n*(Note: removed recommendations that were outside your race\'s jurisdiction.)*';
      }

      async function logValidationEvent(jurisdictionName, authorizedList, mentioned, unauthorized, action, originalText, finalText) {
        try {
          await env.DB.prepare(
            'INSERT INTO sam_validation_events (id, workspace_owner_id, user_id, jurisdiction_name, authorized_count, sam_mentioned_locations, unauthorized_locations, action_taken, original_response_excerpt, final_response_excerpt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
          ).bind(
            generateId(16), chatOwnerId || null, rateLimitUserId || null,
            jurisdictionName || 'unknown',
            (authorizedList || []).length,
            JSON.stringify(mentioned || []),
            JSON.stringify(unauthorized || []),
            action,
            (originalText || '').slice(0, 600),
            (finalText || '').slice(0, 600)
          ).run();
        } catch (e) {
          console.warn('[validator] log failed:', e.message);
        }
      }

      // ============================================================

      // Simple pass-through: one API call, return raw response.
      // Client handles tool execution and follow-up calls.
      const messages = (history && history.length > 0) ? [...history] : [{ role: "user", content: message }];
      const data = await callClaude(messages);

      // Validator authorized-list resolution. Two paths, in order:
      //   1) Candidate-profile cache lookup — works on EVERY turn,
      //      including follow-ups in multi-turn conversations where
      //      Sam doesn't re-call lookup_jurisdiction.
      //   2) Fallback: walk message history for an in-flight
      //      tool_result (covers same-turn cases where the candidate
      //      profile is incomplete or the tool was called with a
      //      jurisdiction_name that doesn't match `location`).
      // Federal districts / unsupported jurisdictions skip validation
      // (no list to validate against).
      let lookupResult = await lookupCachedJurisdictionForRace(specificOffice, state, location);
      if (!lookupResult) {
        lookupResult = findMostRecentJurisdictionLookup(messages);
      }
      const hasUsableList = lookupResult &&
        lookupResult.source !== 'unsupported' &&
        Array.isArray(lookupResult.incorporated_municipalities);

      if (hasUsableList) {
        const samText = extractTextFromContent(data.content);
        const authorized = [
          ...(lookupResult.incorporated_municipalities || []),
          ...(lookupResult.major_unincorporated_areas || [])
        ];
        const jurisdictionName = lookupResult.official_name || 'unknown';

        // Skip auditing trivially short responses (Sam's "Let me pull..."
        // text in Round 1 has no recommendations to validate).
        if (samText.length > 60 && authorized.length > 0) {
          const audit = await extractUnauthorizedPlaces(samText, authorized);
          if (audit.unauthorized && audit.unauthorized.length > 0) {
            // Option B: regenerate with feedback. One retry max.
            const retry = await regenerateWithFeedback(messages, data.content, audit.unauthorized, authorized);
            const retryText = extractTextFromContent(retry.content);
            const retryAudit = await extractUnauthorizedPlaces(retryText, authorized);

            if (retryAudit.unauthorized.length === 0) {
              await logValidationEvent(jurisdictionName, authorized, audit.mentioned, audit.unauthorized, 'regenerated', samText, retryText);
              return new Response(JSON.stringify(retry), {
                headers: { "Content-Type": "application/json", ...corsHeaders }
              });
            }

            // Option A fallback: strip the offending sentences.
            const stripped = stripUnauthorizedSentences(retryText, retryAudit.unauthorized);
            const strippedResponse = { ...retry, content: [{ type: 'text', text: stripped }] };
            await logValidationEvent(jurisdictionName, authorized, retryAudit.mentioned, retryAudit.unauthorized, 'stripped', samText, stripped);
            return new Response(JSON.stringify(strippedResponse), {
              headers: { "Content-Type": "application/json", ...corsHeaders }
            });
          }

          // Passed first check.
          await logValidationEvent(jurisdictionName, authorized, audit.mentioned, [], 'passed', samText, samText);
        }
      }

      return new Response(JSON.stringify(data), {
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });

    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }
  },
};
