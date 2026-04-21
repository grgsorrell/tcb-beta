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
    // HELPER: Log API usage to console and D1
    // ========================================
    async function logApiUsage(feature, data, userId) {
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
        await env.DB.prepare(
          'INSERT INTO api_usage (id, user_id, feature, input_tokens, output_tokens, estimated_cost, model) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).bind(generateId(16), userId || '', feature, inputTokens, outputTokens, cost, 'claude-haiku-4-5-20251001').run();
      } catch(e) { /* don't fail the request if logging fails */ }
    }

    // ========================================
    // HELPER: Research a single opponent
    // Federal races: FEC race roster (resolve candidate_id) → FEC finances →
    //   1 VPS news search → Haiku synthesis (~$0.005).
    //   Falls back to VPS-news-only if no FEC match found.
    // Non-federal: Haiku + web_search with max_uses: 3 (~$0.05–0.07)
    // ========================================
    async function researchOpponent(params, userId) {
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
          system: [{ type: "text", text: 'You are a political research analyst. Return ONLY valid JSON matching the shape requested — no preamble, no markdown fences. Use only the research data provided — FEC data is authoritative. Current year is ' + new Date().getFullYear() + '.' }],
          messages: [{ role: "user", content: userMsg }]
        };
      } else {
        featureTag = 'intel_opponent_anthropic';
        const userMsg = 'Research ' + name + ', an opponent of ' + (myCandidateName || 'my candidate') + ' (' + (myParty || 'unknown party') + ') running for ' + (office || 'unknown office') + ' in ' + (loc ? loc + ', ' : '') + (state || '') + ', ' + year + '. Perform at most 3 web searches. Focus on: (1) bio/background, (2) recent news/campaign activity, (3) campaign focus and issues. Do not do exhaustive research.\n\nReturn ONLY JSON in this exact shape:\n' + jsonShape + '\n\nScoring: nameRecognition (incumbent=9, prominent=6, unknown=3), momentum (recent news+fundraising=8+, quiet=3), directThreat (strong same-lane=high).';
        apiBody = {
          model: "claude-haiku-4-5-20251001",
          max_tokens: 3000,
          temperature: 0.2,
          system: [{ type: "text", text: 'You are a political research analyst. Perform at most 3 web searches. Focus only on bio/background, recent news, and campaign focus — do not do exhaustive research. Return ONLY valid JSON — no preamble, no markdown fences. Current year is ' + new Date().getFullYear() + '.' }],
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
      await logApiUsage(featureTag, apiData, userId);

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

      card.source = hasFederalData ? 'fec_vps' : 'anthropic';
      // Stash FEC data alongside the card so the frontend can show exact numbers.
      if (fecFinances) card.finances = fecFinances;
      if (fecMatch && fecMatch.candidate_id) card.fecCandidateId = fecMatch.candidate_id;
      return card;
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
        // Check username
        const existingUser = await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(username.toLowerCase()).first();
        if (existingUser) {
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
    // AUTH: Login (proper auth replacing beta)
    // ========================================
    if (url.pathname === '/api/auth/login' && request.method === 'POST') {
      try {
        const { username, password } = await request.json();
        if (!username || !password) return jsonResponse({ error: 'Username and password required' }, 400);
        const clean = username.toLowerCase().trim();
        // Find user by username or email
        const user = await env.DB.prepare('SELECT * FROM users WHERE username = ? OR email = ?').bind(clean, clean).first();
        if (!user || !user.password_hash) return jsonResponse({ error: 'Invalid credentials' }, 401);
        if (user.status === 'deleted') return jsonResponse({ error: 'Account has been deleted' }, 401);
        // Check password
        const encoder = new TextEncoder();
        const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(password + '_tcb_salt_2026'));
        const hashHex = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
        if (hashHex !== user.password_hash) {
          // Try sub-user login as fallback
          const sub = await env.DB.prepare('SELECT * FROM sub_users WHERE username = ? AND status = ?').bind(clean, 'active').first();
          if (sub && sub.password_hash === hashHex) {
            let subDbUser = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(clean + '@sub.tcb').first();
            if (!subDbUser) { const uid = generateId(); await env.DB.prepare('INSERT INTO users (id, email) VALUES (?, ?)').bind(uid, clean + '@sub.tcb').run(); subDbUser = { id: uid }; }
            const sid = generateId(48); const exp = new Date(Date.now() + 24*60*60*1000).toISOString();
            await env.DB.prepare('INSERT INTO sessions (session_id, user_id, expires_at) VALUES (?, ?, ?)').bind(sid, subDbUser.id, exp).run();
            await env.DB.prepare('UPDATE sub_users SET last_login = datetime(\'now\') WHERE id = ?').bind(sub.id).run();
            return jsonResponse({ success: true, sessionId: sid, userId: subDbUser.id, username: clean, isSubUser: true, name: sub.name, role: sub.role, permissions: JSON.parse(sub.permissions_json || '{}') });
          }
          return jsonResponse({ error: 'Invalid credentials' }, 401);
        }
        // BETA: Trial expiry not enforced. Activate when Stripe is live.
        // if (user.plan === 'trial' && user.trial_ends && new Date(user.trial_ends) < new Date()) {
        //   return jsonResponse({ error: 'trial_expired', trialEnds: user.trial_ends }, 403);
        // }
        // Create session
        const sessionId = generateId(48);
        const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
        await env.DB.prepare('INSERT INTO sessions (session_id, user_id, expires_at) VALUES (?, ?, ?)').bind(sessionId, user.id, expiresAt).run();
        // Calculate trial days remaining
        let trialDaysLeft = null;
        if (user.plan === 'trial' && user.trial_ends) {
          trialDaysLeft = Math.max(0, Math.ceil((new Date(user.trial_ends) - new Date()) / 86400000));
        }
        return jsonResponse({ success: true, sessionId, userId: user.id, username: user.username || clean, fullName: user.full_name, plan: user.plan, trialDaysLeft });
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
        const existing = await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(checkUser).first();
        const suggestions = [];
        if (existing) { for (let i = 2; i <= 4; i++) { const alt = checkUser + i; const e = await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(alt).first(); if (!e) suggestions.push(alt); } }
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
        return jsonResponse({ success: true, userId: user.id, username: user.username, fullName: user.full_name, plan: user.plan, trialDaysLeft });
      } catch (error) { return jsonResponse({ error: error.message }, 500); }
    }

    // ========================================
    // API: List campaigns for user
    // ========================================
    if (url.pathname === '/api/campaigns/list' && request.method === 'GET') {
      try {
        const userId = await getUserFromSession(request);
        if (!userId) return jsonResponse({ error: 'Not authenticated' }, 401);
        const result = await env.DB.prepare('SELECT * FROM campaigns WHERE owner_id = ? ORDER BY status ASC, updated_at DESC').bind(userId).all();
        return jsonResponse({ success: true, campaigns: result.results || [] });
      } catch (error) { return jsonResponse({ error: error.message }, 500); }
    }

    // ========================================
    // API: Create campaign
    // ========================================
    if (url.pathname === '/api/campaigns/create' && request.method === 'POST') {
      try {
        const userId = await getUserFromSession(request);
        if (!userId) return jsonResponse({ error: 'Not authenticated' }, 401);
        const body = await request.json();
        const campaignId = generateId();
        await env.DB.prepare(
          'INSERT INTO campaigns (id, owner_id, candidate_name, party, specific_office, office_level, location, state, election_date, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).bind(campaignId, userId, body.candidateName || '', body.party || '', body.specificOffice || '', body.officeLevel || '', body.location || '', body.state || '', body.electionDate || '', 'active').run();
        return jsonResponse({ success: true, campaignId });
      } catch (error) { return jsonResponse({ error: error.message }, 500); }
    }

    // ========================================
    // API: Switch active campaign
    // ========================================
    if (url.pathname === '/api/campaigns/switch' && request.method === 'POST') {
      try {
        const userId = await getUserFromSession(request);
        if (!userId) return jsonResponse({ error: 'Not authenticated' }, 401);
        const { campaignId } = await request.json();
        // Verify user owns this campaign
        const campaign = await env.DB.prepare('SELECT * FROM campaigns WHERE id = ? AND owner_id = ?').bind(campaignId, userId).first();
        if (!campaign) return jsonResponse({ error: 'Campaign not found' }, 404);
        // Update session
        const authHeader = request.headers.get('Authorization');
        const sessionId = authHeader ? authHeader.slice(7) : null;
        if (sessionId) await env.DB.prepare('UPDATE sessions SET campaign_id = ? WHERE session_id = ?').bind(campaignId, sessionId).run();
        return jsonResponse({ success: true, campaign });
      } catch (error) { return jsonResponse({ error: error.message }, 500); }
    }

    // ========================================
    // API: Archive/restore campaign
    // ========================================
    if (url.pathname === '/api/campaigns/archive' && request.method === 'POST') {
      try {
        const userId = await getUserFromSession(request);
        if (!userId) return jsonResponse({ error: 'Not authenticated' }, 401);
        const { campaignId, action } = await request.json();
        const newStatus = action === 'restore' ? 'active' : 'archived';
        await env.DB.prepare('UPDATE campaigns SET status = ? WHERE id = ? AND owner_id = ?').bind(newStatus, campaignId, userId).run();
        return jsonResponse({ success: true, status: newStatus });
      } catch (error) { return jsonResponse({ error: error.message }, 500); }
    }

    // ========================================
    // API: Create sub-user
    // ========================================
    if (url.pathname === '/api/users/create' && request.method === 'POST') {
      try {
        const userId = await getUserFromSession(request);
        if (!userId) return jsonResponse({ error: 'Not authenticated' }, 401);
        const { name, role, username, password, permissions } = await request.json();
        if (!name || !role || !username || !password) return jsonResponse({ error: 'All fields required' }, 400);
        // Check username available
        const existing = await env.DB.prepare('SELECT id FROM sub_users WHERE username = ?').bind(username).first();
        if (existing) return jsonResponse({ error: 'Username taken' }, 409);
        // Hash password (simple SHA-256 for beta — upgrade to bcrypt later)
        const encoder = new TextEncoder();
        const data = encoder.encode(password + '_tcb_salt_2026');
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
        const subUserId = generateId();
        await env.DB.prepare(
          'INSERT INTO sub_users (id, owner_id, username, password_hash, name, role, permissions_json, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        ).bind(subUserId, userId, username, hashHex, name, role, JSON.stringify(permissions || {}), 'active').run();
        // Log activity
        await env.DB.prepare('INSERT INTO activity_log (id, user_id, user_name, action, details) VALUES (?, ?, ?, ?, ?)').bind(generateId(16), userId, 'Owner', 'Created sub-user', name + ' (' + role + ')').run();
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
        const userId = await getUserFromSession(request);
        if (!userId) return jsonResponse({ error: 'Not authenticated' }, 401);
        const result = await env.DB.prepare('SELECT id, username, name, role, permissions_json, status, created_at, last_login FROM sub_users WHERE owner_id = ? ORDER BY created_at DESC').bind(userId).all();
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
    // API: Revoke sub-user
    // ========================================
    if (url.pathname === '/api/users/revoke' && request.method === 'POST') {
      try {
        const userId = await getUserFromSession(request);
        if (!userId) return jsonResponse({ error: 'Not authenticated' }, 401);
        const { subUserId } = await request.json();
        await env.DB.prepare('UPDATE sub_users SET status = ? WHERE id = ? AND owner_id = ?').bind('revoked', subUserId, userId).run();
        // Delete their sessions
        const sub = await env.DB.prepare('SELECT username FROM sub_users WHERE id = ?').bind(subUserId).first();
        if (sub) {
          const subUser = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(sub.username + '@sub.tcb').first();
          if (subUser) await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(subUser.id).run();
        }
        return jsonResponse({ success: true });
      } catch (error) {
        return jsonResponse({ error: error.message }, 500);
      }
    }

    // ========================================
    // API: Check username availability
    // ========================================
    if (url.pathname.startsWith('/api/users/check-username/') && request.method === 'GET') {
      try {
        const checkUsername = url.pathname.split('/').pop();
        const existing = await env.DB.prepare('SELECT id FROM sub_users WHERE username = ?').bind(checkUsername).first();
        const suggestions = [];
        if (existing) {
          for (let i = 2; i <= 4; i++) {
            const alt = checkUsername.replace(/\d*$/, '') + i;
            const altExists = await env.DB.prepare('SELECT id FROM sub_users WHERE username = ?').bind(alt).first();
            if (!altExists) suggestions.push(alt);
          }
        }
        return jsonResponse({ available: !existing, suggestions }, 200, corsHeaders);
      } catch (error) {
        return jsonResponse({ error: error.message }, 500);
      }
    }

    // ========================================
    // AUTH: Sub-user login
    // ========================================
    if (url.pathname === '/auth/subuser-login' && request.method === 'POST') {
      try {
        const { username, password } = await request.json();
        const sub = await env.DB.prepare('SELECT * FROM sub_users WHERE username = ? AND status = ?').bind(username, 'active').first();
        if (!sub) return jsonResponse({ error: 'Invalid credentials or account revoked' }, 401);
        // Hash and compare
        const encoder = new TextEncoder();
        const data = encoder.encode(password + '_tcb_salt_2026');
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
        if (hashHex !== sub.password_hash) return jsonResponse({ error: 'Invalid credentials' }, 401);
        // Create session user entry if needed
        let user = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(username + '@sub.tcb').first();
        if (!user) {
          const uid = generateId();
          await env.DB.prepare('INSERT INTO users (id, email) VALUES (?, ?)').bind(uid, username + '@sub.tcb').run();
          user = { id: uid };
        }
        // Create session
        const sessionId = generateId(48);
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
        await env.DB.prepare('INSERT INTO sessions (session_id, user_id, expires_at) VALUES (?, ?, ?)').bind(sessionId, user.id, expiresAt).run();
        // Update last login
        await env.DB.prepare('UPDATE sub_users SET last_login = datetime(\'now\') WHERE id = ?').bind(sub.id).run();
        return jsonResponse({
          success: true, sessionId, userId: user.id, username: sub.username,
          isSubUser: true, name: sub.name, role: sub.role,
          permissions: JSON.parse(sub.permissions_json || '{}'),
          mustChangePassword: sub.must_change_password === 1,
          ownerUsername: sub.owner_id
        });
      } catch (error) {
        return jsonResponse({ error: error.message }, 500);
      }
    }

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
        const userId = await getUserFromSession(request);
        if (!userId) return jsonResponse({ error: 'Not authenticated' }, 401);

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
          userId,
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
        const userId = await getUserFromSession(request);
        if (!userId) return jsonResponse({ error: 'Not authenticated' }, 401);

        const profile = await env.DB.prepare(
          'SELECT * FROM profiles WHERE user_id = ?'
        ).bind(userId).first();

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
    // ========================================
    if (url.pathname === '/api/tasks/sync' && request.method === 'POST') {
      try {
        const userId = await getUserFromSession(request);
        if (!userId) return jsonResponse({ error: 'Not authenticated' }, 401);

        const { tasks } = await request.json();

        // Delete existing tasks for this user
        await env.DB.prepare('DELETE FROM tasks WHERE user_id = ?').bind(userId).run();

        // Insert all current tasks
        if (tasks && tasks.length > 0) {
          const stmt = env.DB.prepare(
            'INSERT INTO tasks (id, user_id, name, date, category, completed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
          );
          const batch = tasks.map(t => stmt.bind(
            String(t.id),
            userId,
            t.name || t.text || '',
            t.date || null,
            t.category || 'other',
            t.completed ? 1 : 0,
            t.created_at || new Date().toISOString()
          ));
          await env.DB.batch(batch);
        }

        return jsonResponse({ success: true, count: tasks ? tasks.length : 0 });
      } catch (error) {
        return jsonResponse({ error: error.message }, 500);
      }
    }

    // ========================================
    // DATA API: Load Tasks
    // ========================================
    if (url.pathname === '/api/tasks/load' && request.method === 'GET') {
      try {
        const userId = await getUserFromSession(request);
        if (!userId) return jsonResponse({ error: 'Not authenticated' }, 401);

        const result = await env.DB.prepare(
          'SELECT * FROM tasks WHERE user_id = ? ORDER BY date ASC'
        ).bind(userId).all();

        // Convert D1 rows back to app format
        const tasks = (result.results || []).map(row => ({
          id: parseFloat(row.id) || row.id,
          name: row.name,
          text: row.name,
          date: row.date,
          category: row.category,
          completed: row.completed === 1,
          created_at: row.created_at
        }));

        return jsonResponse({ success: true, tasks });
      } catch (error) {
        return jsonResponse({ error: error.message }, 500);
      }
    }

    // ========================================
    // DATA API: Sync Events (full replace)
    // ========================================
    if (url.pathname === '/api/events/sync' && request.method === 'POST') {
      try {
        const userId = await getUserFromSession(request);
        if (!userId) return jsonResponse({ error: 'Not authenticated' }, 401);

        const { events } = await request.json();

        // Delete existing events for this user
        await env.DB.prepare('DELETE FROM events WHERE user_id = ?').bind(userId).run();

        // Insert all current events
        if (events && events.length > 0) {
          const stmt = env.DB.prepare(
            'INSERT INTO events (id, user_id, name, date, time, end_time, location, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
          );
          const batch = events.map(e => stmt.bind(
            String(e.id),
            userId,
            e.name || e.title || '',
            e.date || null,
            e.time || null,
            e.end_time || e.endTime || null,
            e.location || null,
            e.created_at || new Date().toISOString()
          ));
          await env.DB.batch(batch);
        }

        return jsonResponse({ success: true, count: events ? events.length : 0 });
      } catch (error) {
        return jsonResponse({ error: error.message }, 500);
      }
    }

    // ========================================
    // DATA API: Load Events
    // ========================================
    if (url.pathname === '/api/events/load' && request.method === 'GET') {
      try {
        const userId = await getUserFromSession(request);
        if (!userId) return jsonResponse({ error: 'Not authenticated' }, 401);

        const result = await env.DB.prepare(
          'SELECT * FROM events WHERE user_id = ? ORDER BY date ASC'
        ).bind(userId).all();

        const events = (result.results || []).map(row => ({
          id: parseFloat(row.id) || row.id,
          name: row.name,
          title: row.name,
          date: row.date,
          time: row.time,
          end_time: row.end_time,
          endTime: row.end_time,
          location: row.location,
          created_at: row.created_at
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
        const userId = await getUserFromSession(request);
        if (!userId) return jsonResponse({ error: 'Not authenticated' }, 401);

        const { budget } = await request.json();

        await env.DB.prepare(`
          INSERT INTO budget (user_id, total, categories, updated_at)
          VALUES (?, ?, ?, datetime('now'))
          ON CONFLICT(user_id) DO UPDATE SET
            total = excluded.total,
            categories = excluded.categories,
            updated_at = datetime('now')
        `).bind(
          userId,
          budget.total || 0,
          JSON.stringify(budget.categories || {})
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
        const userId = await getUserFromSession(request);
        if (!userId) return jsonResponse({ error: 'Not authenticated' }, 401);

        const row = await env.DB.prepare(
          'SELECT * FROM budget WHERE user_id = ?'
        ).bind(userId).first();

        if (!row) return jsonResponse({ success: true, budget: null });

        const budget = {
          total: row.total,
          categories: JSON.parse(row.categories || '{}'),
          updated_at: row.updated_at
        };

        return jsonResponse({ success: true, budget });
      } catch (error) {
        return jsonResponse({ error: error.message }, 500);
      }
    }

    // ========================================
    // DATA API: Sync Folders & Notes (full replace)
    // ========================================
    if (url.pathname === '/api/notes/sync' && request.method === 'POST') {
      try {
        const userId = await getUserFromSession(request);
        if (!userId) return jsonResponse({ error: 'Not authenticated' }, 401);

        const { folders } = await request.json();

        // Delete existing notes and folders for this user
        await env.DB.prepare('DELETE FROM notes WHERE user_id = ?').bind(userId).run();
        await env.DB.prepare('DELETE FROM folders WHERE user_id = ?').bind(userId).run();

        // Insert folders and their notes
        if (folders && folders.length > 0) {
          for (const folder of folders) {
            const folderId = String(folder.id || generateId(16));
            await env.DB.prepare(
              'INSERT INTO folders (id, user_id, name, created_at) VALUES (?, ?, ?, ?)'
            ).bind(folderId, userId, folder.name || '', folder.created_at || new Date().toISOString()).run();

            if (folder.notes && folder.notes.length > 0) {
              const stmt = env.DB.prepare(
                'INSERT INTO notes (id, folder_id, user_id, title, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
              );
              const batch = folder.notes.map(n => stmt.bind(
                String(n.id || generateId(16)),
                folderId,
                userId,
                n.title || '',
                n.content || '',
                n.created_at || new Date().toISOString(),
                n.updated_at || new Date().toISOString()
              ));
              await env.DB.batch(batch);
            }
          }
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
        const userId = await getUserFromSession(request);
        if (!userId) return jsonResponse({ error: 'Not authenticated' }, 401);

        const foldersResult = await env.DB.prepare(
          'SELECT * FROM folders WHERE user_id = ? ORDER BY created_at ASC'
        ).bind(userId).all();

        const notesResult = await env.DB.prepare(
          'SELECT * FROM notes WHERE user_id = ? ORDER BY created_at ASC'
        ).bind(userId).all();

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
        const userId = await getUserFromSession(request);
        if (!userId) return jsonResponse({ error: 'Not authenticated' }, 401);

        const { date, text } = await request.json();

        await env.DB.prepare(`
          INSERT INTO briefings (user_id, date, text)
          VALUES (?, ?, ?)
          ON CONFLICT(user_id, date) DO UPDATE SET
            text = excluded.text
        `).bind(userId, date, text).run();

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
        const userId = await getUserFromSession(request);
        if (!userId) return jsonResponse({ error: 'Not authenticated' }, 401);

        const row = await env.DB.prepare(
          'SELECT * FROM briefings WHERE user_id = ? ORDER BY date DESC LIMIT 1'
        ).bind(userId).first();

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
    // ========================================
    if (url.pathname === '/api/endorsements/sync' && request.method === 'POST') {
      try {
        const userId = await getUserFromSession(request);
        if (!userId) return jsonResponse({ error: 'Not authenticated' }, 401);
        const { endorsements } = await request.json();
        await env.DB.prepare('DELETE FROM endorsements WHERE user_id = ?').bind(userId).run();
        if (endorsements && endorsements.length > 0) {
          const stmt = env.DB.prepare(
            'INSERT INTO endorsements (id, user_id, name, title, status, notes, date, added_by_sam, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
          );
          const batch = endorsements.map(e => stmt.bind(
            String(e.id), userId, e.name || '', e.title || '', e.status || 'Pursuing',
            e.notes || '', e.date || null, e.addedBySam ? 1 : 0, e.created_at || new Date().toISOString()
          ));
          await env.DB.batch(batch);
        }
        return jsonResponse({ success: true, count: endorsements ? endorsements.length : 0 });
      } catch (error) {
        return jsonResponse({ error: error.message }, 500);
      }
    }

    // ========================================
    // DATA API: Load Endorsements
    // ========================================
    if (url.pathname === '/api/endorsements/load' && request.method === 'GET') {
      try {
        const userId = await getUserFromSession(request);
        if (!userId) return jsonResponse({ error: 'Not authenticated' }, 401);
        const result = await env.DB.prepare(
          'SELECT * FROM endorsements WHERE user_id = ? ORDER BY created_at DESC'
        ).bind(userId).all();
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
    // ========================================
    if (url.pathname === '/api/contributions/sync' && request.method === 'POST') {
      try {
        const userId = await getUserFromSession(request);
        if (!userId) return jsonResponse({ error: 'Not authenticated' }, 401);
        const { contributions } = await request.json();
        await env.DB.prepare('DELETE FROM contributions WHERE user_id = ?').bind(userId).run();
        if (contributions && contributions.length > 0) {
          const stmt = env.DB.prepare(
            'INSERT INTO contributions (id, user_id, donor_name, amount, source, date, employer, occupation, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
          );
          const batch = contributions.map(c => stmt.bind(
            String(c.id), userId, c.donorName || '', c.amount || 0, c.source || 'individual',
            c.date || null, c.employer || '', c.occupation || '', c.notes || '',
            c.created_at || new Date().toISOString()
          ));
          await env.DB.batch(batch);
        }
        return jsonResponse({ success: true, count: contributions ? contributions.length : 0 });
      } catch (error) {
        return jsonResponse({ error: error.message }, 500);
      }
    }

    // ========================================
    // DATA API: Load Contributions
    // ========================================
    if (url.pathname === '/api/contributions/load' && request.method === 'GET') {
      try {
        const userId = await getUserFromSession(request);
        if (!userId) return jsonResponse({ error: 'Not authenticated' }, 401);
        const result = await env.DB.prepare(
          'SELECT * FROM contributions WHERE user_id = ? ORDER BY date DESC'
        ).bind(userId).all();
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

    // ========================================
    // DATA API: Load All (bulk load on login)
    // ========================================
    if (url.pathname === '/api/data/load-all' && request.method === 'GET') {
      try {
        const userId = await getUserFromSession(request);
        if (!userId) return jsonResponse({ error: 'Not authenticated' }, 401);

        // Run all queries in parallel
        const [profileRow, tasksResult, eventsResult, budgetRow, foldersResult, notesResult, briefingRow, chatRow, endorseResult, contribResult] = await Promise.all([
          env.DB.prepare('SELECT * FROM profiles WHERE user_id = ?').bind(userId).first(),
          env.DB.prepare('SELECT * FROM tasks WHERE user_id = ? ORDER BY date ASC').bind(userId).all(),
          env.DB.prepare('SELECT * FROM events WHERE user_id = ? ORDER BY date ASC').bind(userId).all(),
          env.DB.prepare('SELECT * FROM budget WHERE user_id = ?').bind(userId).first(),
          env.DB.prepare('SELECT * FROM folders WHERE user_id = ? ORDER BY created_at ASC').bind(userId).all(),
          env.DB.prepare('SELECT * FROM notes WHERE user_id = ? ORDER BY created_at ASC').bind(userId).all(),
          env.DB.prepare('SELECT * FROM briefings WHERE user_id = ? ORDER BY date DESC LIMIT 1').bind(userId).first(),
          env.DB.prepare('SELECT messages FROM chat_history WHERE user_id = ?').bind(userId).first(),
          env.DB.prepare('SELECT * FROM endorsements WHERE user_id = ? ORDER BY created_at DESC').bind(userId).all().catch(() => ({ results: [] })),
          env.DB.prepare('SELECT * FROM contributions WHERE user_id = ? ORDER BY date DESC').bind(userId).all().catch(() => ({ results: [] }))
        ]);

        // Format profile
        let profile = profileRow || null;
        if (profile && profile.win_number_data) {
          try { profile.win_number_data = JSON.parse(profile.win_number_data); } catch (e) { /* leave as string */ }
        }

        // Format tasks
        const tasks = (tasksResult.results || []).map(row => ({
          id: parseFloat(row.id) || row.id,
          name: row.name,
          text: row.name,
          date: row.date,
          category: row.category,
          completed: row.completed === 1,
          created_at: row.created_at
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
          created_at: row.created_at
        }));

        // Format budget
        let budget = null;
        if (budgetRow) {
          budget = {
            total: budgetRow.total,
            categories: JSON.parse(budgetRow.categories || '{}'),
            updated_at: budgetRow.updated_at
          };
        }

        // Format folders with notes
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
          addedBySam: row.added_by_sam === 1, created_at: row.created_at
        }));

        // Format contributions
        const contributions = (contribResult.results || []).map(row => ({
          id: parseFloat(row.id) || row.id, donorName: row.donor_name, amount: row.amount,
          source: row.source, date: row.date, employer: row.employer,
          occupation: row.occupation, notes: row.notes, created_at: row.created_at
        }));

        return jsonResponse({ success: true, profile, tasks, events, budget, folders, briefing, chatHistory, endorsements, contributions });
      } catch (error) {
        return jsonResponse({ error: error.message }, 500);
      }
    }

    // ========================================
    // DATA API: Reset All User Data
    // ========================================
    if (url.pathname === '/api/data/reset' && request.method === 'POST') {
      try {
        const userId = await getUserFromSession(request);
        if (!userId) return jsonResponse({ error: 'Not authenticated' }, 401);

        await Promise.all([
          env.DB.prepare('DELETE FROM tasks WHERE user_id = ?').bind(userId).run(),
          env.DB.prepare('DELETE FROM events WHERE user_id = ?').bind(userId).run(),
          env.DB.prepare('DELETE FROM budget WHERE user_id = ?').bind(userId).run(),
          env.DB.prepare('DELETE FROM notes WHERE user_id = ?').bind(userId).run(),
          env.DB.prepare('DELETE FROM folders WHERE user_id = ?').bind(userId).run(),
          env.DB.prepare('DELETE FROM briefings WHERE user_id = ?').bind(userId).run(),
          env.DB.prepare('DELETE FROM chat_history WHERE user_id = ?').bind(userId).run(),
          env.DB.prepare('DELETE FROM profiles WHERE user_id = ?').bind(userId).run()
        ]);

        return jsonResponse({ success: true, message: 'All user data reset' });
      } catch (error) {
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
    // INTEL: List opponents
    // ========================================
    if (url.pathname === '/api/opponents/list' && request.method === 'GET') {
      try {
        const userId = await getUserFromSession(request);
        if (!userId) return jsonResponse({ error: 'Not authenticated' }, 401);
        const rows = await env.DB.prepare(
          'SELECT id, name, data, last_researched_at, created_at FROM opponents WHERE user_id = ? ORDER BY created_at ASC'
        ).bind(userId).all();
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
    // ========================================
    if (url.pathname === '/api/opponents/add' && request.method === 'POST') {
      try {
        const userId = await getUserFromSession(request);
        if (!userId) return jsonResponse({ error: 'Not authenticated' }, 401);
        const body = await request.json();
        const name = (body.name || '').trim();
        if (!name) return jsonResponse({ error: 'Name required' }, 400);

        const card = await researchOpponent({
          name,
          office: body.office || '',
          state: body.state || '',
          loc: body.location || '',
          year: body.year || new Date().getFullYear(),
          myCandidateName: body.myCandidateName || '',
          myParty: body.myParty || ''
        }, userId);

        const id = generateId(16);
        const now = new Date().toISOString();
        await env.DB.prepare(
          'INSERT INTO opponents (id, user_id, campaign_id, name, data, last_researched_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).bind(id, userId, body.campaignId || null, name, JSON.stringify(card), now, now).run();

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
        const userId = await getUserFromSession(request);
        if (!userId) return jsonResponse({ error: 'Not authenticated' }, 401);
        const body = await request.json();
        if (!body.id) return jsonResponse({ error: 'id required' }, 400);

        const row = await env.DB.prepare(
          'SELECT name, last_researched_at FROM opponents WHERE id = ? AND user_id = ?'
        ).bind(body.id, userId).first();
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
        }, userId);
        const now = new Date().toISOString();
        await env.DB.prepare(
          'UPDATE opponents SET data = ?, last_researched_at = ? WHERE id = ? AND user_id = ?'
        ).bind(JSON.stringify(card), now, body.id, userId).run();

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
        const userId = await getUserFromSession(request);
        if (!userId) return jsonResponse({ error: 'Not authenticated' }, 401);
        const { id } = await request.json();
        if (!id) return jsonResponse({ error: 'id required' }, 400);
        await env.DB.prepare('DELETE FROM opponents WHERE id = ? AND user_id = ?').bind(id, userId).run();
        return jsonResponse({ success: true });
      } catch (error) { return jsonResponse({ error: error.message }, 500); }
    }

    // ========================================
    // INTEL: Action Items (single Haiku call, no web search, ~$0.005)
    // ========================================
    if (url.pathname === '/api/intel/action-items' && request.method === 'POST') {
      try {
        const userId = await getUserFromSession(request);
        if (!userId) return jsonResponse({ error: 'Not authenticated' }, 401);
        const body = await request.json();

        const pulseItems = Array.isArray(body.pulse) ? body.pulse.slice(0, 8) : [];
        const oppItems = Array.isArray(body.opponents) ? body.opponents : [];
        const tasksList = Array.isArray(body.tasks) ? body.tasks.slice(0, 12) : [];
        const eventsList = Array.isArray(body.events) ? body.events.slice(0, 8) : [];

        const ctx =
          'Campaign context:\n' +
          '- Candidate: ' + (body.candidateName || 'unknown') + '\n' +
          '- Office: ' + (body.office || 'unknown') + '\n' +
          '- Phase: ' + (body.phase || 'unknown') + '\n' +
          '- Days to election: ' + (body.daysToElection != null ? body.daysToElection : 'unknown') + '\n' +
          '- District pulse (recent news): ' + (pulseItems.length ? '\n  • ' + pulseItems.map(p => (p.headline || '') + ' — ' + (p.summary || '')).join('\n  • ') : 'none') + '\n' +
          '- Opponents: ' + (oppItems.length ? oppItems.map(o => (o.name || '') + ' (threat ' + (o.threatLevel != null ? o.threatLevel : '?') + '/10, risk: ' + (o.keyRisk || '') + ')').join('; ') : 'none') + '\n' +
          '- Open tasks (' + tasksList.length + '): ' + (tasksList.length ? tasksList.map(t => t.name || t.text || '').filter(Boolean).join('; ') : 'none') + '\n' +
          '- Upcoming events: ' + (eventsList.length ? eventsList.map(e => (e.name || '') + ' (' + (e.date || '') + ')').join('; ') : 'none');

        const userMsg = ctx + '\n\nProduce 3-5 prioritized action items this candidate should do in the next 7 days. Prefer actions that respond to pulse items, counter specific opponents, or fit the campaign phase. Each item should be concrete and schedulable (a single task).\n\nReturn ONLY JSON:\n{"items":[{"action":"imperative action phrase, <12 words","why":"one sentence on why this matters right now","priority":"high|medium|low"}]}';

        const apiResp = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
          body: JSON.stringify({
            model: "claude-haiku-4-5-20251001",
            max_tokens: 1500,
            temperature: 0.3,
            system: [{ type: "text", text: "You are Sam, a political campaign strategist. Return ONLY valid JSON — no preamble, no markdown fences. Use only the provided context. Do not invent facts, opponents, or events not in the context." }],
            messages: [{ role: "user", content: userMsg }]
          })
        });
        const apiData = await apiResp.json();
        await logApiUsage('intel_action_items', apiData, userId);

        const textBlocks = [];
        if (apiData.content && Array.isArray(apiData.content)) {
          apiData.content.forEach(b => { if (b.type === 'text' && b.text) textBlocks.push(b.text); });
        }
        const lastBlock = textBlocks[textBlocks.length - 1] || '';
        const jsonStr = lastBlock.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
        let parsed = null;
        try { parsed = JSON.parse(jsonStr); } catch (e) {
          const matches = jsonStr.match(/\{[\s\S]*\}/g);
          if (matches) { try { parsed = JSON.parse(matches[matches.length - 1]); } catch (e2) {} }
        }

        return jsonResponse({ success: true, items: (parsed && parsed.items) || [] });
      } catch (error) {
        console.error('[Action Items] Error:', error.message);
        return jsonResponse({ error: error.message }, 500);
      }
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
        donorCount, intelContext, raceProfile
      } = body;

      // ========================================
      // RATE LIMITING: 100 messages per user per day
      // ========================================
      const rateLimitUserId = await getUserFromSession(request);
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
        // Detect feature for logging. Opponent research and action items have their
        // own endpoints (/api/opponents/*, /api/intel/action-items) — not routed here.
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
          await logApiUsage(researchFeature + '_vps', vpsData, rateLimitUserId);
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
        await logApiUsage(researchFeature + '_anthropic', researchData, rateLimitUserId);
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

      let systemPrompt = `You are Sam, a veteran political campaign manager with 20 years of experience. Direct, strategic, warm but no-nonsense. You speak in campaign language — earned media, persuadables, GOTV, burn rate, ground game, ballot position. You always have a strong opinion and a clear recommendation. When uncertain, say "let me verify that" — never "I don't know."

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
          description: "Save any content to the notes system — speeches, talking points, emails, press releases, scripts, plans, research. Choose folder based on content type: 'Speeches', 'Talking Points', 'Email Drafts', 'Press Releases', 'Campaign Plan', 'Voter Outreach', 'Fundraising Scripts', or create a new folder name.",
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
        await logApiUsage('sam_chat', data, rateLimitUserId);
        return data;
      }

      // Simple pass-through: one API call, return raw response
      // Client handles tool execution and follow-up calls
      const messages = (history && history.length > 0) ? [...history] : [{ role: "user", content: message }];
      const data = await callClaude(messages);

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
