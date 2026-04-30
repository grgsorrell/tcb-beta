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

    // Normalize a state input (full name or 2-letter code) to canonical
    // 2-letter postal code. Returns null when unknown.
    function normalizeStateCode(s) {
      const reverse = {
        'alabama':'AL','alaska':'AK','arizona':'AZ','arkansas':'AR','california':'CA',
        'colorado':'CO','connecticut':'CT','delaware':'DE','florida':'FL','georgia':'GA',
        'hawaii':'HI','idaho':'ID','illinois':'IL','indiana':'IN','iowa':'IA',
        'kansas':'KS','kentucky':'KY','louisiana':'LA','maine':'ME','maryland':'MD',
        'massachusetts':'MA','michigan':'MI','minnesota':'MN','mississippi':'MS',
        'missouri':'MO','montana':'MT','nebraska':'NE','nevada':'NV','new hampshire':'NH',
        'new jersey':'NJ','new mexico':'NM','new york':'NY','north carolina':'NC',
        'north dakota':'ND','ohio':'OH','oklahoma':'OK','oregon':'OR','pennsylvania':'PA',
        'rhode island':'RI','south carolina':'SC','south dakota':'SD','tennessee':'TN',
        'texas':'TX','utah':'UT','vermont':'VT','virginia':'VA','washington':'WA',
        'west virginia':'WV','wisconsin':'WI','wyoming':'WY','district of columbia':'DC'
      };
      const t = (s || '').trim();
      if (!t) return null;
      if (t.length === 2 && /^[A-Za-z]{2}$/.test(t)) return t.toUpperCase();
      const code = reverse[t.toLowerCase()];
      return code || null;
    }

    // ========================================
    // ENTITY MASKING (Phase 1 anti-hallucination)
    //
    // Replaces real-world entity names (candidate, opponents, endorsers,
    // donors) with placeholder tokens before any Anthropic API call.
    // The model never sees real names → can't pull training-data facts
    // about a real public figure who happens to share a candidate's
    // name (the Stephanie Murphy bug class). See CP_ENTITY_MASK.sql.
    // ========================================
    function levenshtein(a, b, maxDist) {
      if (a === b) return 0;
      if (Math.abs(a.length - b.length) > maxDist) return maxDist + 1;
      const m = a.length, n = b.length;
      let prev = new Array(n + 1);
      let curr = new Array(n + 1);
      for (let j = 0; j <= n; j++) prev[j] = j;
      for (let i = 1; i <= m; i++) {
        curr[0] = i;
        let rowMin = curr[0];
        for (let j = 1; j <= n; j++) {
          const cost = a[i - 1] === b[j - 1] ? 0 : 1;
          curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
          if (curr[j] < rowMin) rowMin = curr[j];
        }
        if (rowMin > maxDist) return maxDist + 1;
        const tmp = prev; prev = curr; curr = tmp;
      }
      return prev[n];
    }

    function escapeForRegex(s) {
      return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    async function getOrCreateMask(workspaceOwnerId, entityType, realName) {
      if (!workspaceOwnerId || !entityType || !realName) return null;
      const cleanName = String(realName).trim();
      if (!cleanName) return null;
      try {
        const existing = await env.DB.prepare(
          'SELECT placeholder FROM entity_mask WHERE workspace_owner_id = ? AND entity_type = ? AND real_name = ?'
        ).bind(workspaceOwnerId, entityType, cleanName).first();
        if (existing) return existing.placeholder;
        let placeholder;
        if (entityType === 'CANDIDATE')            placeholder = '{{CANDIDATE}}';
        else if (entityType === 'CANDIDATE_FIRST') placeholder = '{{CANDIDATE_FIRST}}';
        else if (entityType === 'CANDIDATE_LAST')  placeholder = '{{CANDIDATE_LAST}}';
        else {
          const countRow = await env.DB.prepare(
            'SELECT COUNT(*) AS n FROM entity_mask WHERE workspace_owner_id = ? AND entity_type = ?'
          ).bind(workspaceOwnerId, entityType).first();
          const n = ((countRow && countRow.n) || 0) + 1;
          placeholder = '{{' + entityType + '_' + n + '}}';
        }
        await env.DB.prepare(
          'INSERT OR IGNORE INTO entity_mask (id, workspace_owner_id, entity_type, real_name, placeholder) VALUES (?, ?, ?, ?, ?)'
        ).bind(generateId(16), workspaceOwnerId, entityType, cleanName, placeholder).run();
        // Re-read in case of race (another concurrent insert won the
        // unique constraint and we got a different placeholder).
        const row = await env.DB.prepare(
          'SELECT placeholder FROM entity_mask WHERE workspace_owner_id = ? AND entity_type = ? AND real_name = ?'
        ).bind(workspaceOwnerId, entityType, cleanName).first();
        return row ? row.placeholder : placeholder;
      } catch (e) {
        console.warn('[entity_mask] getOrCreateMask failed:', e.message);
        return null;
      }
    }

    async function getAllWorkspaceEntities(workspaceOwnerId) {
      if (!workspaceOwnerId) return [];
      try {
        const r = await env.DB.prepare(
          'SELECT entity_type, real_name, placeholder FROM entity_mask WHERE workspace_owner_id = ? ORDER BY length(real_name) DESC'
        ).bind(workspaceOwnerId).all();
        return (r && r.results) ? r.results : [];
      } catch (e) {
        console.warn('[entity_mask] getAllWorkspaceEntities failed:', e.message);
        return [];
      }
    }

    function maskText(text, entities, opts) {
      if (!text || typeof text !== 'string' || !Array.isArray(entities) || entities.length === 0) return text || '';
      const skipQuoteProtection = !!(opts && opts.skipQuoteProtection);
      // Mask out long quoted spans first (don't process inside).
      // Only for user-typed text where pasted documents are the concern.
      // System prompts are server-built and have many short quoted phrases
      // ("I don't know", "(verify on website)", etc.) that the regex
      // would chain together into giant gobbling matches — turning the
      // entire prompt into one big QSPAN. Prompt assembly uses
      // skipQuoteProtection: true.
      const quotes = [];
      let work = skipQuoteProtection
        ? text
        : text.replace(/"[^"]{50,}"/g, (m) => {
            const idx = quotes.length; quotes.push(m);
            return '\u0001QSPAN' + idx + '\u0001';
          });
      // Pass 1: longest real_name first (already sorted by caller), exact case-insensitive word-bounded.
      const sorted = entities.slice().sort((a, b) => (b.real_name || '').length - (a.real_name || '').length);
      for (const e of sorted) {
        if (!e.real_name || !e.placeholder) continue;
        const pat = new RegExp('\\b' + escapeForRegex(e.real_name) + '\\b', 'gi');
        work = work.replace(pat, e.placeholder);
      }
      // Pass 2: fuzzy match on capitalized 4+-char tokens. Catches
      // misspellings ("Stephany" → {{CANDIDATE_FIRST}}). Multi-word
      // entities are excluded from fuzzy match — too easy to over-fire.
      work = work.replace(/\b([A-Z][a-zA-Z]{3,})\b/g, (token) => {
        if (token.startsWith('{{') || /^QSPAN\d+$/.test(token)) return token;
        const lc = token.toLowerCase();
        for (const e of sorted) {
          if (!e.real_name || !e.placeholder) continue;
          const realLc = e.real_name.toLowerCase();
          if (realLc.includes(' ')) continue;
          if (Math.abs(realLc.length - lc.length) > 2) continue;
          if (lc === realLc) continue;
          if (levenshtein(lc, realLc, 2) <= 2) return e.placeholder;
        }
        return token;
      });
      for (let i = 0; i < quotes.length; i++) {
        work = work.replace('\u0001QSPAN' + i + '\u0001', quotes[i]);
      }
      return work;
    }

    function demaskText(text, entities) {
      if (!text || typeof text !== 'string' || !Array.isArray(entities) || entities.length === 0) return text || '';
      // Sort by placeholder length DESC so {{OPPONENT_10}} replaces
      // before {{OPPONENT_1}} (otherwise the substring "{{OPPONENT_1"
      // inside "{{OPPONENT_10}}" gets clobbered).
      const sorted = entities.slice().sort((a, b) => (b.placeholder || '').length - (a.placeholder || '').length);
      let work = text;
      for (const e of sorted) {
        if (!e.placeholder || !e.real_name) continue;
        if (work.indexOf(e.placeholder) >= 0) work = work.split(e.placeholder).join(e.real_name);
      }
      return work;
    }

    function maskMessagesArray(messages, entities) {
      if (!Array.isArray(messages)) return messages;
      return messages.map(m => {
        if (!m) return m;
        if (typeof m.content === 'string') {
          return Object.assign({}, m, { content: maskText(m.content, entities) });
        }
        if (Array.isArray(m.content)) {
          const newContent = m.content.map(blk => {
            if (!blk || typeof blk !== 'object') return blk;
            if (blk.type === 'text' && typeof blk.text === 'string') {
              return Object.assign({}, blk, { text: maskText(blk.text, entities) });
            }
            if (blk.type === 'tool_result' && typeof blk.content === 'string') {
              return Object.assign({}, blk, { content: maskText(blk.content, entities) });
            }
            return blk;
          });
          return Object.assign({}, m, { content: newContent });
        }
        return m;
      });
    }

    // ========================================
    // SAFE MODE — validator firing counter (Phase 3)
    //
    // Counts regenerated + stripped events across all 5 per-fact-class
    // validator tables for a given conversation_id. When the total
    // crosses the threshold (3+), Safe Mode activates for subsequent
    // turns in this conversation: stricter deferral prompt + visible
    // banner above Sam's responses. Cumulative count, session-only
    // (new conversation_id = fresh count).
    //
    // Returns { total, breakdown } so the activation log can record
    // which fact classes contributed.
    // ========================================
    async function getValidatorFiringBreakdown(conversationId) {
      if (!conversationId) return { total: 0, breakdown: {} };
      const tables = [
        { key: 'geographic',   table: 'sam_validation_events' },
        { key: 'compliance_a', table: 'sam_compliance_validation_events' },
        { key: 'compliance_b', table: 'sam_finance_validation_events' },
        { key: 'donation',     table: 'sam_donation_validation_events' },
        { key: 'opponent',     table: 'sam_opponent_validation_events' },
        { key: 'citation',     table: 'sam_citation_validation_events' }
      ];
      const breakdown = {};
      let total = 0;
      for (const t of tables) {
        try {
          const r = await env.DB.prepare(
            `SELECT COUNT(*) AS n FROM ${t.table} WHERE conversation_id = ? AND action_taken IN ('regenerated', 'stripped')`
          ).bind(conversationId).first();
          const n = (r && typeof r.n === 'number') ? r.n : 0;
          breakdown[t.key] = n;
          total += n;
        } catch (e) {
          breakdown[t.key] = 0;
        }
      }
      return { total, breakdown };
    }

    // ========================================
    // OPPONENT-RESEARCH QUERY DETECTOR (Phase 1.5)
    //
    // Scans a string for signals that it's a query about a specific
    // opponent's biographical / fundraising / strategic information.
    // When detected, the chat handler omits web_search from this
    // turn's tools[] so Sam can't reconstruct the masked entity by
    // searching for race-identifying context.
    //
    // Conservative — only fires when there's a clear opponent signal.
    // Generic political research (jurisdiction analysis, compliance
    // dates, election turnout) passes through unblocked.
    // ========================================
    function isOpponentResearchQuery(query, workspaceEntities) {
      if (!query || typeof query !== 'string') return false;
      const lc = query.toLowerCase();
      // 1. Direct opponent name or placeholder.
      const opponents = (workspaceEntities || []).filter(e => e.entity_type === 'OPPONENT');
      for (const o of opponents) {
        if (o.real_name && lc.includes(o.real_name.toLowerCase())) return true;
        if (o.placeholder && lc.includes(o.placeholder.toLowerCase())) return true;
      }
      // 2. Explicit opponent phrases.
      const explicitOpponentSignals = [
        "my opponent", "the opponent", "opponent's", "opponents'",
        "opponent ", " opponent",
        "running against", "running opposite",
        "challenger ", "incumbent's "
      ];
      for (const p of explicitOpponentSignals) {
        if (lc.includes(p)) return true;
      }
      // 3. Biographical / fundraising / strategic query phrases.
      // These imply person-targeting research even without an explicit
      // "opponent" word. NOTE: do not include "campaign finance report"
      // here — it's ambiguous (could be the candidate's own compliance
      // filing). Opponent fundraising research will trip on more
      // specific phrases like "fundraising history" or "donor list".
      const bioQueryPhrases = [
        "fundraising history", "donor list", "donor base",
        "war chest", "voting record",
        "previous campaigns", "prior office", "prior elections",
        "polling against", "head to head", "head-to-head",
        "background check"
      ];
      for (const p of bioQueryPhrases) {
        if (lc.includes(p)) return true;
      }
      return false;
    }

    function demaskContentArray(content, entities) {
      if (!Array.isArray(content)) return content;
      return content.map(blk => {
        if (!blk || typeof blk !== 'object') return blk;
        if (blk.type === 'text' && typeof blk.text === 'string') {
          return Object.assign({}, blk, { text: demaskText(blk.text, entities) });
        }
        return blk;
      });
    }

    // One-time-per-turn backfill: pulls all entity names from the
    // candidate's profile, intel opponents, endorsements, and donors,
    // and ensures each has a row in entity_mask. Idempotent — every
    // call is INSERT OR IGNORE.
    async function backfillEntityMask(workspaceOwnerId, body) {
      if (!workspaceOwnerId) return;
      try {
        // Candidate (full + first + last when name has a space).
        if (body.candidateName) {
          await getOrCreateMask(workspaceOwnerId, 'CANDIDATE', body.candidateName);
          const parts = String(body.candidateName).trim().split(/\s+/).filter(Boolean);
          if (parts.length >= 2) {
            await getOrCreateMask(workspaceOwnerId, 'CANDIDATE_FIRST', parts[0]);
            await getOrCreateMask(workspaceOwnerId, 'CANDIDATE_LAST', parts[parts.length - 1]);
          } else if (parts.length === 1) {
            await getOrCreateMask(workspaceOwnerId, 'CANDIDATE_FIRST', parts[0]);
          }
        }
        // Opponents (from intelContext.opponents in body).
        if (body.intelContext && Array.isArray(body.intelContext.opponents)) {
          for (const opp of body.intelContext.opponents) {
            if (opp && opp.name) await getOrCreateMask(workspaceOwnerId, 'OPPONENT', opp.name);
          }
        }
        // Endorsers from D1 (status check defensive — null/missing
        // status counts as active; only 'declined' is excluded).
        try {
          const endorsers = await env.DB.prepare(
            "SELECT name FROM endorsements WHERE workspace_owner_id = ? AND (status IS NULL OR LOWER(status) != 'declined') ORDER BY created_at ASC"
          ).bind(workspaceOwnerId).all();
          if (endorsers && endorsers.results) {
            for (const e of endorsers.results) {
              if (e.name) await getOrCreateMask(workspaceOwnerId, 'ENDORSER', e.name);
            }
          }
        } catch (_) {}
        // Donors from D1, $200+ threshold (FEC-reportable; also the
        // class of names most likely to appear in coaching context).
        try {
          const donors = await env.DB.prepare(
            "SELECT donor_name FROM contributions WHERE workspace_owner_id = ? AND amount >= 200 ORDER BY created_at ASC"
          ).bind(workspaceOwnerId).all();
          if (donors && donors.results) {
            for (const d of donors.results) {
              if (d.donor_name) await getOrCreateMask(workspaceOwnerId, 'DONOR', d.donor_name);
            }
          }
        } catch (_) {}
      } catch (e) {
        console.warn('[entity_mask] backfill failed:', e.message);
      }
    }

    // Look up authority contact for a race. Falls back through:
    //   1. State-level row for the candidate's state
    //   2. default_unknown row
    //   3. Hardcoded last-resort placeholder (no DB row found)
    //
    // jurisdiction_specific is a soft hint to direct the candidate to
    // their county/city elections office; this checkpoint doesn't have
    // county-level data so the message is generic.
    async function fetchAuthorityForRace(stateCode, jurisdictionName) {
      let row = null;
      if (stateCode) {
        row = await env.DB.prepare(
          "SELECT authority_name, authority_phone, authority_url, notes " +
          "FROM compliance_authorities " +
          "WHERE state_code = ? AND jurisdiction_type = 'state' LIMIT 1"
        ).bind(stateCode).first();
      }
      if (!row) {
        row = await env.DB.prepare(
          "SELECT authority_name, authority_phone, authority_url, notes " +
          "FROM compliance_authorities " +
          "WHERE jurisdiction_type = 'default_unknown' LIMIT 1"
        ).first();
      }
      const fallback = {
        name: 'state elections office',
        phone: '(search "<state> secretary of state elections" online for current contact info)',
        url: null,
        notes: 'No verified contact data — search the state government website for the elections division.'
      };
      const authority = row ? {
        name: row.authority_name,
        phone: row.authority_phone,
        url: row.authority_url,
        notes: row.notes
      } : fallback;
      authority.jurisdiction_specific = jurisdictionName
        ? `For ${jurisdictionName} races, also contact the local (county/city) elections office — local races are typically administered locally even when state-level rules apply.`
        : null;
      return authority;
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

        // Sam v2 Phase 1: candidate_site_url + candidate_bio_text + early_voting_start_date
        // are upserted alongside core profile fields. candidate_site_content and
        // candidate_site_fetched_at are NEVER written from /api/profile/save —
        // they're owned by /api/profile/site/fetch which does the actual web fetch.
        // (If the caller passes them, we ignore — preserves existing fetched content.)
        await env.DB.prepare(`
          INSERT INTO profiles (user_id, candidate_name, specific_office, office_level, party, location, state, election_date, filing_status, win_number, win_number_data, onboarding_complete, candidate_site_url, candidate_bio_text, early_voting_start_date, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
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
            candidate_site_url = excluded.candidate_site_url,
            candidate_bio_text = excluded.candidate_bio_text,
            early_voting_start_date = excluded.early_voting_start_date,
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
          data.onboarding_complete ? 1 : 0,
          data.candidate_site_url || null,
          data.candidate_bio_text ? String(data.candidate_bio_text).slice(0, 1000) : null,
          data.early_voting_start_date || null
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
    // PROFILE: Fetch candidate's campaign website (Sam v2 Phase 1)
    // Server-side fetch (avoids client-side CORS), strips HTML to text,
    // caps at 10,000 chars, stores in candidate_site_content.
    // Triggered by onboarding website page or settings refresh button.
    // ========================================
    if (url.pathname === '/api/profile/site/fetch' && request.method === 'POST') {
      try {
        const ctx = await getSessionContext(request);
        if (!ctx) return jsonResponse({ error: 'Not authenticated' }, 401);
        if (ctx.revoked) return denyRevoked();
        if (ctx.isSubUser) return denyOwnerOnly();
        const body = await request.json();
        let siteUrl = String(body.url || '').trim();
        if (!siteUrl) return jsonResponse({ error: 'url required' }, 400);
        if (!/^https?:\/\//i.test(siteUrl)) siteUrl = 'https://' + siteUrl;
        try { new URL(siteUrl); } catch (e) { return jsonResponse({ error: 'invalid_url' }, 400); }

        // Fetch with a friendly UA. Cloudflare workers' fetch follows redirects by default.
        let html = '';
        let fetchError = null;
        try {
          const resp = await fetch(siteUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TCB-CandidateBot/1.0)' },
            redirect: 'follow'
          });
          if (!resp.ok) {
            fetchError = 'http_' + resp.status;
          } else {
            html = await resp.text();
          }
        } catch (e) {
          fetchError = 'fetch_failed: ' + (e.message || 'unknown');
        }

        if (fetchError) {
          // Persist URL even on fetch failure so user can retry/refresh
          const nowErr = new Date().toISOString().replace('T', ' ').slice(0, 19);
          await env.DB.prepare('INSERT OR IGNORE INTO profiles (user_id) VALUES (?)').bind(ctx.ownerId).run();
          await env.DB.prepare(
            'UPDATE profiles SET candidate_site_url = ?, candidate_site_fetched_at = ? WHERE user_id = ?'
          ).bind(siteUrl, nowErr, ctx.ownerId).run();
          return jsonResponse({ success: false, error: fetchError, url: siteUrl }, 200);
        }

        // Strip <script>/<style> blocks first (their contents shouldn't appear in text),
        // then strip remaining tags. Collapse whitespace.
        let text = html
          .replace(/<script[\s\S]*?<\/script>/gi, ' ')
          .replace(/<style[\s\S]*?<\/style>/gi, ' ')
          .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
          .replace(/<!--[\s\S]*?-->/g, ' ')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;/g, ' ')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .replace(/\s+/g, ' ')
          .trim();
        const truncated = text.length > 10000;
        if (truncated) text = text.slice(0, 10000) + '\n\n[Site truncated for length, refresh available in settings]';

        const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
        // Ensure profile row exists before UPDATE (covers the edge case where
        // a brand-new user hits site/fetch before completing onboarding's
        // profile save).
        await env.DB.prepare('INSERT OR IGNORE INTO profiles (user_id) VALUES (?)').bind(ctx.ownerId).run();
        await env.DB.prepare(
          'UPDATE profiles SET candidate_site_url = ?, candidate_site_content = ?, candidate_site_fetched_at = ? WHERE user_id = ?'
        ).bind(siteUrl, text, now, ctx.ownerId).run();

        return jsonResponse({
          success: true,
          url: siteUrl,
          content_length: text.length,
          truncated: truncated,
          fetched_at: now,
          preview: text.slice(0, 240)
        });
      } catch (error) {
        return jsonResponse({ error: error.message }, 500);
      }
    }

    // ========================================
    // PROFILE: Refresh candidate site (manual re-fetch from settings)
    // Re-uses the stored candidate_site_url; same fetch+strip pipeline.
    // ========================================
    if (url.pathname === '/api/profile/site/refresh' && request.method === 'POST') {
      try {
        const ctx = await getSessionContext(request);
        if (!ctx) return jsonResponse({ error: 'Not authenticated' }, 401);
        if (ctx.revoked) return denyRevoked();
        if (ctx.isSubUser) return denyOwnerOnly();
        const row = await env.DB.prepare(
          'SELECT candidate_site_url FROM profiles WHERE user_id = ?'
        ).bind(ctx.ownerId).first();
        if (!row || !row.candidate_site_url) {
          return jsonResponse({ success: false, error: 'no_url_on_file' }, 400);
        }
        // Delegate by re-invoking the same logic (POST to /site/fetch internally
        // would require constructing a Request — easier to inline duplicate the
        // fetch path. Keeping it DRY by extracting the helper would be nice; for
        // now the duplication is small).
        let html = '';
        let fetchError = null;
        try {
          const resp = await fetch(row.candidate_site_url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TCB-CandidateBot/1.0)' },
            redirect: 'follow'
          });
          if (!resp.ok) fetchError = 'http_' + resp.status;
          else html = await resp.text();
        } catch (e) { fetchError = 'fetch_failed: ' + (e.message || 'unknown'); }
        if (fetchError) return jsonResponse({ success: false, error: fetchError }, 200);
        let text = html
          .replace(/<script[\s\S]*?<\/script>/gi, ' ')
          .replace(/<style[\s\S]*?<\/style>/gi, ' ')
          .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
          .replace(/<!--[\s\S]*?-->/g, ' ')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
          .replace(/\s+/g, ' ').trim();
        const truncated = text.length > 10000;
        if (truncated) text = text.slice(0, 10000) + '\n\n[Site truncated for length, refresh available in settings]';
        const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
        await env.DB.prepare(
          'UPDATE profiles SET candidate_site_content = ?, candidate_site_fetched_at = ? WHERE user_id = ?'
        ).bind(text, now, ctx.ownerId).run();
        return jsonResponse({ success: true, fetched_at: now, content_length: text.length, truncated: truncated });
      } catch (error) { return jsonResponse({ error: error.message }, 500); }
    }

    // ========================================
    // PROFILE: Save fallback bio text (when no URL provided)
    // ========================================
    if (url.pathname === '/api/profile/bio/save' && request.method === 'POST') {
      try {
        const ctx = await getSessionContext(request);
        if (!ctx) return jsonResponse({ error: 'Not authenticated' }, 401);
        if (ctx.revoked) return denyRevoked();
        if (ctx.isSubUser) return denyOwnerOnly();
        const body = await request.json();
        const bio = body.bio_text == null ? '' : String(body.bio_text).slice(0, 1000);
        await env.DB.prepare('INSERT OR IGNORE INTO profiles (user_id) VALUES (?)').bind(ctx.ownerId).run();
        await env.DB.prepare(
          'UPDATE profiles SET candidate_bio_text = ? WHERE user_id = ?'
        ).bind(bio || null, ctx.ownerId).run();
        return jsonResponse({ success: true });
      } catch (error) { return jsonResponse({ error: error.message }, 500); }
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
          const cachedResp = {
            jurisdiction_type: cached.jurisdiction_type,
            official_name: cached.official_name,
            incorporated_municipalities: JSON.parse(cached.incorporated_municipalities || '[]'),
            major_unincorporated_areas: JSON.parse(cached.major_unincorporated_areas || '[]'),
            source: cached.source,
            last_updated: cached.last_updated,
            cached: true
          };
          // Retrofit: cached 'unsupported' rows predate the authority field;
          // enrich them at read time so Sam always has a contact to defer to.
          if (cachedResp.source === 'unsupported') {
            const stateCodeForAuth = normalizeStateCode(state);
            cachedResp.authority = await fetchAuthorityForRace(stateCodeForAuth, jurisdictionName);
          }
          return jsonResponse(cachedResp);
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
          //
          // Retrofit (compliance checkpoint): include authority contact
          // info so Sam can defer concretely instead of vaguely. Same
          // deferral-as-feature principle as lookup_compliance_deadlines.
          const stateCodeForAuth = normalizeStateCode(state);
          const authority = await fetchAuthorityForRace(stateCodeForAuth, jurisdictionName);
          result = {
            jurisdiction_type: type,
            official_name: jurisdictionName,
            incorporated_municipalities: [],
            major_unincorporated_areas: [],
            source: 'unsupported',
            last_updated: new Date().toISOString().split('T')[0],
            authority: authority,
            note: 'District-level lookup not implemented yet. Sam should defer to the authority contact above instead of inventing geographic data.'
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
    // DATA API: lookup_compliance_deadlines
    //
    // Backs the lookup_compliance_deadlines Sam tool — verified filing
    // and qualifying deadline data for the candidate's race. Same
    // architecture as lookup_jurisdiction:
    //   1. Cache check (90-day TTL on stable deadline data)
    //   2. Source cascade: Ballotpedia → state SOS → unsupported
    //   3. Authority contact ALWAYS returned (deferral-as-feature)
    //   4. Cache the result
    //
    // This checkpoint stubs the Ballotpedia and SOS paths — every
    // lookup falls through to status='unsupported' with authority data
    // from compliance_authorities. The architecture is in place; real
    // source integration is future work.
    //
    // Authority data is itself stub-only this checkpoint. Phone numbers
    // are placeholders ("(verify on state government website)") so Sam
    // never reads fake digits to a user.
    // ========================================
    if (url.pathname === '/api/compliance/lookup' && request.method === 'POST') {
      try {
        const ctx = await getSessionContext(request);
        if (!ctx) return jsonResponse({ error: 'Not authenticated' }, 401);
        if (ctx.revoked) return denyRevoked();
        const body = await request.json().catch(() => ({}));

        const stateRaw = (body.state || '').trim();
        const office = (body.office || '').trim();
        const raceYear = parseInt(body.race_year, 10);
        const jurisdictionName = (body.jurisdiction_name || '').trim() || null;

        if (!stateRaw || !office || !Number.isFinite(raceYear)) {
          return jsonResponse({ error: 'state, office, race_year required' }, 400);
        }

        const stateCode = normalizeStateCode(stateRaw);
        const officeNormalized = office.toLowerCase().trim();

        // Cache check (state_code may be null for unknown states; that
        // still keys uniquely with the office + year). We treat NULL
        // jurisdiction_name as an empty string for index lookup.
        const cacheJurKey = jurisdictionName || '';
        const cached = await env.DB.prepare(
          "SELECT * FROM compliance_deadlines_cache " +
          "WHERE state_code = ? AND office_normalized = ? AND race_year = ? AND COALESCE(jurisdiction_name,'') = ? " +
          "AND created_at > datetime('now', '-90 days') LIMIT 1"
        ).bind(stateCode || '', officeNormalized, raceYear, cacheJurKey).first();

        if (cached) {
          return jsonResponse(formatComplianceCacheRow(cached, true));
        }

        // Source cascade — Ballotpedia and SOS scrapers are future work.
        // All paths currently fall through to authority-only stub.
        let result = null;
        // result = await tryBallotpedia(stateCode, office, raceYear, jurisdictionName);
        // if (!result) result = await trySosScrape(stateCode, office, raceYear, jurisdictionName);

        if (!result) {
          const authority = await fetchAuthorityForRace(stateCode, jurisdictionName);
          result = {
            status: 'unsupported',
            deadlines: {
              qualifying_period_start: null,
              qualifying_period_end: null,
              qualifying_period_end_time: null,
              petition_deadline: null,
              filing_fee: null
            },
            authority: authority,
            source: 'stub_authority_only',
            last_updated: new Date().toISOString()
          };
        }

        // Persist to cache (UPSERT on the unique index).
        await env.DB.prepare(
          'INSERT INTO compliance_deadlines_cache (id, state_code, office_normalized, race_year, jurisdiction_name, status, qualifying_period_start, qualifying_period_end, qualifying_period_end_time, petition_deadline, filing_fee, authority_name, authority_phone, authority_url, authority_notes, authority_jurisdiction_specific, source, last_updated) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
          'ON CONFLICT(state_code, office_normalized, race_year, jurisdiction_name) DO UPDATE SET ' +
          '  status = excluded.status, ' +
          '  qualifying_period_start = excluded.qualifying_period_start, ' +
          '  qualifying_period_end = excluded.qualifying_period_end, ' +
          '  qualifying_period_end_time = excluded.qualifying_period_end_time, ' +
          '  petition_deadline = excluded.petition_deadline, ' +
          '  filing_fee = excluded.filing_fee, ' +
          '  authority_name = excluded.authority_name, ' +
          '  authority_phone = excluded.authority_phone, ' +
          '  authority_url = excluded.authority_url, ' +
          '  authority_notes = excluded.authority_notes, ' +
          '  authority_jurisdiction_specific = excluded.authority_jurisdiction_specific, ' +
          '  source = excluded.source, ' +
          '  last_updated = excluded.last_updated, ' +
          '  created_at = datetime(\'now\')'
        ).bind(
          generateId(16), stateCode || '', officeNormalized, raceYear, jurisdictionName,
          result.status,
          result.deadlines.qualifying_period_start,
          result.deadlines.qualifying_period_end,
          result.deadlines.qualifying_period_end_time,
          result.deadlines.petition_deadline,
          result.deadlines.filing_fee,
          result.authority.name,
          result.authority.phone,
          result.authority.url,
          result.authority.notes,
          result.authority.jurisdiction_specific,
          result.source,
          result.last_updated
        ).run().catch((e) => { console.warn('[compliance] cache write failed:', e.message); });

        return jsonResponse({ ...result, cached: false });
      } catch (error) {
        return jsonResponse({ error: error.message }, 500);
      }
    }

    function formatComplianceCacheRow(row, isCached) {
      return {
        status: row.status,
        deadlines: {
          qualifying_period_start: row.qualifying_period_start,
          qualifying_period_end: row.qualifying_period_end,
          qualifying_period_end_time: row.qualifying_period_end_time,
          petition_deadline: row.petition_deadline,
          filing_fee: row.filing_fee
        },
        authority: {
          name: row.authority_name,
          phone: row.authority_phone,
          url: row.authority_url,
          notes: row.authority_notes,
          jurisdiction_specific: row.authority_jurisdiction_specific
        },
        source: row.source,
        last_updated: row.last_updated,
        cached: !!isCached
      };
    }

    // ========================================
    // DATA API: lookup_finance_reports (Compliance Class B)
    //
    // Backs the lookup_finance_reports Sam tool — verified campaign
    // finance report schedules (quarterly + pre-election + post-
    // election). Same architecture as lookup_compliance_deadlines
    // (Class A): cache check, source cascade, authority always
    // populated, 90-day TTL.
    //
    // Source cascade (this checkpoint stubs all three; everything
    // returns status='unsupported' with authority data):
    //   1. FEC reporting calendar for federal races (deferred —
    //      existing TCB research service exposes candidate finances,
    //      not the reporting calendar; would need new endpoint)
    //   2. State SOS for state-level (stubbed)
    //   3. Local races fall through to authority-only stub
    //
    // Authority data is reused from compliance_authorities (the same
    // state office handles both filing deadlines and report schedules
    // for most jurisdictions). If a state actually has a separate
    // campaign-finance authority, that's future-checkpoint data work.
    // ========================================
    if (url.pathname === '/api/finance/lookup' && request.method === 'POST') {
      try {
        const ctx = await getSessionContext(request);
        if (!ctx) return jsonResponse({ error: 'Not authenticated' }, 401);
        if (ctx.revoked) return denyRevoked();
        const body = await request.json().catch(() => ({}));

        const stateRaw = (body.state || '').trim();
        const office = (body.office || '').trim();
        const raceYear = parseInt(body.race_year, 10);
        const jurisdictionName = (body.jurisdiction_name || '').trim() || null;

        if (!stateRaw || !office || !Number.isFinite(raceYear)) {
          return jsonResponse({ error: 'state, office, race_year required' }, 400);
        }

        const stateCode = normalizeStateCode(stateRaw);
        const officeNormalized = office.toLowerCase().trim();
        const cacheJurKey = jurisdictionName || '';

        const cached = await env.DB.prepare(
          "SELECT * FROM finance_reports_cache " +
          "WHERE state_code = ? AND office_normalized = ? AND race_year = ? AND COALESCE(jurisdiction_name,'') = ? " +
          "AND created_at > datetime('now', '-90 days') LIMIT 1"
        ).bind(stateCode || '', officeNormalized, raceYear, cacheJurKey).first();

        if (cached) {
          return jsonResponse(formatFinanceCacheRow(cached, true));
        }

        // Source cascade — FEC reporting calendar + state SOS deferred.
        let result = null;
        // result = await tryFecReportingCalendar(stateCode, office, raceYear);
        // if (!result) result = await trySosFinanceCalendar(stateCode, office, raceYear);

        if (!result) {
          const authority = await fetchAuthorityForRace(stateCode, jurisdictionName);
          result = {
            status: 'unsupported',
            reports: {
              quarterly_schedule: null,
              pre_election_special: null,
              post_election: null
            },
            authority: authority,
            source: 'stub_authority_only',
            last_updated: new Date().toISOString()
          };
        }

        await env.DB.prepare(
          'INSERT INTO finance_reports_cache (id, state_code, office_normalized, race_year, jurisdiction_name, status, reports_json, authority_json, source, last_updated) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
          'ON CONFLICT(state_code, office_normalized, race_year, COALESCE(jurisdiction_name,\'\')) DO UPDATE SET ' +
          '  status = excluded.status, ' +
          '  reports_json = excluded.reports_json, ' +
          '  authority_json = excluded.authority_json, ' +
          '  source = excluded.source, ' +
          '  last_updated = excluded.last_updated, ' +
          '  created_at = datetime(\'now\')'
        ).bind(
          generateId(16), stateCode || '', officeNormalized, raceYear, jurisdictionName,
          result.status,
          JSON.stringify(result.reports || {}),
          JSON.stringify(result.authority || {}),
          result.source,
          result.last_updated
        ).run().catch((e) => { console.warn('[finance] cache write failed:', e.message); });

        return jsonResponse({ ...result, cached: false });
      } catch (error) {
        return jsonResponse({ error: error.message }, 500);
      }
    }

    function formatFinanceCacheRow(row, isCached) {
      let reports = {};
      let authority = {};
      try { reports = JSON.parse(row.reports_json || '{}'); } catch (_) {}
      try { authority = JSON.parse(row.authority_json || '{}'); } catch (_) {}
      return {
        status: row.status,
        reports: {
          quarterly_schedule: reports.quarterly_schedule || null,
          pre_election_special: reports.pre_election_special || null,
          post_election: reports.post_election || null
        },
        authority: authority,
        source: row.source,
        last_updated: row.last_updated,
        cached: !!isCached
      };
    }

    // ========================================
    // DATA API: lookup_donation_limits (Compliance Class B donation variant)
    //
    // Backs the lookup_donation_limits Sam tool — verified individual
    // contribution limits for the candidate's race (per-election and
    // per-cycle, plus whether primary and general count separately).
    // Same architecture as lookup_compliance_deadlines (Class A) and
    // lookup_finance_reports (Class B finance reports): cache check,
    // source cascade, authority always populated, 90-day TTL.
    //
    // Source cascade (this checkpoint stubs all paths):
    //   1. FEC for federal races (deferred — FEC has /v1/contribution-
    //      limits/ but it's a separate integration not yet wired)
    //   2. State election commission for state-level (stubbed)
    //   3. Local races fall through to authority-only stub
    //
    // Scope explicitly excludes PAC limits, party committee limits,
    // self-fund rules, and aggregate limits. Those are separate fact
    // classes for future checkpoints.
    // ========================================
    if (url.pathname === '/api/donation/lookup' && request.method === 'POST') {
      try {
        const ctx = await getSessionContext(request);
        if (!ctx) return jsonResponse({ error: 'Not authenticated' }, 401);
        if (ctx.revoked) return denyRevoked();
        const body = await request.json().catch(() => ({}));

        const stateRaw = (body.state || '').trim();
        const office = (body.office || '').trim();
        const raceYear = parseInt(body.race_year, 10);
        const jurisdictionName = (body.jurisdiction_name || '').trim() || null;

        if (!stateRaw || !office || !Number.isFinite(raceYear)) {
          return jsonResponse({ error: 'state, office, race_year required' }, 400);
        }

        const stateCode = normalizeStateCode(stateRaw);
        const officeNormalized = office.toLowerCase().trim();
        const cacheJurKey = jurisdictionName || '';

        const cached = await env.DB.prepare(
          "SELECT * FROM donation_limits_cache " +
          "WHERE state_code = ? AND office_normalized = ? AND race_year = ? AND COALESCE(jurisdiction_name,'') = ? " +
          "AND created_at > datetime('now', '-90 days') LIMIT 1"
        ).bind(stateCode || '', officeNormalized, raceYear, cacheJurKey).first();

        if (cached) {
          return jsonResponse(formatDonationCacheRow(cached, true));
        }

        // Source cascade — FEC + state stubbed.
        let result = null;
        // result = await tryFecContributionLimits(stateCode, office, raceYear);
        // if (!result) result = await tryStateContributionLimits(stateCode, office, raceYear);

        if (!result) {
          const authority = await fetchAuthorityForRace(stateCode, jurisdictionName);
          result = {
            status: 'unsupported',
            limits: {
              individual_per_election: null,
              individual_per_cycle: null,
              counts_primary_and_general_separately: null,
              notes: null
            },
            authority: authority,
            source: 'stub_authority_only',
            last_updated: new Date().toISOString()
          };
        }

        await env.DB.prepare(
          'INSERT INTO donation_limits_cache (id, state_code, office_normalized, race_year, jurisdiction_name, status, limits_json, authority_json, source, last_updated) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
          'ON CONFLICT(state_code, office_normalized, race_year, COALESCE(jurisdiction_name,\'\')) DO UPDATE SET ' +
          '  status = excluded.status, ' +
          '  limits_json = excluded.limits_json, ' +
          '  authority_json = excluded.authority_json, ' +
          '  source = excluded.source, ' +
          '  last_updated = excluded.last_updated, ' +
          '  created_at = datetime(\'now\')'
        ).bind(
          generateId(16), stateCode || '', officeNormalized, raceYear, jurisdictionName,
          result.status,
          JSON.stringify(result.limits || {}),
          JSON.stringify(result.authority || {}),
          result.source,
          result.last_updated
        ).run().catch((e) => { console.warn('[donation] cache write failed:', e.message); });

        return jsonResponse({ ...result, cached: false });
      } catch (error) {
        return jsonResponse({ error: error.message }, 500);
      }
    }

    function formatDonationCacheRow(row, isCached) {
      let limits = {};
      let authority = {};
      try { limits = JSON.parse(row.limits_json || '{}'); } catch (_) {}
      try { authority = JSON.parse(row.authority_json || '{}'); } catch (_) {}
      return {
        status: row.status,
        limits: {
          individual_per_election: limits.individual_per_election == null ? null : limits.individual_per_election,
          individual_per_cycle: limits.individual_per_cycle == null ? null : limits.individual_per_cycle,
          counts_primary_and_general_separately: limits.counts_primary_and_general_separately == null ? null : limits.counts_primary_and_general_separately,
          notes: limits.notes == null ? null : limits.notes
        },
        authority: authority,
        source: row.source,
        last_updated: row.last_updated,
        cached: !!isCached
      };
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
    // INTEL: Remove opponent (cascades to opposition_notes)
    // ========================================
    if (url.pathname === '/api/opponents/remove' && request.method === 'POST') {
      try {
        const ctx = await getSessionContext(request);
        if (!ctx) return jsonResponse({ error: 'Not authenticated' }, 401);
        if (ctx.revoked) return denyRevoked();
        if (!requirePermission(ctx, 'intel', 'full')) return denyPermission('intel');
        const { id } = await request.json();
        if (!id) return jsonResponse({ error: 'id required' }, 400);
        // Look up name first so we can clean up opposition_notes by name.
        // Frontend also calls /api/intel/notes/delete explicitly; server-side
        // cascade is the safety net for any frontend that misses it.
        const oppRow = await env.DB.prepare(
          'SELECT name FROM opponents WHERE id = ? AND workspace_owner_id = ?'
        ).bind(id, ctx.ownerId).first();
        await env.DB.prepare('DELETE FROM opponents WHERE id = ? AND workspace_owner_id = ?').bind(id, ctx.ownerId).run();
        if (oppRow && oppRow.name) {
          await env.DB.prepare(
            'DELETE FROM opposition_notes WHERE workspace_owner_id = ? AND opponent_name = ?'
          ).bind(ctx.ownerId, oppRow.name).run().catch(() => {});
        }
        return jsonResponse({ success: true });
      } catch (error) { return jsonResponse({ error: error.message }, 500); }
    }

    // ========================================
    // INTEL: Opposition Notes (user-supplied free-text intel per opponent)
    //
    // Three endpoints. All workspace-scoped via workspace_owner_id.
    // Save and delete require intel/full; load requires intel/read.
    // 2,000 char cap enforced server-side; longer notes are clipped.
    // ========================================
    if (url.pathname === '/api/intel/notes/save' && request.method === 'POST') {
      try {
        const ctx = await getSessionContext(request);
        if (!ctx) return jsonResponse({ error: 'Not authenticated' }, 401);
        if (ctx.revoked) return denyRevoked();
        if (!requirePermission(ctx, 'intel', 'full')) return denyPermission('intel');
        const { opponent_name, notes } = await request.json();
        const name = (opponent_name || '').trim();
        if (!name) return jsonResponse({ error: 'opponent_name required' }, 400);
        const clipped = String(notes == null ? '' : notes).slice(0, 2000);
        const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
        await env.DB.prepare(
          'INSERT INTO opposition_notes (id, workspace_owner_id, opponent_name, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ' +
          'ON CONFLICT(workspace_owner_id, opponent_name) DO UPDATE SET notes = excluded.notes, updated_at = excluded.updated_at'
        ).bind(generateId(16), ctx.ownerId, name, clipped, now, now).run();
        return jsonResponse({ success: true, notes: clipped, updated_at: now });
      } catch (error) { return jsonResponse({ error: error.message }, 500); }
    }

    if (url.pathname === '/api/intel/notes/load' && request.method === 'GET') {
      try {
        const ctx = await getSessionContext(request);
        if (!ctx) return jsonResponse({ error: 'Not authenticated' }, 401);
        if (ctx.revoked) return denyRevoked();
        if (!requirePermission(ctx, 'intel', 'read')) return denyPermission('intel');
        const rows = await env.DB.prepare(
          'SELECT opponent_name, notes, updated_at FROM opposition_notes WHERE workspace_owner_id = ? ORDER BY updated_at DESC'
        ).bind(ctx.ownerId).all();
        return jsonResponse({ success: true, notes: (rows.results || []) });
      } catch (error) { return jsonResponse({ error: error.message }, 500); }
    }

    if (url.pathname === '/api/intel/notes/delete' && request.method === 'POST') {
      try {
        const ctx = await getSessionContext(request);
        if (!ctx) return jsonResponse({ error: 'Not authenticated' }, 401);
        if (ctx.revoked) return denyRevoked();
        if (!requirePermission(ctx, 'intel', 'full')) return denyPermission('intel');
        const { opponent_name } = await request.json();
        const name = (opponent_name || '').trim();
        if (!name) return jsonResponse({ error: 'opponent_name required' }, 400);
        await env.DB.prepare(
          'DELETE FROM opposition_notes WHERE workspace_owner_id = ? AND opponent_name = ?'
        ).bind(ctx.ownerId, name).run();
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
      // ENTITY MASK BACKFILL + LOAD (runs once per turn)
      // Populates entity_mask from candidate profile, opponents, endorsers,
      // donors. Idempotent. Then loads the full entity list for this
      // workspace into memory so mask/demask helpers don't hit D1 on
      // every call.
      // ========================================
      await backfillEntityMask(chatOwnerId, body);
      const workspaceEntities = await getAllWorkspaceEntities(chatOwnerId);

      // ========================================
      // SAFE MODE — session-level reliability heuristic (Phase 3)
      // Query validator firings for this conversation BEFORE assembling
      // the system prompt. If the count crossed the threshold on a
      // prior turn, this turn is in Safe Mode (stricter prompt + banner
      // prepended to delivered response). The current turn's validator
      // firings (if any) won't count until the next turn — that's
      // intentional, matches the "trigger on prior demonstrated drift"
      // semantic.
      // ========================================
      const SAFE_MODE_THRESHOLD = 3;
      const safeModeFirings = conversation_id
        ? await getValidatorFiringBreakdown(conversation_id)
        : { total: 0, breakdown: {} };
      const safeModeActive = safeModeFirings.total >= SAFE_MODE_THRESHOLD;
      // Idempotent activation log — INSERT OR IGNORE on the unique
      // conversation_id index ensures exactly one row per conversation.
      if (safeModeActive && conversation_id) {
        env.DB.prepare(
          'INSERT OR IGNORE INTO sam_safe_mode_events (id, conversation_id, workspace_owner_id, user_id, trigger_count, triggering_validator_breakdown) VALUES (?, ?, ?, ?, ?, ?)'
        ).bind(
          generateId(16), conversation_id, chatOwnerId || null, rateLimitUserId || null,
          safeModeFirings.total, JSON.stringify(safeModeFirings.breakdown)
        ).run().catch((e) => { console.warn('[safe_mode] log failed:', e.message); });
      }

      // Banner prepended to Sam's text on delivery when Safe Mode is
      // active. Applied to whatever response object is being returned —
      // normal data, regen retry, or stripped response — at every
      // return-Response site in this handler.
      const SAFE_MODE_BANNER =
        '\u26A0\uFE0F **Heads up:** I\'ve had trouble verifying some specifics in our conversation. Please double-check anything specific I tell you \u2014 dates, amounts, names, or claims about your race \u2014 with your local elections office or other authoritative source before acting on it.\n\n---\n\n';

      function applySafeModeBanner(respObj) {
        if (!safeModeActive || !respObj || !Array.isArray(respObj.content)) return respObj;
        const firstTextIdx = respObj.content.findIndex(b => b && b.type === 'text');
        if (firstTextIdx >= 0) {
          respObj.content[firstTextIdx] = {
            ...respObj.content[firstTextIdx],
            text: SAFE_MODE_BANNER + (respObj.content[firstTextIdx].text || '')
          };
        } else {
          respObj.content = [{ type: 'text', text: SAFE_MODE_BANNER }, ...respObj.content];
        }
        return respObj;
      }

      function buildSafeResponse(respObj) {
        applySafeModeBanner(respObj);
        return new Response(JSON.stringify(respObj), {
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
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

      function preprocessRelativeDates(rawMessage, isoTodayStr) {
        if (!rawMessage || typeof rawMessage !== 'string' || !isoTodayStr) {
          return { rewritten: rawMessage || '', patterns: [] };
        }
        const [yy, mm, dd] = isoTodayStr.split('-').map(Number);
        const todayUTC = new Date(Date.UTC(yy, mm - 1, dd, 12));
        const FULL_DAY_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
        const ymd = (dt) => `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
        const dayName = (dt) => FULL_DAY_NAMES[dt.getUTCDay()];
        // Single-date parenthetical: includes day-of-week so Haiku doesn't
        // re-derive it (we caught Sam saying "Saturday, May 10" when 2026-05-10
        // is a Sunday — preprocessor inlined the date but Haiku still computed
        // the wrong weekday).
        const dymd = (dt) => `${dayName(dt)}, ${ymd(dt)}`;
        const ymOnly = (dt) => `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}`;
        const addDays = (dt, n) => new Date(dt.getTime() + n * 86400000);
        const dow = (dt) => dt.getUTCDay();

        const todayDow = dow(todayUTC);
        const daysFromMonday = (todayDow + 6) % 7;
        const thisMon = addDays(todayUTC, -daysFromMonday);
        const nextMon = addDays(thisMon, 7);
        const twoWeeksMon = addDays(thisMon, 14);
        const lastMon = addDays(thisMon, -7);

        const tomorrowDt = addDays(todayUTC, 1);
        const yesterdayDt = addDays(todayUTC, -1);
        const dayAfterTmrw = addDays(todayUTC, 2);

        const thisSat = addDays(thisMon, 5);
        const thisSun = addDays(thisMon, 6);
        const nextSat = addDays(nextMon, 5);
        const nextSun = addDays(nextMon, 6);
        const lastSat = addDays(lastMon, 5);
        const lastSun = addDays(lastMon, 6);
        const twoWkSat = addDays(twoWeeksMon, 5);
        const twoWkSun = addDays(twoWeeksMon, 6);

        // Weekend semantics (matches checkpoint test expectations):
        //   today is Sunday → "this weekend" = upcoming (next week's Sat/Sun);
        //                     "last weekend" = the just-completed pair
        //                     (this week's Sat/Sun including today)
        //   today is Saturday → "this weekend" = today + tomorrow
        //   today is Mon-Fri → "this weekend" = upcoming (this week's Sat/Sun)
        let twkSat, twkSun, nwkSat, nwkSun, lwkSat, lwkSun;
        if (todayDow === 0) {
          twkSat = nextSat; twkSun = nextSun;
          nwkSat = twoWkSat; nwkSun = twoWkSun;
          lwkSat = thisSat; lwkSun = thisSun;
        } else {
          twkSat = thisSat; twkSun = thisSun;
          nwkSat = nextSat; nwkSun = nextSun;
          lwkSat = lastSat; lwkSun = lastSun;
        }

        const startThisMonth = new Date(Date.UTC(yy, mm - 1, 1, 12));
        const endThisMonth = new Date(Date.UTC(yy, mm, 0, 12));
        const startNextMonth = new Date(Date.UTC(yy, mm, 1, 12));
        const endNextMonth = new Date(Date.UTC(yy, mm + 1, 0, 12));
        const startLastMonth = new Date(Date.UTC(yy, mm - 2, 1, 12));

        const dayMap = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
        // Day-of-week resolution — forward-from-today (colloquial American
        // English) semantics. "Next/this Saturday" said on Tuesday means
        // the upcoming Saturday (4 days away), NOT next-Mon-Sun-week's
        // Saturday (11 days away). Edge case: if today IS the named day,
        // resolve to ±7 days away (a week out / a week ago) rather than
        // returning today's date — that's confusing.
        function resolveDow(modifier, dayName) {
          const target = dayMap[dayName.toLowerCase()];
          if (target === undefined) return null;
          const todayDowVal = dow(todayUTC);
          if (modifier === 'next' || modifier === 'this') {
            let diff = (target - todayDowVal + 7) % 7;
            if (diff === 0) diff = 7;  // today IS the named day → a week from today
            return addDays(todayUTC, diff);
          } else if (modifier === 'last') {
            let diff = (todayDowVal - target + 7) % 7;
            if (diff === 0) diff = 7;  // today IS the named day → a week ago
            return addDays(todayUTC, -diff);
          }
          return null;
        }

        // Build pattern list: each entry { rx, fn } applied in array order.
        // Longer phrases register first so they win at any given position.
        const patterns = [];
        const escapeForRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        function addLiteral(phrase, parens) {
          patterns.push({
            rx: new RegExp(`\\b(${escapeForRx(phrase)})\\b(?!\\s*\\()`, 'gi'),
            fn: () => parens
          });
        }
        function addRegex(rxSrc, fn) {
          patterns.push({
            rx: new RegExp(`\\b(?:${rxSrc})\\b(?!\\s*\\()`, 'gi'),
            fn: fn
          });
        }

        addLiteral('the day after tomorrow', `(${dymd(dayAfterTmrw)})`);
        addLiteral('the week after next', `(week of ${dymd(twoWeeksMon)})`);
        addLiteral('the week after', `(week of ${dymd(twoWeeksMon)})`);

        addLiteral('two weeks from now', `(${dymd(addDays(todayUTC, 14))})`);
        addLiteral('in two weeks', `(${dymd(addDays(todayUTC, 14))})`);
        addLiteral('two weeks ago', `(${dymd(addDays(todayUTC, -14))})`);

        addRegex('in (\\d{1,2}) days?', (m) => {
          const n = parseInt(m[1], 10); if (n < 1 || n > 12) return null;
          return `(${dymd(addDays(todayUTC, n))})`;
        });
        addRegex('(\\d{1,2}) days? from now', (m) => {
          const n = parseInt(m[1], 10); if (n < 1 || n > 12) return null;
          return `(${dymd(addDays(todayUTC, n))})`;
        });
        addRegex('(\\d{1,2}) days? ago', (m) => {
          const n = parseInt(m[1], 10); if (n < 1 || n > 12) return null;
          return `(${dymd(addDays(todayUTC, -n))})`;
        });
        addRegex('in (\\d) weeks?', (m) => {
          const n = parseInt(m[1], 10); if (n < 1 || n > 8) return null;
          return `(${dymd(addDays(todayUTC, n * 7))})`;
        });
        addRegex('(\\d) weeks? from now', (m) => {
          const n = parseInt(m[1], 10); if (n < 1 || n > 8) return null;
          return `(${dymd(addDays(todayUTC, n * 7))})`;
        });
        addRegex('(\\d) weeks? ago', (m) => {
          const n = parseInt(m[1], 10); if (n < 1 || n > 8) return null;
          return `(${dymd(addDays(todayUTC, -n * 7))})`;
        });

        addLiteral('end of next month', `(${dymd(endNextMonth)}, last day)`);
        addLiteral('end of the month', `(${dymd(endThisMonth)}, last day)`);
        addLiteral('end of month', `(${dymd(endThisMonth)}, last day)`);
        addLiteral("this month's end", `(${dymd(endThisMonth)}, last day)`);
        addLiteral('start of next month', `(${dymd(startNextMonth)})`);
        addLiteral('beginning of next month', `(${dymd(startNextMonth)})`);
        // Month-only references stay as YYYY-MM (no single day to label).
        addLiteral('next month', `(${ymOnly(startNextMonth)})`);
        addLiteral('this month', `(${ymOnly(startThisMonth)})`);
        addLiteral('last month', `(${ymOnly(startLastMonth)})`);

        // Weekend references already explicit about which day is which — no day-name prefix needed.
        addLiteral('next weekend', `(Sat ${ymd(nwkSat)} / Sun ${ymd(nwkSun)})`);
        addLiteral('this weekend', `(Sat ${ymd(twkSat)} / Sun ${ymd(twkSun)})`);
        addLiteral('last weekend', `(Sat ${ymd(lwkSat)} / Sun ${ymd(lwkSun)})`);

        addLiteral('next week', `(week of ${dymd(nextMon)})`);
        addLiteral('this week', `(week of ${dymd(thisMon)})`);
        addLiteral('last week', `(week of ${dymd(lastMon)})`);

        for (const mod of ['next', 'this', 'last']) {
          for (const day of ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']) {
            const dt = resolveDow(mod, day);
            if (dt) addLiteral(`${mod} ${day}`, `(${dymd(dt)})`);
          }
        }

        addLiteral('tomorrow', `(${dymd(tomorrowDt)})`);
        addLiteral('yesterday', `(${dymd(yesterdayDt)})`);
        // "today" intentionally omitted — already explicit, would be noise.

        // Mask quoted strings so internal phrases stay untouched.
        const quotedSpans = [];
        let work = rawMessage.replace(/"[^"]*"/g, (match) => {
          const idx = quotedSpans.length;
          quotedSpans.push(match);
          return `\u0001QSPAN${idx}\u0001`;
        });

        const matchedPhrases = [];
        for (const { rx, fn } of patterns) {
          work = work.replace(rx, (...args) => {
            const offset = args[args.length - 2];
            // For literal-phrase patterns built via addLiteral the call
            // shape is (match, group1, offset, full). For addRegex it
            // could include extra captures. The full match is always
            // args[0].
            const full = args[0];
            const captures = args.slice(0, args.length - 2);
            const parens = fn(captures);
            if (parens === null || parens === undefined) return full;
            matchedPhrases.push(full);
            return `${full} ${parens}`;
          });
        }

        for (let i = 0; i < quotedSpans.length; i++) {
          work = work.replace(`\u0001QSPAN${i}\u0001`, quotedSpans[i]);
        }
        return { rewritten: work, patterns: matchedPhrases };
      }

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

        // Day-of-week colloquial lookups: forward-from-today (and backward
        // for "last"). Today=that-day → ±7 days, never returns today's date.
        // Matches the preprocessor's resolveDow semantics so Sam never
        // sees a contradiction between "next Saturday" inlined in the
        // user message and the calendar reference.
        const todayDowVal = dow(todayUTC);
        function nextOrThisDow(targetDow) {
          let diff = (targetDow - todayDowVal + 7) % 7;
          if (diff === 0) diff = 7;
          return addDays(todayUTC, diff);
        }
        function lastDow(targetDow) {
          let diff = (todayDowVal - targetDow + 7) % 7;
          if (diff === 0) diff = 7;
          return addDays(todayUTC, -diff);
        }
        const dayOrder = [1, 2, 3, 4, 5, 6, 0]; // Mon..Sun (display order)
        const nextOrThis = dayOrder.map(d => nextOrThisDow(d));
        const lastOcc = dayOrder.map(d => lastDow(d));

        // Weekend lookup uses upcoming-or-today semantics so that on
        // Saturday "this weekend" = today + tomorrow (NOT a week away).
        // diff=0 here means "today is the Sat" — return today.
        function upcomingDowOrToday(targetDow) {
          const diff = (targetDow - todayDowVal + 7) % 7;
          return addDays(todayUTC, diff);
        }
        const thisWeekendSat = upcomingDowOrToday(6);
        // This weekend's Sun is always the day after this weekend's Sat.
        const thisWeekendSun = addDays(thisWeekendSat, 1);
        const nextWeekendSat = addDays(thisWeekendSat, 7);
        const nextWeekendSun = addDays(thisWeekendSun, 7);

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

DAY-OF-WEEK LOOKUPS — for "next/this/last [day]" phrases (forward-from-today, colloquial American English):
Next/this Mon: ${fl(nextOrThis[0])}, ${ymd(nextOrThis[0])}
Next/this Tue: ${fl(nextOrThis[1])}, ${ymd(nextOrThis[1])}
Next/this Wed: ${fl(nextOrThis[2])}, ${ymd(nextOrThis[2])}
Next/this Thu: ${fl(nextOrThis[3])}, ${ymd(nextOrThis[3])}
Next/this Fri: ${fl(nextOrThis[4])}, ${ymd(nextOrThis[4])}
Next/this Sat: ${fl(nextOrThis[5])}, ${ymd(nextOrThis[5])}
Next/this Sun: ${fl(nextOrThis[6])}, ${ymd(nextOrThis[6])}
Last Mon: ${ymd(lastOcc[0])} | Last Tue: ${ymd(lastOcc[1])} | Last Wed: ${ymd(lastOcc[2])} | Last Thu: ${ymd(lastOcc[3])} | Last Fri: ${ymd(lastOcc[4])} | Last Sat: ${ymd(lastOcc[5])} | Last Sun: ${ymd(lastOcc[6])}

CALENDAR-WEEK GRIDS (informational only — for week-level reasoning, NOT for "next [day]" lookups; use DAY-OF-WEEK LOOKUPS above for those):
Current week (Mon-Sun containing today):
${fmtRow(thisWeek)}
Following week (Mon-Sun after current):
${fmtRow(nextWeek)}
Two weeks out (Mon-Sun):
${fmtRow(twoWeeks)}

This weekend: Sat ${ymd(thisWeekendSat)} / Sun ${ymd(thisWeekendSun)}
Next weekend (the one after this weekend): Sat ${ymd(nextWeekendSat)} / Sun ${ymd(nextWeekendSun)}

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
          intelGroundTruth += `\n\nOPPONENTS (${intelContext.opponents.length}):\n` + intelContext.opponents.map(o => {
            const lines = [
              `- ${o.name} (${o.party || 'unknown'})${o.office ? ' [' + o.office + ']' : ''} — threat ${o.threatLevel != null ? o.threatLevel + '/10' : 'unknown'}`
            ];
            if (o.keyRisk) lines.push(`    Key risk: ${o.keyRisk}`);
            if (o.campaignFocus) lines.push(`    Campaign focus: ${o.campaignFocus}`);
            if (o.bio) lines.push(`    Bio: ${o.bio}`);
            if (o.background) lines.push(`    Background: ${o.background}`);
            if (o.recentNews) lines.push(`    Recent: ${o.recentNews}`);
            if (o.userNotes) lines.push(`    USER NOTES (authoritative — candidate's own intel): ${o.userNotes}`);
            return lines.join('\n');
          }).join('\n');
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

      // Sam v2 Phase 1: load candidate site content + fallback bio for the
      // ABOUT YOUR CANDIDATE block. Owner-scoped: chatOwnerId points to the
      // candidate's user_id (sub-users see the same content as the owner).
      let candidateSiteContent = '';
      let candidateSiteUrl = '';
      let candidateSiteFetchedAt = '';
      let candidateBioText = '';
      let earlyVotingStartDate = '';
      if (chatOwnerId) {
        try {
          const profileV2 = await env.DB.prepare(
            'SELECT candidate_site_url, candidate_site_content, candidate_site_fetched_at, candidate_bio_text, early_voting_start_date FROM profiles WHERE user_id = ?'
          ).bind(chatOwnerId).first();
          if (profileV2) {
            candidateSiteUrl = profileV2.candidate_site_url || '';
            candidateSiteContent = profileV2.candidate_site_content || '';
            candidateSiteFetchedAt = profileV2.candidate_site_fetched_at || '';
            candidateBioText = profileV2.candidate_bio_text || '';
            earlyVotingStartDate = profileV2.early_voting_start_date || '';
          }
        } catch (e) { console.warn('[v2 profile load]', e.message); }
      }
      // Build ABOUT YOUR CANDIDATE block — surfaces user-supplied identity
      // context. Site content first (richer); bio appended (or sole content
      // if no URL was provided). Block omitted entirely if both empty.
      let aboutCandidateBlock = '';
      if (candidateSiteContent || candidateBioText) {
        aboutCandidateBlock = '\n================================================================\nABOUT YOUR CANDIDATE\n================================================================\n';
        if (candidateSiteContent) {
          aboutCandidateBlock += `\nThe candidate provided their campaign website during onboarding. Below is the content from ${candidateSiteUrl}${candidateSiteFetchedAt ? ' (retrieved ' + candidateSiteFetchedAt + ')' : ''}:\n\n---\n${candidateSiteContent}\n---\n\nUse this as authoritative context about who the candidate is, their background, positions, messaging, and tone. When relevant, reference their site ("Based on your site...", "Per your campaign messaging on ' + (candidateSiteUrl || 'your site') + '...").\n`;
        }
        if (candidateBioText) {
          aboutCandidateBlock += `\nDuring onboarding, the candidate also shared the following about themselves:\n\n---\n${candidateBioText}\n---\n\nUse this as authoritative context. They are the authority on themselves.\n`;
        }
      }

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
            // Mask the stored result. Tool memory's only consumer is
            // Sam's next-turn context, so storing masked at write
            // time keeps the read path simple — no demask needed
            // when injecting into the system prompt.
            const resultStr = (p.result || '').slice(0, 50000);
            // Tool result content is server-side JSON — many quoted spans.
            // Skip quote protection (it's for user-typed pasted docs).
            const maskedResult = (workspaceEntities && workspaceEntities.length > 0)
              ? maskText(resultStr, workspaceEntities, { skipQuoteProtection: true })
              : resultStr;
            await env.DB.prepare(
              'INSERT OR IGNORE INTO sam_tool_memory (id, conversation_id, workspace_owner_id, tool_name, tool_use_id, parameters, result) VALUES (?, ?, ?, ?, ?, ?, ?)'
            ).bind(
              generateId(16),
              convId,
              ownerId || null,
              p.name || 'unknown',
              p.tool_use_id || null,
              JSON.stringify(p.input || {}),
              maskedResult
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

      let systemPrompt = `${aboutCandidateBlock}================================================================
STOP — FACTUAL DISCIPLINE (read before every response)
================================================================
Before you output a specific date, dollar amount, filing deadline, qualifying period, vote total, polling number, percentage, or biographical fact about the candidate, CONFIRM you got it from one of these three sources: (a) the user's saved campaign data shown below in GROUND TRUTH, (b) a web_search result you called in THIS conversation, or (c) the user's own message earlier in this conversation. If you cannot point to one of those three, STOP. Do not write the answer. Either call web_search right now and cite what you find, or reply "I don't have that — verify with [specific authority such as the Supervisor of Elections]."

CITATION-FIRST — DEFAULT POSTURE (read every time, before every factual answer):

Your default behavior is to ANSWER QUESTIONS, not defer. When the user asks a factual question, your first move is to retrieve the answer from a real source and cite it inline.

WHEN TO CALL WEB_SEARCH:

Call web_search for ANY question about current state of the world:
- Laws, regulations, deadlines, filing requirements
- Current officeholders, candidates, election dates
- Contribution limits, reporting calendars, qualifying periods
- Early voting dates, polling locations, ballot access requirements
- Recent news, polls, fundraising data, FEC filings
- Specific political figures, organizations, endorsements
- District boundaries, demographics, voter registration

Do NOT call web_search for:
- Conceptual or definitional questions ("what's a PAC?", "what does 501c4 mean?")
- Math or calculations using data already in context
- Strategic reasoning over data already provided
- Conversational responses ("thanks", "what's next?")

WHEN ANSWERING FACTUAL QUESTIONS:

1. Call web_search with a focused query
2. Read the results
3. State the answer with the source cited inline:
   "Florida early voting starts October 22, 2026 (Source: dos.fl.gov)"
   "Filing deadline is June 12, 2026 (Source: ballotpedia.org/Florida_House_District_39)"
   "Individual contribution limit for FL state house is $1,000 (Source: dos.myflorida.com/campaign-finance)"
4. Make the URL clickable in the response

WHEN WEB_SEARCH RETURNS NOTHING USEFUL:

Defer with a SPECIFIC RESOURCE POINTER, not a generic deferral.

Bad: "Contact your local elections office for that information."
Good: "I searched and didn't find a published date for that yet — it may not be released. The FL Division of Elections publishes the candidate calendar at dos.fl.gov/elections/candidates. Want me to set a calendar reminder to check back in two weeks?"

Specific URL > generic advice. Always.

WHEN ANSWERING FROM CONTEXT (Ground Truth, Intel, user-supplied data):

No web_search needed. Cite the context source:
- "Per your campaign site at [URL]..."
- "Based on what you shared in onboarding..."
- "From the Intel notes you saved on Jarod Fox..."

Context-grounded answers are HIGH confidence by construction.

CITATION FORMAT REQUIREMENT:

Every specific factual claim about a date, dollar amount, named person, URL, address, statute, or law MUST include a source attribution in the same response. Acceptable formats:
- Inline URL: "(https://dos.fl.gov)"
- "Source: [domain]" or "Source: [organization name]"
- "Per [URL]" or "Per [organization]"
- "According to [source]"
- "[Source name] reports/shows/lists..."

Bare claims without attribution will be flagged by the post-generation validator and you'll be asked to regenerate with citations. Avoid the regen by citing the first time.

WHY: A campaign manager who refuses to answer questions is useless. A campaign manager who answers with a real source the candidate can verify is genuinely helpful. Citation makes the answer trustworthy by construction — if the source is real and the candidate can click through to verify, you're delivering real value.

ENTITY MASKING — IMPORTANT CONTEXT FOR YOU:
Names of people relevant to this campaign appear in this prompt as placeholder tokens, not real names. {{CANDIDATE}} is the candidate you work for. {{CANDIDATE_FIRST}} and {{CANDIDATE_LAST}} are first/last name references when only one part appears. {{OPPONENT_1}}, {{OPPONENT_2}}, etc. are opponents. {{ENDORSER_N}} are endorsers. {{DONOR_N}} are donors. The user reading your response will see real names — the placeholders are translated automatically before delivery.

WRITE NATURALLY using these placeholder tokens as if they were real names. Do not "fix" them or attempt to guess the underlying real names. Do not write "the candidate" instead of {{CANDIDATE}}. Use the placeholder tokens directly in your prose: "{{CANDIDATE}} should focus on...", "{{OPPONENT_1}}'s recent statements...".

WHY: This system prevents accidental confusion when a candidate or opponent's name happens to match a real-world public figure. By referring to entities by placeholder rather than real name, you cannot accidentally pull biographical or political facts from training data about a different person with the same name.

NAMESAKE RULE: Entity masking handles most of this. The placeholder tokens you see ({{CANDIDATE}}, {{OPPONENT_N}}, etc.) refer to specific people in this campaign — not to any real-world public figure whose name might be similar. Use only Ground Truth and tool results for facts about these entities. Never fabricate filing dates, prior offices, fundraising totals, biographical claims, family details, or quotes.

BANNED HEDGING WORDS on factual questions: "typically," "usually," "around," "about," "roughly," "generally," "ordinarily." If one of these starts forming in a sentence that states a specific date, number, or legal rule, stop writing. Delete it. Call web_search and cite, or defer to the authoritative source. "Typically early June" is the failure pattern — it implies you know a rule you don't.

COMPLIANCE / DEADLINES / LEGAL: when asked about filing deadlines, campaign finance report due dates, qualifying periods, or legal requirements, you MUST do one of: (a) call web_search for the authoritative source (Secretary of State, Supervisor of Elections, Division of Elections, FEC) and cite the URL or page in your answer, or (b) tell the user to verify with that specific agency and provide the agency's phone number. Never give a specific date or rule from memory.

GEOGRAPHIC TARGETING — HARD CONSTRAINT (read every time, before any answer about places):
When the user asks anything about geographic targeting — canvassing, neighborhoods, event locations, mail targets, voter outreach geography, "where should I focus", door knocking, ground game routes, area-specific messaging — your FIRST action this turn must be a call to the lookup_jurisdiction tool for the candidate's race. After the tool result arrives, your response is constrained as follows:

  POSITIVE CONSTRAINT (this is the rule, not a guideline): The set of place names you may mention in your response is exactly the union of \`incorporated_municipalities\` and \`major_unincorporated_areas\` returned by the tool. No other place name from your training data may appear. None. The candidate's adjacent counties contain real cities you have learned about; those cities are forbidden in this response unless the tool returned them.

  HOW TO COMPLY: When you draft each sentence that names a place, ask yourself: "Did the lookup_jurisdiction result I received this turn list this exact place?" If the answer is no, delete the place name and pick a different one from the result.

  EXAMPLE OF THE FAILURE MODE TO AVOID (this happened on 2026-04-25 with a real beta user): A user running for Orange County, FL Mayor asked where to canvass. The tool was called, the tool returned Apopka, Bay Lake, Belle Isle, Eatonville, Edgewood, Lake Buena Vista, Maitland, Oakland, Ocoee, Orlando, Windermere, Winter Garden, Winter Park, plus 49 unincorporated areas. None of those are Altamonte Springs or Sanford. Your prior response listed Altamonte Springs as a high-priority canvassing area. Altamonte Springs is in Seminole County, not Orange County. That response was factually wrong. You wrote a fabricated recommendation despite having the correct list in your context.

  IF YOU HAVE NO TOOL RESULT (the lookup returned source: 'unsupported' for district-level races): the tool result includes an \`authority\` field with the state elections office contact info. Use it. Sample phrasing: "I don't have a verified place list for [jurisdiction]. For verified district boundaries, contact [authority.name] — phone: [authority.phone]. Want me to set a reminder to follow up?" Do NOT invent place names from training.

COMPLIANCE / FILING / QUALIFYING — HARD CONSTRAINT (read every time, before any answer about deadlines):
When the user asks about filing deadlines, qualifying periods, ballot access dates, petition deadlines, filing fees, or any "must do X by date Y to be on the ballot" question — your FIRST action this turn must be a call to lookup_compliance_deadlines for the candidate's race. After the tool result arrives, your response is constrained as follows:

  POSITIVE CONSTRAINT: The only deadline dates, times, or fees you may state are values returned by the tool with status "found" or "partial". You may NOT state a deadline date from your training data, even if you remember one. You may NOT use web_search to substitute for the tool — web_search results are unverified for this fact class and the validator catches them the same as training-data drift.

  WHEN STATUS IS "unsupported" OR THE SPECIFIC DATE FIELD IS NULL: deferral with the authority contact is the CORRECT response, not a failure. The tool result includes an \`authority\` object with name, phone, url, notes, and jurisdiction_specific. Use them. Sample phrasing:
    GOOD: "I don't have verified qualifying dates for [office] in [state]. For your race, contact [authority.name] — phone: [authority.phone]. [Per authority.jurisdiction_specific if present]. Want me to draft a checklist of what to ask, or set a calendar reminder to verify N weeks before filing usually closes?"
    BAD: "I'm sorry, I don't have access to that information." / "Please consult the appropriate authority." / "I cannot provide specific dates." (These sound like a chatbot. The good phrasing names the authority, gives the contact info, offers a concrete next step.)

  PHONE NUMBER PLACEHOLDERS: when authority.phone reads "(verify on state government website)" or similar, paraphrase honestly — say "you can find their current phone number on the state's elections website" rather than reading the placeholder string verbatim.

  URL HANDLING — HARD CONSTRAINT: When the authority object's \`url\` field is null, do NOT mention any URL or domain in your response. Do NOT invent or guess a URL based on the state name (e.g., do NOT write "floridados.gov" or "txelections.org" or any similar guess). Instead, tell the user generically to "search for [State Name] Secretary of State elections" or "find the elections office on the state government website". Mentioning a fabricated URL — even one that sounds plausible — is the same class of error as inventing a deadline date, and the validator will catch it the same way. When authority.url is non-null, you may quote that exact URL verbatim — but only that one.

  WHY: Confidently wrong deadline or fabricated authority URL = candidate disqualified or misdirected. An honest deferral with a real authority contact preserves trust and prevents catastrophic errors. There is no penalty for saying "I don't have that — call this number / search the state's elections website."

CAMPAIGN FINANCE REPORTS — HARD CONSTRAINT (read every time, before any answer about reports):

When the user asks about quarterly reports, pre-primary / pre-general filings, post-election reports, FEC filing dates, or any "when is my campaign finance report due" question — your FIRST action this turn must be a call to lookup_finance_reports for the candidate's race. After the tool result arrives, your response is constrained as follows:

  POSITIVE CONSTRAINT: The only report dates, deadlines, or coverage periods you may state are values returned by the tool with status "found" or "partial". You may NOT state report due dates from your training data, even if you remember one. You may NOT use web_search to substitute for the tool — same rule as compliance.

  WHEN STATUS IS "unsupported" OR THE SPECIFIC FIELD IS NULL: deferral with the authority contact is the CORRECT response. Use authority.name, authority.phone, authority.url, authority.notes, authority.jurisdiction_specific from the tool result. Sample phrasing: "I don't have verified [Q2 / pre-primary / etc.] report dates for [office] in [state]. For your race, contact [authority.name] — phone: [authority.phone]. They'll give you the exact reporting calendar. Want me to set a calendar reminder to follow up?"

  PHONE NUMBER PLACEHOLDERS: when authority.phone reads as a placeholder, paraphrase honestly — say "find their current phone number on the state's elections website" rather than reading the placeholder string verbatim.

  URL HANDLING: when authority.url is null, do NOT mention any URL or domain. Do NOT invent or guess URLs (no "florida-finance.gov" or "txfec.org" guesses). When authority.url is non-null, you may quote that exact URL verbatim.

  WHY: Missing a campaign finance report = fines and bad press at minimum, criminal liability in severe cases. Confidently wrong report dates can cost a candidate their reputation and their cash on hand to fight fines. There is no penalty for saying "I don't have that — call this number."

DONATION LIMITS — HARD CONSTRAINT (read every time, before any answer about contribution limits):

When the user asks about individual contribution limits, donation caps, max donations, "how much can a donor give", per-election or per-cycle limits — your FIRST action this turn must be a call to lookup_donation_limits for the candidate's race. After the tool result arrives, your response is constrained as follows:

  POSITIVE CONSTRAINT: The only contribution limit amounts you may state are values returned by the tool with status "found" or "partial". You may NOT state contribution limits from your training data, even if you remember them. Federal limits ($3,300, etc.), state limits, and local limits all change between cycles — your training data may be stale even when accurate at training time. You may NOT use web_search to substitute for the tool.

  WHEN STATUS IS "unsupported" OR THE SPECIFIC FIELD IS NULL: deferral with the authority contact is the CORRECT response. Sample phrasing: "I don't have verified contribution limits for [office] in [state]. Limits vary by race level and can change between cycles. Contact [authority.name] — phone: [authority.phone] — for the current limits applicable to your race. Want me to set a calendar reminder so we capture the limits before you start your fundraising push?"

  PHONE NUMBER PLACEHOLDERS: paraphrase placeholders honestly, don't read them verbatim.

  URL HANDLING: when authority.url is null, do NOT mention any URL or domain. Don't invent URLs (no "florida-elections.gov" or "fec-limits.gov" guesses).

  WHY: Contribution limit violations result in refunds at minimum, fines and bad press at worst, criminal liability in severe cases. The candidate's donors trust the campaign to know the rules. Confidently wrong limit guidance = a donor writes a check that has to be returned, sometimes publicly. There is no penalty for saying "I don't have that — call this number for current limits."

CITATION DISCIPLINE — HARD CONSTRAINT (read every time, applies to ALL specific factual claims):

When you state any specific factual claim — a dollar amount, a date, a phone number, a URL, an address, a named person, a percentage, a statistic, a benchmark, electoral history, or an organizational characterization of a place — the claim MUST be traceable to one of these sources:

1. Ground Truth context shown above
2. Intel data (opponents, endorsements, contributions panels)
3. Tool results from this conversation
4. Information the user has provided in their messages this conversation

If a specific claim cannot be traced to one of those four sources, you have two options:

A. STATE IT WITH A CAVEAT: "Industry benchmarks suggest [claim], though I'd verify with [appropriate authority] for your specific race." This applies to soft claims like statistics and benchmarks.

B. DO NOT STATE IT: For high-stakes claims (specific dollar amounts, dates, phone numbers, URLs, named persons, statutes), do NOT state the claim from training data. Instead say "I don't have verified [X] — [actionable next step with authority]."

The post-generation validator will catch unverified claims and either strip them (high-stakes) or tag them (soft). Avoid the strip by being honest about uncertainty in the first place.

WHY: A campaign tool that confidently states wrong dollar amounts, dates, or names destroys trust the moment the user verifies independently. A tool that honestly tags uncertainty stays useful even when the underlying knowledge is incomplete.

NEWS QUERIES — HARD CONSTRAINT:

When the user asks about "news," "latest news," "recent news," "what's happening," "what's new," "the latest" — about their race, their district, their opponents, or local political developments — your FIRST action MUST be a web_search call. After web_search returns, your response MUST cite the specific articles/sources from the search results using an explicit attribution phrase: "Per [source]...", "According to [source]...", "Recent reporting from [source] indicates...", or "[Source name] reports...". A bare paraphrase without an attribution phrase counts as filler even when the data is real.

NEVER characterize "news" or recent developments without calling web_search first. Vague phrasings like "your district is heating up," "things are moving," "Democrats are gaining momentum" without citation are FILLER — they are not news, they are guesses dressed up as news.

If web_search returns no relevant results, say so honestly: "I searched but didn't find recent news specific to your race. I can search broader topics if helpful — what specifically are you trying to track?"

If web_search is unavailable for this turn (e.g., opponent research gate fired), defer entirely: "I can't pull current news right now. Let me know what you've heard and I'll factor it in."

WHY: A campaign manager who fabricates news destroys trust the moment the candidate verifies. A campaign manager who admits "I don't have current news" stays useful. Web search results with citations beat training-data recall every time for current events.

EPISTEMIC HONESTY — HARD CONSTRAINT:

When the user asks what you can tell them with certainty versus where you're guessing, your honest enumeration MUST distinguish:

CATEGORY A — VERIFIED (you can state with confidence):
- Facts in Ground Truth shown above
- Information user provided in messages this conversation
- Tool results returned in this conversation
- Intel panel data (opponents, endorsements, contributions)

CATEGORY B — UNVERIFIED RECALL (you should caveat or defer):
- General campaign strategy benchmarks ("80-120 doors per day," "5% mail response rate," "$30 cost per persuasion contact") — these are training-data patterns, NOT verified facts for the user's specific race
- Procedural and legal rules (campaign finance reporting, in-kind contribution rules, filing requirements) — these change between cycles and jurisdictions
- Historical electoral results, district demographics — these may be stale
- Industry best practices for messaging, targeting, fundraising — these are heuristics, not laws

CATEGORY C — DEFERRED (you should not state):
- Specific compliance dates, contribution limits, filing requirements (use lookup tools or defer to authority)
- Specific opponent facts not in Intel
- Specific news/current events without web_search citation

Do NOT classify campaign strategy benchmarks as "I can tell you with certainty." They belong in Category B with caveats. The validator will tag your benchmark claims with "(unverified — verify before relying on)" — that's the correct uncertainty signal.

WHY: Confidently stating training-data benchmarks as verified facts misleads users into trusting numbers that may not apply to their race. Honest categorization keeps trust intact even when knowledge is incomplete.

CLAIM-INFLATION GUARD — HARD CONSTRAINT:

When the user provides a fact about their campaign (filed status, fundraising amount, endorsement, event date, etc.), acknowledge ONLY what the user said. Do NOT expand the user's claim into a stronger claim. Do NOT infer downstream consequences as facts.

Examples:

User says: "I filed three weeks ago"
CORRECT: "Got it — I'll update your filing status. What's next?"
INCORRECT: "You're officially on the ballot." (Filing ≠ ballot access; qualifying is a separate process with signature/fee verification.)

User says: "My friend pledged $5,000"
CORRECT: "I'll track that. Has the contribution been received yet?"
INCORRECT: "Great — that brings your total raised to [X]." (Pledged ≠ received; until received it's not actually money.)

User says: "Senator Smith is going to endorse me"
CORRECT: "I'll add Senator Smith as a planned endorsement. When does the announcement happen?"
INCORRECT: "Senator Smith's endorsement gives you [strategic advantage]." (Planned ≠ announced; until announced it's not public.)

If you're uncertain whether the user's claim implies a stronger fact, ASK rather than assume. "When you say [X], do you mean [interpretation A] or [interpretation B]?"

WHY: Inflating user-supplied claims into stronger claims creates false confidence. The user trusts their own data; if you transform it without permission, the user has to constantly correct you, eroding trust.

USER AS AUTHORITY — HARD CONSTRAINT:

When the user provides a URL or factual claim about themselves, their campaign, their own website, their own bio, their own positions, their own dates, or their own intel about opponents — TREAT IT AS AUTHORITATIVE. The candidate is the authority on themselves and their campaign.

Specifically:
- User-supplied URLs (especially their own campaign site) should be read via web_search/web_fetch without friction
- User-stated facts about themselves are authoritative — do not require external verification
- User-supplied dates (filing date, early voting, planned events) are authoritative once entered
- User-supplied intel about opponents (in chat or Opposition Notes) is authoritative

Do NOT defer or refuse when the user shares their own information. Read it, factor it in, cite it ("Per your campaign site...", "Based on what you shared...").

WHY: The candidate trusts their own data. If you treat their URL or claims as untrusted, you become useless to them. They are the source of truth for their own campaign.

OPPONENT FACTS — HARD CONSTRAINT (read every time, before any answer about opponents):

When the user asks about an opponent's fundraising, donor base, voting record, biography, prior campaigns, controversies, endorsements, or any specific fact about an opponent — your authoritative sources are EXACTLY THESE THREE, in priority order:

1. The Intel panel data shown above in GROUND TRUTH (opponent name, party, office, threat_level, notes, bio, background, recentNews, campaignFocus, keyRisk, userNotes).
2. Tool results from this conversation.
3. Information the user has provided in their messages this conversation.

USER NOTES: When an opponent has userNotes populated, treat that field as AUTHORITATIVE — it's the user's own intel from on-the-ground reporting, conversations, or research they've done. User notes are equivalent to user-provided messages in chat: trust them, factor them into strategy, reference them when relevant.

User notes can include qualitative intel (fundraising rumors, endorsement chatter, vulnerabilities, donor info, recent moves) that the auto-research won't capture. Use this intel actively for strategic counter-messaging and risk assessment.

NEVER use web_search to research opponent biographical, fundraising, or strategic information. Even if the opponent's name is masked as {{OPPONENT_N}}, web_search results may identify a real-world person with the same name and inject training-data facts into your response. The web_search tool is automatically gated off for this turn when your message looks like opponent research, but the rule applies even when web_search remains available — do not use it for opponent-specific queries.

NEVER state specific dollar amounts, dates, organizational affiliations (PAC names, donor names, employers), specific quotes, voting record specifics, or biographical claims (years in office, prior positions, education, family) about opponents that aren't in one of the three authoritative sources above.

WHEN INTEL DATA IS LIMITED OR EMPTY: deferral asking the user to share what they know directly in chat is the CORRECT response, not a failure. Intel only captures the opponent's name (which triggers auto-research) — qualitative details like fundraising, endorsements, voting record, or controversies have no UI home and should be discussed in chat. Sample phrasing: "I don't have detailed information about {{OPPONENT_N}} in your Intel panel beyond what auto-research found. Want to tell me what you know about their fundraising, endorsements, or voting record? Share it with me directly and I'll factor it into your strategy."

WHY: Opponent facts wrong by even a small amount destroy your credibility with a candidate. Confident wrong opponent claims lead to bad strategy decisions. Honest "I don't have that — tell me what you know directly" preserves trust and produces better strategic advice over time.

================================================================

You are Sam, a veteran political campaign manager with 20 years of experience. Direct, strategic, warm but no-nonsense. You speak in campaign language — earned media, persuadables, GOTV, burn rate, ground game, ballot position. You always have a strong opinion and a clear recommendation. When uncertain, say "let me verify that" — never "I don't know."

You work for ${candidateName || 'the candidate'}, who is running for ${specificOffice || 'office'} in ${location || 'their district'}, ${state || 'their state'}. The person chatting with you IS ${candidateName || 'the candidate'}.

================================================================
GROUND TRUTH — ${currentDate} (${isoToday})
================================================================
Candidate: ${candidateName || 'unknown'} | Office: ${specificOffice || officeType || 'unknown'} (${effectiveGovLevel})
Location: ${location || 'unknown'}, ${state || 'unknown'} | Party: ${party || 'not specified'}
Election: ${electionDate || 'not set'}${effectiveDays != null ? ' (' + effectiveDays + ' days away)' : ''} | Phase: ${campaignPhase}${earlyVotingStartDate ? '\nEarly voting starts: ' + earlyVotingStartDate + ' (user-supplied — authoritative)' : ''}
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
      // SAFE MODE — stricter deferral prompt block (Phase 3)
      // Appended only when safeModeActive (validator firings >= threshold
      // earlier in this conversation). Adds an instruction layer telling
      // Sam to default to deferral, skip proactive web_search, and
      // acknowledge the reliability degradation when relevant.
      // ========================================
      if (safeModeActive) {
        systemPrompt += '\n\n================================================================\nSAFE MODE ACTIVE — RELIABILITY HEURISTIC\n================================================================\nEarlier in this conversation, your responses contained claims that needed correction by validators. The system has degraded your default behavior to favor honest deferral over attempted answers.\n\nWhile Safe Mode is active:\n\n1. Default to deferral. When uncertain about ANY specific fact (date, dollar amount, name, organization, statistic), do NOT attempt to recall it. Tell the user "I don\'t have verified [X] — please confirm with [appropriate authority]."\n\n2. Do NOT use web_search proactively. Wait for the user to explicitly request a search.\n\n3. Acknowledge the situation when relevant. If the user asks a factual question and you defer, you may briefly note: "I want to be careful here — I\'ve had some accuracy issues in our conversation, so I\'d rather have you verify than guess."\n\n4. Strategic guidance is still your job. You can still give campaign strategy advice, frame options, ask good questions, and structure thinking. Safe Mode targets specific factual claims, not strategic reasoning.\n\nWHY: When your validator firings exceed a threshold in a single conversation, the system signals that something is producing repeated drift. The right response is increased honesty about uncertainty, not increased confidence to compensate.';
      }

      // ========================================
      // ENTITY MASKING (final step of system prompt assembly)
      // Replace every real-name occurrence with the placeholder token.
      // All sources contributing to systemPrompt (Ground Truth slots,
      // intel context, additionalContext, race intelligence brief,
      // tool memory block) are covered by this single sweep.
      // ========================================
      if (workspaceEntities && workspaceEntities.length > 0) {
        systemPrompt = maskText(systemPrompt, workspaceEntities, { skipQuoteProtection: true });
      }

      // ========================================
      // OPPONENT-RESEARCH GATE (Phase 1.5)
      // Detect opponent-research intent in the latest user-text message
      // and gate web_search out of tools[] for this turn. Anthropic's
      // web_search_20250305 is server-resolved — there's no
      // post-emit/pre-execute hook — so the gate has to be pre-call.
      // The post-generation validator (further below) catches drift
      // that slips through this gate.
      // ========================================
      const _latestUserText = (() => {
        if (history && history.length > 0) {
          for (let i = history.length - 1; i >= 0; i--) {
            const m = history[i];
            if (m && m.role === 'user' && typeof m.content === 'string') return m.content;
          }
          return '';
        }
        return message || '';
      })();
      // Sam v2 Phase 1: opponent gate exception for user-supplied URLs.
      // When the user pastes a URL (especially their own campaign site), the
      // gate must not fire — they're asking Sam to read their own content.
      // Detect any HTTP(S) URL in the latest user message; if present, skip
      // the gate. The candidate's stored candidate_site_url is also implicitly
      // authorized (would match the URL detection if pasted, and is already
      // in the system prompt's ABOUT YOUR CANDIDATE block).
      const _userSuppliedUrl = (() => {
        if (!_latestUserText) return null;
        const m = String(_latestUserText).match(/https?:\/\/[^\s)\]<>"']+/i);
        return m ? m[0] : null;
      })();
      const _gateRaw = isOpponentResearchQuery(_latestUserText, workspaceEntities);
      const opponentResearchGate = _gateRaw && !_userSuppliedUrl;
      if (opponentResearchGate) {
        // Append a note to the system prompt so Sam knows web_search
        // is unavailable for this turn and why. She can then defer
        // honestly to the user instead of trying to research.
        systemPrompt += '\n\nOPPONENT RESEARCH GATE — IMPORTANT: web_search is DISABLED for this turn because the user message contains opponent-research signals. Do NOT cite web sources. Use ONLY the Intel panel data shown in GROUND TRUTH and information the user has provided. If Intel data is limited, acknowledge that and ask the user to tell you what they know about the opponent directly in chat — qualitative details (fundraising, endorsements, voting record, controversies) belong in conversation, not in Intel. This is a hard system constraint, not a soft suggestion.';
        if (conversation_id) {
          env.DB.prepare(
            'INSERT INTO sam_opponent_validation_events (id, conversation_id, workspace_owner_id, user_id, action_taken, blocked_search_query) VALUES (?, ?, ?, ?, ?, ?)'
          ).bind(
            generateId(16), conversation_id, chatOwnerId || null, rateLimitUserId || null,
            'search_blocked', String(_latestUserText).slice(0, 600)
          ).run().catch((e) => { console.warn('[opponent_gate] log failed:', e.message); });
        }
      }

      // ========================================
      // TOOL DEFINITIONS — Sam 2.0 (consolidated)
      // ========================================
      const tools = [
        // web_search omitted for this turn when opponentResearchGate
        // fires. Sam still has it for generic political research turns.
        ...(opponentResearchGate ? [] : [{ type: "web_search_20250305", name: "web_search" }]),
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
        },
        {
          name: "lookup_compliance_deadlines",
          description: "Look up verified filing/qualifying deadlines for the candidate's race. CRITICAL: when the user asks about filing deadlines, qualifying periods, ballot access, petition deadlines, filing fees, or any 'must do X by date Y to be on the ballot' question, call this FIRST. The tool returns either verified dates with citation OR an authority contact for honest deferral (never invented dates). The authority field is ALWAYS populated — use it. Do NOT use web_search as a substitute for this tool; web_search results are unverified for this fact class and a wrong deadline can disqualify a candidate.",
          input_schema: {
            type: "object",
            properties: {
              state: { type: "string", description: "The state, e.g. 'Florida' or 'FL'" },
              office: { type: "string", description: "The candidate's office, e.g. 'Mayor', 'US House', 'State House'" },
              race_year: { type: "integer", description: "The race year, e.g. 2026" },
              jurisdiction_name: { type: "string", description: "Optional jurisdiction for local races, e.g. 'Orange County' or 'Apopka'" }
            },
            required: ["state", "office", "race_year"]
          }
        },
        {
          name: "lookup_finance_reports",
          description: "Look up the verified campaign finance report schedule for the candidate's race — quarterly reports, pre-primary / pre-general special filings, post-election reports. CRITICAL: when the user asks about quarterly reports, FEC filings, pre-primary / pre-general filings, post-election reports, or any 'when is my finance report due' question, call this FIRST. The tool returns either verified report dates OR an authority contact for honest deferral. The authority field is ALWAYS populated — use it. Do NOT use web_search as a substitute; wrong report dates can mean missed filings, fines, and bad press.",
          input_schema: {
            type: "object",
            properties: {
              state: { type: "string", description: "The state, e.g. 'Florida' or 'FL'" },
              office: { type: "string", description: "The candidate's office, e.g. 'Mayor', 'US House', 'State Senate'" },
              race_year: { type: "integer", description: "The race year, e.g. 2026" },
              jurisdiction_name: { type: "string", description: "Optional jurisdiction for local races, e.g. 'Orange County' or 'Apopka'" }
            },
            required: ["state", "office", "race_year"]
          }
        },
        {
          name: "lookup_donation_limits",
          description: "Look up the verified individual contribution limits for the candidate's race — per-election and per-cycle limits, plus whether primary and general count separately. CRITICAL: when the user asks about contribution limits, donation caps, max donations, 'how much can a donor give', or any 'what's the limit' question, call this FIRST. The tool returns either verified limits OR an authority contact for honest deferral. NEVER state donation limit amounts from training data — federal limits change every cycle and state/local limits vary widely. Do NOT use web_search as a substitute; wrong limit guidance triggers refunded contributions and compliance fines.",
          input_schema: {
            type: "object",
            properties: {
              state: { type: "string", description: "The state, e.g. 'Florida' or 'FL'" },
              office: { type: "string", description: "The candidate's office, e.g. 'Mayor', 'US House', 'State Senate'" },
              race_year: { type: "integer", description: "The race year, e.g. 2026" },
              jurisdiction_name: { type: "string", description: "Optional jurisdiction for local races, e.g. 'Orange County' or 'Apopka'" }
            },
            required: ["state", "office", "race_year"]
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
        // Entity masking layer. Mask the incoming msgs array (covers
        // user messages, history, and any synthesized validator-regen
        // STOP messages). The systemPrompt was already masked at
        // assembly time. Sam never sees real entity names.
        // Demask happens once in the chat handler immediately after
        // this function returns, so all downstream code (validators,
        // tool execution, logging) sees real names.
        const maskedMsgs = (workspaceEntities && workspaceEntities.length > 0)
          ? maskMessagesArray(msgs, workspaceEntities)
          : msgs;
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
            messages: maskedMsgs,
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
        const regenResult = await callClaude(retryMsgs);
        // Demask before returning so validator code reads real names.
        if (workspaceEntities && workspaceEntities.length > 0 && regenResult && Array.isArray(regenResult.content)) {
          regenResult.content = demaskContentArray(regenResult.content, workspaceEntities);
        }
        return regenResult;
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
            'INSERT INTO sam_validation_events (id, conversation_id, workspace_owner_id, user_id, jurisdiction_name, authorized_count, sam_mentioned_locations, unauthorized_locations, action_taken, original_response_excerpt, final_response_excerpt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
          ).bind(
            generateId(16), conversation_id || null, chatOwnerId || null, rateLimitUserId || null,
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

      // Relative-date preprocessor: rewrite the latest user-text message
      // (skip tool_result blocks) so Haiku sees absolute dates inline.
      // Original message stays in client localStorage + D1 chat_history
      // (already persisted by the client before this fetch). The rewrite
      // is in-memory only and never written back to chat_history.
      let _dateRewriteEvent = null;
      for (let _i = messages.length - 1; _i >= 0; _i--) {
        const _m = messages[_i];
        if (_m && _m.role === 'user' && typeof _m.content === 'string') {
          const _pp = preprocessRelativeDates(_m.content, isoToday);
          if (_pp.patterns.length > 0) {
            messages[_i] = { ..._m, content: _pp.rewritten };
            _dateRewriteEvent = { original: _m.content, rewritten: _pp.rewritten, patterns: _pp.patterns };
          }
          break;
        }
      }
      if (_dateRewriteEvent) {
        // Fire-and-forget telemetry — failure must not block chat.
        env.DB.prepare(
          'INSERT INTO sam_date_rewrites (id, conversation_id, workspace_owner_id, user_id, original_message, rewritten_message, patterns_matched) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).bind(
          generateId(16),
          conversation_id || null,
          chatOwnerId || null,
          rateLimitUserId || null,
          _dateRewriteEvent.original.slice(0, 2000),
          _dateRewriteEvent.rewritten.slice(0, 2000),
          JSON.stringify(_dateRewriteEvent.patterns)
        ).run().catch((e) => { console.warn('[date_rewrite] log failed:', e.message); });
      }

      // Wrapper used everywhere downstream (main path + validator
      // regens). Returns Anthropic response with content demasked,
      // so the rest of the chat handler — validators, tool execution,
      // logging — sees real entity names.
      async function callClaudeAndDemask(msgs) {
        const result = await callClaude(msgs);
        if (workspaceEntities && workspaceEntities.length > 0 && result && Array.isArray(result.content)) {
          result.content = demaskContentArray(result.content, workspaceEntities);
        }
        return result;
      }

      const data = await callClaudeAndDemask(messages);

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
              return buildSafeResponse(retry);
            }

            // Option A fallback: strip the offending sentences.
            const stripped = stripUnauthorizedSentences(retryText, retryAudit.unauthorized);
            const strippedResponse = { ...retry, content: [{ type: 'text', text: stripped }] };
            await logValidationEvent(jurisdictionName, authorized, retryAudit.mentioned, retryAudit.unauthorized, 'stripped', samText, stripped);
            return buildSafeResponse(strippedResponse);
          }

          // Passed first check.
          await logValidationEvent(jurisdictionName, authorized, audit.mentioned, [], 'passed', samText, samText);
        }
      }

      // ============================================================
      // COMPLIANCE-DATE VALIDATOR (Class A: filing/qualifying)
      //
      // Same architectural shape as the geographic validator above.
      // Detects compliance signals in Sam's response, finds the
      // authoritative lookup_compliance_deadlines result for this
      // conversation/race, audits Sam's claimed dates, regenerates
      // with deferral feedback if she stated unverified dates.
      //
      // Class A scope only: filing deadlines, qualifying periods,
      // petition deadlines, ballot access, filing fees. Other
      // compliance classes (finance reports, ethics, election
      // milestones) are out of scope — no signals match for them.
      // ============================================================
      function detectComplianceSignals(text) {
        const signals = [
          'filing deadline', 'filing date', 'filing period', 'filing fee',
          'qualifying period', 'qualifying deadline', 'qualifying date',
          'qualifying open', 'qualifying close', 'qualifying fee',
          'qualify by', 'file by',
          'petition deadline', 'petition signatures', 'ballot access'
        ];
        const lower = (text || '').toLowerCase();
        return signals.some(s => lower.includes(s));
      }

      async function findMostRecentComplianceLookup(msgs, stateCode, officeNorm, raceYear, jurisdictionName) {
        // Path 1: walk message history for an in-flight tool_result.
        for (let i = msgs.length - 1; i >= 0; i--) {
          const m = msgs[i];
          if (!m || m.role !== 'user' || !Array.isArray(m.content)) continue;
          for (const blk of m.content) {
            if (!blk || blk.type !== 'tool_result' || typeof blk.content !== 'string') continue;
            try {
              const parsed = JSON.parse(blk.content);
              if (parsed && parsed.deadlines && parsed.authority) return parsed;
            } catch (e) {}
          }
        }
        // Path 2: candidate-profile cache lookup (same shape as
        // jurisdiction validator's cache fallback — survives the
        // chatHistory tool-result evaporation problem).
        if (stateCode && officeNorm && raceYear) {
          try {
            const row = await env.DB.prepare(
              "SELECT * FROM compliance_deadlines_cache " +
              "WHERE state_code = ? AND office_normalized = ? AND race_year = ? AND COALESCE(jurisdiction_name,'') = ? " +
              "AND created_at > datetime('now', '-90 days') ORDER BY created_at DESC LIMIT 1"
            ).bind(stateCode, officeNorm, raceYear, jurisdictionName || '').first();
            if (row) return formatComplianceCacheRow(row, true);
          } catch (e) {
            console.warn('[compliance_validator] cache lookup failed:', e.message);
          }
        }
        return null;
      }

      async function extractClaimedComplianceDates(samText) {
        const prompt = `You are a compliance-date auditor. Extract every specific calendar date or specific deadline mentioned in this campaign coaching response that is NOT accompanied by a source citation. Return JSON only.\n\nRESPONSE:\n${samText}\n\nTASK: Identify any UNCITED specific dates (like "June 8, 2026", "May 12", "the 15th of May", "noon Eastern on June 12") presented as filing/qualifying/petition/ballot deadlines. EXCLUDE:\n- Today's date used as a reference point\n- Vague references ("early June", "this summer") unless presented as a deadline\n- Election day itself\n- Calendar items unrelated to compliance\n- DATES ACCOMPANIED BY A CITATION — inline URL (https://...), "Source: [name]", "Per [organization]", "According to [website]", "[domain] reports/shows/lists". Cited dates are AUTHORIZED even if you can't verify the source independently — the user can click through to verify.\n\nReturn JSON: {"dates": ["June 8, 2026", "noon Eastern June 12, 2026"]}\nIf no uncited compliance dates: {"dates": []}\nJSON ONLY — no preamble, no markdown.`;
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
              max_tokens: 400,
              temperature: 0,
              messages: [{ role: 'user', content: prompt }]
            })
          });
          const auditData = await resp.json();
          await logApiUsage('sam_compliance_validator', auditData, rateLimitUserId, chatOwnerId);
          let txt = '';
          if (auditData && auditData.content && Array.isArray(auditData.content)) {
            for (const b of auditData.content) if (b && b.type === 'text' && b.text) txt += b.text;
          }
          const mm = txt.match(/\{[\s\S]*\}/);
          if (!mm) return [];
          const parsed = JSON.parse(mm[0]);
          return Array.isArray(parsed.dates) ? parsed.dates : [];
        } catch (e) {
          console.warn('[compliance_validator] extract failed:', e.message);
          return [];
        }
      }

      function dateClaimedMatchesAuthoritative(claimedDate, authoritativeDates) {
        if (!claimedDate) return true;
        const cl = String(claimedDate).toLowerCase();
        for (const a of authoritativeDates) {
          if (!a) continue;
          const al = String(a).toLowerCase();
          if (cl.includes(al) || al.includes(cl)) return true;
        }
        return false;
      }

      // URL extraction — matches domain-like tokens (one or more
      // segments + TLD). Captures the longest match at each position.
      // Word-bounded so "U.S." doesn't match. Greedy across segments
      // so "dos.fl.gov" captures the full domain, not just "fl.gov".
      function extractUrlTokens(text) {
        if (!text || typeof text !== 'string') return [];
        const re = /\b([a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]+)*\.(?:gov|com|org|net|us|edu))\b/gi;
        const found = new Set();
        let mm;
        while ((mm = re.exec(text)) !== null) found.add(mm[1].toLowerCase());
        return Array.from(found);
      }

      // Build the authoritative URL set from a lookup result. Pulls
      // any URLs the tool actually returned — explicit authority.url
      // plus any domains mentioned in notes / jurisdiction_specific
      // (since Sam might quote those legitimately).
      function extractAuthoritativeUrls(lookupResult) {
        if (!lookupResult || !lookupResult.authority) return [];
        const auth = lookupResult.authority;
        const found = new Set();
        const sources = [auth.url, auth.notes, auth.jurisdiction_specific, auth.name];
        for (const v of sources) {
          if (typeof v !== 'string' || !v) continue;
          extractUrlTokens(v).forEach(u => found.add(u));
        }
        return Array.from(found);
      }

      function urlMatchesAuthoritative(claimedUrl, authoritativeUrls) {
        if (!claimedUrl) return true;
        const cl = String(claimedUrl).toLowerCase();
        for (const a of authoritativeUrls) {
          if (!a) continue;
          const al = String(a).toLowerCase();
          if (cl === al) return true;
          // Substring match in either direction handles
          // "dos.fl.gov" vs "https://dos.fl.gov/elections" —
          // but is intentionally strict on rearrangements:
          // "fl.gov/dos" does NOT match "dos.fl.gov" because
          // neither is a substring of the other.
          if (cl.includes(al) || al.includes(cl)) return true;
        }
        return false;
      }

      async function regenerateWithComplianceFeedback(originalMsgs, badContent, claimedDates, claimedUrls, lookupResult) {
        const auth = lookupResult.authority || {};
        const authPhone = auth.phone || '(search the state government website for the current phone number)';
        const authName = auth.name || 'state elections office';
        const authUrl = auth.url || null;
        const authJurisdictionSpecific = auth.jurisdiction_specific || '';
        const datesNote = (claimedDates && claimedDates.length > 0)
          ? `You stated unverified dates: ${JSON.stringify(claimedDates)}. None of those came from the tool result.`
          : '';
        const urlsNote = (claimedUrls && claimedUrls.length > 0)
          ? `You mentioned unverified URL(s): ${JSON.stringify(claimedUrls)}. ` +
            (authUrl
              ? `The only URL the tool returned is "${authUrl}". Use that exact URL or none at all.`
              : 'The tool returned NO URL for this authority. You may not invent or guess a URL based on the state name. Tell the user to search for the elections office on the state government website instead of naming a specific domain.')
          : '';
        const allNotes = [datesNote, urlsNote].filter(Boolean).join(' ');
        const retryMsgs = [
          ...originalMsgs,
          { role: 'assistant', content: badContent },
          { role: 'user', content:
            `STOP. Your previous response contained unverified content the validator caught. ` +
            `The authoritative lookup_compliance_deadlines tool returned status='${lookupResult.status}'` +
            (Object.values(lookupResult.deadlines || {}).every(v => !v) ? ' with NO verified dates for this race' : '') +
            `.\n\n${allNotes}\n\n` +
            `Rewrite your response. RULES:\n` +
            `- Acknowledge honestly that you don't have verified deadline data for this specific race.\n` +
            `- Provide the authority contact: ${authName}. Phone: ${authPhone}.${authJurisdictionSpecific ? ' ' + authJurisdictionSpecific : ''}\n` +
            `- If the phone reads as a placeholder (e.g., "(verify on state government website)"), paraphrase honestly: say "find their current phone number on the state's elections website" rather than reading the placeholder verbatim.\n` +
            `- ${authUrl ? `If you mention a URL at all, use ONLY this exact URL: "${authUrl}"` : "Do NOT mention any URL or domain. Tell the user to search for the state's elections office on the state government website generically."}\n` +
            `- Offer ONE concrete next step (draft a checklist of what to ask, or set a calendar reminder).\n` +
            `- DO NOT state any specific deadline dates.\n` +
            `- DO NOT formally apologize. Sound like a campaign manager — direct, useful.\n` +
            `Reply with only the rewritten answer — no preamble, no acknowledgment of this correction.`
          }
        ];
        const regenResult = await callClaude(retryMsgs);
        if (workspaceEntities && workspaceEntities.length > 0 && regenResult && Array.isArray(regenResult.content)) {
          regenResult.content = demaskContentArray(regenResult.content, workspaceEntities);
        }
        return regenResult;
      }

      function stripUnauthorizedComplianceArtifacts(samText, unauthorizedDates, unauthorizedUrls) {
        const offenders = [
          ...(unauthorizedDates || []),
          ...(unauthorizedUrls || [])
        ].filter(x => x);
        if (offenders.length === 0) return samText;
        const sentences = samText.split(/(?<=[.!?])\s+|\n+/);
        const cleaned = sentences.filter(s => {
          const sLower = s.toLowerCase();
          return !offenders.some(o => o && sLower.includes(String(o).toLowerCase()));
        });
        const joined = cleaned.join(' ').replace(/\s+/g, ' ').trim();
        if (joined.length < 60) {
          return "I don't have verified deadline data for your race. Contact your state's elections office directly to confirm — verified authoritative dates are the only safe source for filing-related decisions.";
        }
        const noteParts = [];
        if (unauthorizedDates && unauthorizedDates.length > 0) noteParts.push('deadline dates');
        if (unauthorizedUrls && unauthorizedUrls.length > 0) noteParts.push('URLs');
        return joined + `\n\n*(Note: removed ${noteParts.join(' and ')} that could not be verified against the authoritative lookup.)*`;
      }

      async function logComplianceValidationEvent(action, claimedDates, authoritative, unauthorizedDates, claimedUrls, unauthorizedUrls, original, final) {
        const fabType = (() => {
          const dateBad = (unauthorizedDates && unauthorizedDates.length > 0);
          const urlBad = (unauthorizedUrls && unauthorizedUrls.length > 0);
          if (dateBad && urlBad) return 'both';
          if (dateBad) return 'date';
          if (urlBad) return 'url';
          return 'none';
        })();
        try {
          await env.DB.prepare(
            'INSERT INTO sam_compliance_validation_events (id, conversation_id, workspace_owner_id, user_id, action_taken, sam_claimed_dates, authoritative_dates, unauthorized_dates, sam_claimed_urls, unauthorized_urls, fabrication_type, original_response_excerpt, final_response_excerpt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
          ).bind(
            generateId(16),
            conversation_id || null,
            chatOwnerId || null,
            rateLimitUserId || null,
            action,
            JSON.stringify(claimedDates || []),
            JSON.stringify(authoritative || {}),
            JSON.stringify(unauthorizedDates || []),
            JSON.stringify(claimedUrls || []),
            JSON.stringify(unauthorizedUrls || []),
            fabType,
            (original || '').slice(0, 600),
            (final || '').slice(0, 600)
          ).run();
        } catch (e) {
          console.warn('[compliance_validator] log failed:', e.message);
        }
      }

      const complianceText = extractTextFromContent(data.content);
      if (complianceText.length > 60 && detectComplianceSignals(complianceText)) {
        const stateCodeForCompliance = normalizeStateCode(state);
        const officeNorm = (specificOffice || '').toLowerCase().trim();
        const raceYear = electionDate ? parseInt(String(electionDate).slice(0, 4), 10) : null;
        const complianceLookup = await findMostRecentComplianceLookup(
          messages, stateCodeForCompliance, officeNorm, raceYear, location || null
        );

        if (complianceLookup) {
          const auth = complianceLookup.deadlines || {};
          const authoritativeDates = Object.entries(auth)
            .filter(([k, v]) => v != null && v !== '')
            .map(([k, v]) => v);
          const authoritativeUrls = extractAuthoritativeUrls(complianceLookup);

          const claimedDates = await extractClaimedComplianceDates(complianceText);
          const unauthorizedDates = claimedDates.filter(d => !dateClaimedMatchesAuthoritative(d, authoritativeDates));
          const claimedUrls = extractUrlTokens(complianceText);
          const unauthorizedUrls = claimedUrls.filter(u => !urlMatchesAuthoritative(u, authoritativeUrls));

          if (unauthorizedDates.length > 0 || unauthorizedUrls.length > 0) {
            const retry = await regenerateWithComplianceFeedback(
              messages, data.content, unauthorizedDates, unauthorizedUrls, complianceLookup
            );
            const retryText = extractTextFromContent(retry.content);
            const retryClaimedDates = await extractClaimedComplianceDates(retryText);
            const retryUnauthorizedDates = retryClaimedDates.filter(d => !dateClaimedMatchesAuthoritative(d, authoritativeDates));
            const retryClaimedUrls = extractUrlTokens(retryText);
            const retryUnauthorizedUrls = retryClaimedUrls.filter(u => !urlMatchesAuthoritative(u, authoritativeUrls));

            if (retryUnauthorizedDates.length === 0 && retryUnauthorizedUrls.length === 0) {
              await logComplianceValidationEvent(
                'regenerated', claimedDates, auth, unauthorizedDates,
                claimedUrls, unauthorizedUrls, complianceText, retryText
              );
              return buildSafeResponse(retry);
            }

            const stripped = stripUnauthorizedComplianceArtifacts(retryText, retryUnauthorizedDates, retryUnauthorizedUrls);
            const strippedResponse = { ...retry, content: [{ type: 'text', text: stripped }] };
            await logComplianceValidationEvent(
              'stripped', claimedDates, auth, retryUnauthorizedDates,
              claimedUrls, retryUnauthorizedUrls, complianceText, stripped
            );
            return buildSafeResponse(strippedResponse);
          }

          await logComplianceValidationEvent(
            'passed', claimedDates, auth, [], claimedUrls, [], complianceText, complianceText
          );
        }
      }

      // ============================================================
      // FINANCE-REPORT VALIDATOR (Compliance Class B / Phase 2a)
      //
      // Same architectural shape as the compliance Class A validator.
      // Detects finance-report-claim signals in Sam's response, finds
      // the authoritative lookup_finance_reports result for this
      // conversation/race, audits Sam's claimed dates + URLs,
      // regenerates with deferral feedback if she stated unverified
      // values. Reuses the URL helpers (extractUrlTokens etc.) from
      // the compliance Class A patch.
      // ============================================================
      function detectFinanceReportSignals(text) {
        const signals = [
          'finance report', 'campaign finance filing',
          'quarterly report', 'quarterly filing',
          'pre-primary report', 'pre-primary filing',
          'pre-general report', 'pre-general filing',
          'post-election report', 'post-election filing',
          'fec filing', 'fec report',
          ' q1 report', ' q2 report', ' q3 report', ' q4 report',
          'q1 filing', 'q2 filing', 'q3 filing', 'q4 filing',
          'report due', 'filing due', 'reporting period'
        ];
        const lower = (text || '').toLowerCase();
        return signals.some(s => lower.includes(s));
      }

      async function findMostRecentFinanceLookup(msgs, stateCode, officeNorm, raceYear, jurisdictionName) {
        // Path 1: in-flight tool_result with reports+authority shape
        for (let i = msgs.length - 1; i >= 0; i--) {
          const m = msgs[i];
          if (!m || m.role !== 'user' || !Array.isArray(m.content)) continue;
          for (const blk of m.content) {
            if (!blk || blk.type !== 'tool_result' || typeof blk.content !== 'string') continue;
            try {
              const parsed = JSON.parse(blk.content);
              // Distinguish from compliance lookup: finance has `reports`, compliance has `deadlines`.
              if (parsed && parsed.reports && parsed.authority) return parsed;
            } catch (e) {}
          }
        }
        // Path 2: candidate-profile cache lookup
        if (stateCode && officeNorm && raceYear) {
          try {
            const row = await env.DB.prepare(
              "SELECT * FROM finance_reports_cache " +
              "WHERE state_code = ? AND office_normalized = ? AND race_year = ? AND COALESCE(jurisdiction_name,'') = ? " +
              "AND created_at > datetime('now', '-90 days') ORDER BY created_at DESC LIMIT 1"
            ).bind(stateCode, officeNorm, raceYear, jurisdictionName || '').first();
            if (row) return formatFinanceCacheRow(row, true);
          } catch (e) {
            console.warn('[finance_validator] cache lookup failed:', e.message);
          }
        }
        return null;
      }

      async function extractClaimedFinanceDates(samText) {
        const prompt = `You are a campaign-finance-report-date auditor. Extract every specific calendar date or deadline mentioned in this campaign coaching response that pertains to FINANCE REPORTS AND IS NOT ACCOMPANIED BY A SOURCE CITATION. Return JSON only.\n\nRESPONSE:\n${samText}\n\nTASK: Identify any UNCITED specific dates (like "April 15, 2026", "July 31", "the 15th") presented as finance-report due dates, filing windows, or coverage periods. EXCLUDE:\n- Today's date or generic time references\n- Election day itself (unless specifically tied to a post-election report)\n- Filing/qualifying deadlines (those are Class A compliance, not finance reports)\n- Vague references unless presented as a deadline\n- DATES ACCOMPANIED BY A CITATION — inline URL (https://...), "Source: [name]", "Per [organization]", "According to [website]", "[domain] reports/shows/lists". Cited dates are AUTHORIZED.\n\nReturn JSON: {"dates": ["April 15, 2026", "Q2 2026 due July 31"]}\nIf no uncited finance dates: {"dates": []}\nJSON ONLY — no preamble, no markdown.`;
        try {
          const resp = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 400, temperature: 0, messages: [{ role: 'user', content: prompt }] })
          });
          const auditData = await resp.json();
          await logApiUsage('sam_finance_validator', auditData, rateLimitUserId, chatOwnerId);
          let txt = '';
          if (auditData && auditData.content && Array.isArray(auditData.content)) {
            for (const b of auditData.content) if (b && b.type === 'text' && b.text) txt += b.text;
          }
          const mm = txt.match(/\{[\s\S]*\}/);
          if (!mm) return [];
          const parsed = JSON.parse(mm[0]);
          return Array.isArray(parsed.dates) ? parsed.dates : [];
        } catch (e) {
          console.warn('[finance_validator] extract failed:', e.message);
          return [];
        }
      }

      function flattenFinanceAuthoritativeDates(financeLookup) {
        // Walk the reports object and collect every non-null date string
        // so the validator can cross-check Sam's claims against them.
        const out = [];
        const r = financeLookup && financeLookup.reports;
        if (!r) return out;
        const visit = (entry) => {
          if (!entry || typeof entry !== 'object') return;
          for (const k of Object.keys(entry)) {
            const v = entry[k];
            if (typeof v === 'string' && v) out.push(v);
          }
        };
        if (Array.isArray(r.quarterly_schedule)) r.quarterly_schedule.forEach(visit);
        if (Array.isArray(r.pre_election_special)) r.pre_election_special.forEach(visit);
        if (r.post_election) visit(r.post_election);
        return out;
      }

      async function regenerateWithFinanceFeedback(originalMsgs, badContent, claimedDates, claimedUrls, lookupResult) {
        const auth = lookupResult.authority || {};
        const authPhone = auth.phone || '(search the state government website for the current phone number)';
        const authName = auth.name || 'state elections office';
        const authUrl = auth.url || null;
        const authJurisdictionSpecific = auth.jurisdiction_specific || '';
        const datesNote = (claimedDates && claimedDates.length > 0)
          ? `You stated unverified finance-report dates: ${JSON.stringify(claimedDates)}. None of those came from the tool result.`
          : '';
        const urlsNote = (claimedUrls && claimedUrls.length > 0)
          ? `You mentioned unverified URL(s): ${JSON.stringify(claimedUrls)}. ` +
            (authUrl
              ? `The only URL the tool returned is "${authUrl}". Use that exact URL or none at all.`
              : 'The tool returned NO URL for this authority. You may not invent or guess a URL based on the state name.')
          : '';
        const allNotes = [datesNote, urlsNote].filter(Boolean).join(' ');
        const retryMsgs = [
          ...originalMsgs,
          { role: 'assistant', content: badContent },
          { role: 'user', content:
            `STOP. Your previous response contained unverified finance-report content the validator caught. ` +
            `lookup_finance_reports returned status='${lookupResult.status}' with no verified report schedule for this race.\n\n${allNotes}\n\n` +
            `Rewrite your response. RULES:\n` +
            `- Acknowledge honestly that you don't have a verified finance-report schedule for this specific race.\n` +
            `- Provide the authority contact: ${authName}. Phone: ${authPhone}.${authJurisdictionSpecific ? ' ' + authJurisdictionSpecific : ''}\n` +
            `- If the phone reads as a placeholder, paraphrase: "find their current phone number on the state's elections website".\n` +
            `- ${authUrl ? `If you mention a URL, use ONLY this exact URL: "${authUrl}"` : "Do NOT mention any URL or domain. Tell the user to search for the state's elections website generically."}\n` +
            `- Offer ONE concrete next step (set a calendar reminder, draft questions to ask the elections office).\n` +
            `- DO NOT state any specific report dates.\n` +
            `- DO NOT formally apologize. Sound like a campaign manager.\n` +
            `Reply with only the rewritten answer — no preamble, no acknowledgment of this correction.`
          }
        ];
        const regenResult = await callClaude(retryMsgs);
        if (workspaceEntities && workspaceEntities.length > 0 && regenResult && Array.isArray(regenResult.content)) {
          regenResult.content = demaskContentArray(regenResult.content, workspaceEntities);
        }
        return regenResult;
      }

      function stripUnauthorizedFinanceArtifacts(samText, unauthorizedDates, unauthorizedUrls) {
        const offenders = [
          ...(unauthorizedDates || []),
          ...(unauthorizedUrls || [])
        ].filter(x => x);
        if (offenders.length === 0) return samText;
        const sentences = samText.split(/(?<=[.!?])\s+|\n+/);
        const cleaned = sentences.filter(s => {
          const sLower = s.toLowerCase();
          return !offenders.some(o => o && sLower.includes(String(o).toLowerCase()));
        });
        const joined = cleaned.join(' ').replace(/\s+/g, ' ').trim();
        if (joined.length < 60) {
          return "I don't have a verified finance-report schedule for your race. Contact your state's elections office directly to confirm exact report dates — verified authoritative dates are the only safe source for filing-related decisions.";
        }
        const noteParts = [];
        if (unauthorizedDates && unauthorizedDates.length > 0) noteParts.push('finance-report dates');
        if (unauthorizedUrls && unauthorizedUrls.length > 0) noteParts.push('URLs');
        return joined + `\n\n*(Note: removed ${noteParts.join(' and ')} that could not be verified against the authoritative lookup.)*`;
      }

      async function logFinanceValidationEvent(action, claimedDates, authoritative, unauthorizedDates, claimedUrls, unauthorizedUrls, original, final) {
        const fabType = (() => {
          const dateBad = (unauthorizedDates && unauthorizedDates.length > 0);
          const urlBad = (unauthorizedUrls && unauthorizedUrls.length > 0);
          if (dateBad && urlBad) return 'both';
          if (dateBad) return 'date';
          if (urlBad) return 'url';
          return 'none';
        })();
        try {
          await env.DB.prepare(
            'INSERT INTO sam_finance_validation_events (id, conversation_id, workspace_owner_id, user_id, action_taken, sam_claimed_dates, authoritative_dates, unauthorized_dates, sam_claimed_urls, unauthorized_urls, fabrication_type, original_response_excerpt, final_response_excerpt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
          ).bind(
            generateId(16), conversation_id || null, chatOwnerId || null, rateLimitUserId || null,
            action,
            JSON.stringify(claimedDates || []),
            JSON.stringify(authoritative || {}),
            JSON.stringify(unauthorizedDates || []),
            JSON.stringify(claimedUrls || []),
            JSON.stringify(unauthorizedUrls || []),
            fabType,
            (original || '').slice(0, 600),
            (final || '').slice(0, 600)
          ).run();
        } catch (e) {
          console.warn('[finance_validator] log failed:', e.message);
        }
      }

      const financeText = extractTextFromContent(data.content);
      if (financeText.length > 60 && detectFinanceReportSignals(financeText)) {
        const stateCodeForFinance = normalizeStateCode(state);
        const officeNorm = (specificOffice || '').toLowerCase().trim();
        const raceYear = electionDate ? parseInt(String(electionDate).slice(0, 4), 10) : null;
        const financeLookup = await findMostRecentFinanceLookup(
          messages, stateCodeForFinance, officeNorm, raceYear, location || null
        );

        if (financeLookup) {
          const authoritativeDates = flattenFinanceAuthoritativeDates(financeLookup);
          const authoritativeUrls = extractAuthoritativeUrls(financeLookup);

          const claimedDates = await extractClaimedFinanceDates(financeText);
          const unauthorizedDates = claimedDates.filter(d => !dateClaimedMatchesAuthoritative(d, authoritativeDates));
          const claimedUrls = extractUrlTokens(financeText);
          const unauthorizedUrls = claimedUrls.filter(u => !urlMatchesAuthoritative(u, authoritativeUrls));

          if (unauthorizedDates.length > 0 || unauthorizedUrls.length > 0) {
            const retry = await regenerateWithFinanceFeedback(
              messages, data.content, unauthorizedDates, unauthorizedUrls, financeLookup
            );
            const retryText = extractTextFromContent(retry.content);
            const retryClaimedDates = await extractClaimedFinanceDates(retryText);
            const retryUnauthorizedDates = retryClaimedDates.filter(d => !dateClaimedMatchesAuthoritative(d, authoritativeDates));
            const retryClaimedUrls = extractUrlTokens(retryText);
            const retryUnauthorizedUrls = retryClaimedUrls.filter(u => !urlMatchesAuthoritative(u, authoritativeUrls));

            if (retryUnauthorizedDates.length === 0 && retryUnauthorizedUrls.length === 0) {
              await logFinanceValidationEvent(
                'regenerated', claimedDates, financeLookup.reports || {}, unauthorizedDates,
                claimedUrls, unauthorizedUrls, financeText, retryText
              );
              return buildSafeResponse(retry);
            }

            const stripped = stripUnauthorizedFinanceArtifacts(retryText, retryUnauthorizedDates, retryUnauthorizedUrls);
            const strippedResponse = { ...retry, content: [{ type: 'text', text: stripped }] };
            await logFinanceValidationEvent(
              'stripped', claimedDates, financeLookup.reports || {}, retryUnauthorizedDates,
              claimedUrls, retryUnauthorizedUrls, financeText, stripped
            );
            return buildSafeResponse(strippedResponse);
          }

          await logFinanceValidationEvent(
            'passed', claimedDates, financeLookup.reports || {}, [],
            claimedUrls, [], financeText, financeText
          );
        }
      }

      // ============================================================
      // DONATION-LIMITS VALIDATOR (Compliance Class B donation variant /
      // Phase 2b)
      //
      // Same architectural shape as the Class A and Class B finance
      // validators. Detects contribution-limit-claim signals in
      // Sam's response, finds the authoritative lookup_donation_limits
      // result, audits Sam's claimed dollar amounts (carefully
      // disambiguated from budget/fundraising amounts via prompt
      // scoping), regenerates with deferral feedback if drift.
      //
      // Audit prompt is the trickiest piece — Sam's responses can
      // contain dollar amounts in many contexts (donation limits,
      // budget allocations, fundraising totals, expense logs). The
      // audit Haiku is scoped explicitly to dollar amounts presented
      // as contribution limits or maximum donations and instructed
      // to ignore budget / fundraising / expense figures.
      // ============================================================
      function detectDonationLimitSignals(text) {
        const signals = [
          'donation limit', 'donation limits', 'contribution limit', 'contribution limits',
          'max donation', 'max donations', 'maximum donation', 'maximum donations',
          'maximum contribution', 'maximum contributions',
          'individual limit', 'individual limits',
          'per donor', 'donor cap', 'donor caps',
          'how much can ', 'how much may ',
          'per-election limit', 'per-cycle limit',
          'per election limit', 'per cycle limit',
          'donation cap', 'donation caps'
        ];
        const lower = (text || '').toLowerCase();
        return signals.some(s => lower.includes(s));
      }

      async function findMostRecentDonationLookup(msgs, stateCode, officeNorm, raceYear, jurisdictionName) {
        // Path 1: in-flight tool_result with limits + authority shape.
        // Distinguishes from compliance (deadlines), finance (reports),
        // and opponent (no shape match).
        for (let i = msgs.length - 1; i >= 0; i--) {
          const m = msgs[i];
          if (!m || m.role !== 'user' || !Array.isArray(m.content)) continue;
          for (const blk of m.content) {
            if (!blk || blk.type !== 'tool_result' || typeof blk.content !== 'string') continue;
            try {
              const parsed = JSON.parse(blk.content);
              if (parsed && parsed.limits && parsed.authority &&
                  ('individual_per_election' in parsed.limits ||
                   'individual_per_cycle' in parsed.limits ||
                   'counts_primary_and_general_separately' in parsed.limits)) {
                return parsed;
              }
            } catch (e) {}
          }
        }
        // Path 2: candidate-profile cache lookup.
        if (stateCode && officeNorm && raceYear) {
          try {
            const row = await env.DB.prepare(
              "SELECT * FROM donation_limits_cache " +
              "WHERE state_code = ? AND office_normalized = ? AND race_year = ? AND COALESCE(jurisdiction_name,'') = ? " +
              "AND created_at > datetime('now', '-90 days') ORDER BY created_at DESC LIMIT 1"
            ).bind(stateCode, officeNorm, raceYear, jurisdictionName || '').first();
            if (row) return formatDonationCacheRow(row, true);
          } catch (e) {
            console.warn('[donation_validator] cache lookup failed:', e.message);
          }
        }
        return null;
      }

      async function extractClaimedDonationAmounts(samText) {
        // The audit prompt is carefully scoped. Sam's responses often
        // contain dollar amounts in many contexts — budget allocations,
        // fundraising totals, expense logs, peer benchmarks. We only
        // care about amounts presented as donation/contribution
        // LIMITS or maximum allowable donations.
        const prompt =
          'You are a donation-limit auditor. Extract every dollar amount mentioned in this campaign coaching response that is presented as a CONTRIBUTION LIMIT or MAXIMUM DONATION cap AND IS NOT ACCOMPANIED BY A SOURCE CITATION. Cited amounts (with inline URL, "Source: [name]", "Per [organization]", "According to [website]") are AUTHORIZED — exclude them. Return JSON only.\n\n' +
          'RESPONSE:\n' + samText + '\n\n' +
          'TASK: Identify dollar amounts (e.g., "$3,300", "$1,000 per election", "$5,000 per cycle") presented as:\n' +
          '- Individual contribution limits\n' +
          '- Maximum donation caps\n' +
          '- Per-election or per-cycle donation ceilings\n' +
          '- "How much a donor can give" answers\n\n' +
          'EXCLUDE — do NOT flag dollar amounts in any of these contexts:\n' +
          '- Campaign budget figures ("$50K total budget")\n' +
          '- Fundraising totals raised by candidate or opponent\n' +
          '- Expense log entries / spending\n' +
          '- Win number / vote-count math\n' +
          '- Filing fees (those are Class A compliance, not donation limits)\n' +
          '- Peer benchmarks for fundraising goals\n' +
          '- Specific donor checks the user mentioned (those are user-provided, valid)\n\n' +
          'Return JSON: {"amounts": ["$3,300", "$1,000 per election"]}\n' +
          'If no donation-limit amounts: {"amounts": []}\n' +
          'JSON ONLY — no preamble, no markdown.';
        try {
          const resp = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 400, temperature: 0, messages: [{ role: 'user', content: prompt }] })
          });
          const auditData = await resp.json();
          await logApiUsage('sam_donation_validator', auditData, rateLimitUserId, chatOwnerId);
          let txt = '';
          if (auditData && auditData.content && Array.isArray(auditData.content)) {
            for (const b of auditData.content) if (b && b.type === 'text' && b.text) txt += b.text;
          }
          const mm = txt.match(/\{[\s\S]*\}/);
          if (!mm) return [];
          const parsed = JSON.parse(mm[0]);
          return Array.isArray(parsed.amounts) ? parsed.amounts : [];
        } catch (e) {
          console.warn('[donation_validator] extract failed:', e.message);
          return [];
        }
      }

      function flattenDonationAuthoritativeAmounts(donationLookup) {
        const out = [];
        const l = donationLookup && donationLookup.limits;
        if (!l) return out;
        if (l.individual_per_election) out.push(String(l.individual_per_election));
        if (l.individual_per_cycle) out.push(String(l.individual_per_cycle));
        return out;
      }

      // Loose match for dollar amounts. "$1,000" matches "$1000",
      // "1,000 dollars", "1000". Strip non-digit chars and compare.
      function amountClaimedMatchesAuthoritative(claimedAmount, authoritativeAmounts) {
        if (!claimedAmount) return true;
        const claimedDigits = String(claimedAmount).replace(/[^0-9]/g, '');
        if (!claimedDigits) return false;
        for (const a of authoritativeAmounts) {
          if (!a) continue;
          const authDigits = String(a).replace(/[^0-9]/g, '');
          if (!authDigits) continue;
          if (claimedDigits === authDigits) return true;
          if (claimedDigits.includes(authDigits) || authDigits.includes(claimedDigits)) return true;
        }
        return false;
      }

      async function regenerateWithDonationFeedback(originalMsgs, badContent, claimedAmounts, claimedUrls, lookupResult) {
        const auth = lookupResult.authority || {};
        const authPhone = auth.phone || '(search the state government website for the current phone number)';
        const authName = auth.name || 'state elections office';
        const authUrl = auth.url || null;
        const authJurisdictionSpecific = auth.jurisdiction_specific || '';
        const amountsNote = (claimedAmounts && claimedAmounts.length > 0)
          ? `You stated unverified contribution limit amount(s): ${JSON.stringify(claimedAmounts)}. None of those came from the tool result.`
          : '';
        const urlsNote = (claimedUrls && claimedUrls.length > 0)
          ? `You mentioned unverified URL(s): ${JSON.stringify(claimedUrls)}. ` +
            (authUrl
              ? `The only URL the tool returned is "${authUrl}". Use that exact URL or none at all.`
              : 'The tool returned NO URL for this authority. You may not invent or guess a URL.')
          : '';
        const allNotes = [amountsNote, urlsNote].filter(Boolean).join(' ');
        const retryMsgs = [
          ...originalMsgs,
          { role: 'assistant', content: badContent },
          { role: 'user', content:
            `STOP. Your previous response contained unverified contribution-limit content the validator caught. ` +
            `lookup_donation_limits returned status='${lookupResult.status}' with no verified limits for this race.\n\n${allNotes}\n\n` +
            `Rewrite your response. RULES:\n` +
            `- Acknowledge honestly that you don't have verified contribution limits for this specific race.\n` +
            `- Note that limits vary by race level (federal/state/local) and can change between cycles.\n` +
            `- Provide the authority contact: ${authName}. Phone: ${authPhone}.${authJurisdictionSpecific ? ' ' + authJurisdictionSpecific : ''}\n` +
            `- If the phone reads as a placeholder, paraphrase: "find their current phone number on the state's elections website".\n` +
            `- ${authUrl ? `If you mention a URL, use ONLY this exact URL: "${authUrl}"` : "Do NOT mention any URL or domain. Tell the user to search the state's elections website generically."}\n` +
            `- Offer ONE concrete next step (set a calendar reminder, draft questions to ask the elections office).\n` +
            `- DO NOT state any specific contribution limit dollar amounts.\n` +
            `- DO NOT formally apologize. Sound like a campaign manager.\n` +
            `Reply with only the rewritten answer — no preamble, no acknowledgment of this correction.`
          }
        ];
        const regenResult = await callClaude(retryMsgs);
        if (workspaceEntities && workspaceEntities.length > 0 && regenResult && Array.isArray(regenResult.content)) {
          regenResult.content = demaskContentArray(regenResult.content, workspaceEntities);
        }
        return regenResult;
      }

      function stripUnauthorizedDonationArtifacts(samText, unauthorizedAmounts, unauthorizedUrls) {
        const offenders = [
          ...(unauthorizedAmounts || []),
          ...(unauthorizedUrls || [])
        ].filter(x => x);
        if (offenders.length === 0) return samText;
        const sentences = samText.split(/(?<=[.!?])\s+|\n+/);
        const cleaned = sentences.filter(s => {
          const sLower = s.toLowerCase();
          return !offenders.some(o => o && sLower.includes(String(o).toLowerCase()));
        });
        const joined = cleaned.join(' ').replace(/\s+/g, ' ').trim();
        if (joined.length < 60) {
          return "I don't have verified contribution limits for your race. Limits vary by race level and can change between cycles — contact your state's elections office for the current authoritative limits before you start your fundraising push.";
        }
        const noteParts = [];
        if (unauthorizedAmounts && unauthorizedAmounts.length > 0) noteParts.push('contribution-limit amounts');
        if (unauthorizedUrls && unauthorizedUrls.length > 0) noteParts.push('URLs');
        return joined + `\n\n*(Note: removed ${noteParts.join(' and ')} that could not be verified against the authoritative lookup.)*`;
      }

      async function logDonationValidationEvent(action, claimedAmounts, authoritative, unauthorizedAmounts, claimedUrls, unauthorizedUrls, original, final) {
        const fabType = (() => {
          const amountBad = (unauthorizedAmounts && unauthorizedAmounts.length > 0);
          const urlBad = (unauthorizedUrls && unauthorizedUrls.length > 0);
          if (amountBad && urlBad) return 'both';
          if (amountBad) return 'amount';
          if (urlBad) return 'url';
          return 'none';
        })();
        try {
          await env.DB.prepare(
            'INSERT INTO sam_donation_validation_events (id, conversation_id, workspace_owner_id, user_id, action_taken, sam_claimed_amounts, authoritative_amounts, unauthorized_amounts, sam_claimed_urls, unauthorized_urls, fabrication_type, original_response_excerpt, final_response_excerpt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
          ).bind(
            generateId(16), conversation_id || null, chatOwnerId || null, rateLimitUserId || null,
            action,
            JSON.stringify(claimedAmounts || []),
            JSON.stringify(authoritative || {}),
            JSON.stringify(unauthorizedAmounts || []),
            JSON.stringify(claimedUrls || []),
            JSON.stringify(unauthorizedUrls || []),
            fabType,
            (original || '').slice(0, 600),
            (final || '').slice(0, 600)
          ).run();
        } catch (e) {
          console.warn('[donation_validator] log failed:', e.message);
        }
      }

      const donationText = extractTextFromContent(data.content);
      if (donationText.length > 60 && detectDonationLimitSignals(donationText)) {
        const stateCodeForDonation = normalizeStateCode(state);
        const officeNorm = (specificOffice || '').toLowerCase().trim();
        const raceYear = electionDate ? parseInt(String(electionDate).slice(0, 4), 10) : null;
        const donationLookup = await findMostRecentDonationLookup(
          messages, stateCodeForDonation, officeNorm, raceYear, location || null
        );

        if (donationLookup) {
          const authoritativeAmounts = flattenDonationAuthoritativeAmounts(donationLookup);
          const authoritativeUrls = extractAuthoritativeUrls(donationLookup);

          const claimedAmounts = await extractClaimedDonationAmounts(donationText);
          const unauthorizedAmounts = claimedAmounts.filter(a => !amountClaimedMatchesAuthoritative(a, authoritativeAmounts));
          const claimedUrls = extractUrlTokens(donationText);
          const unauthorizedUrls = claimedUrls.filter(u => !urlMatchesAuthoritative(u, authoritativeUrls));

          if (unauthorizedAmounts.length > 0 || unauthorizedUrls.length > 0) {
            const retry = await regenerateWithDonationFeedback(
              messages, data.content, unauthorizedAmounts, unauthorizedUrls, donationLookup
            );
            const retryText = extractTextFromContent(retry.content);
            const retryClaimedAmounts = await extractClaimedDonationAmounts(retryText);
            const retryUnauthorizedAmounts = retryClaimedAmounts.filter(a => !amountClaimedMatchesAuthoritative(a, authoritativeAmounts));
            const retryClaimedUrls = extractUrlTokens(retryText);
            const retryUnauthorizedUrls = retryClaimedUrls.filter(u => !urlMatchesAuthoritative(u, authoritativeUrls));

            if (retryUnauthorizedAmounts.length === 0 && retryUnauthorizedUrls.length === 0) {
              await logDonationValidationEvent(
                'regenerated', claimedAmounts, donationLookup.limits || {}, unauthorizedAmounts,
                claimedUrls, unauthorizedUrls, donationText, retryText
              );
              return buildSafeResponse(retry);
            }

            const stripped = stripUnauthorizedDonationArtifacts(retryText, retryUnauthorizedAmounts, retryUnauthorizedUrls);
            const strippedResponse = { ...retry, content: [{ type: 'text', text: stripped }] };
            await logDonationValidationEvent(
              'stripped', claimedAmounts, donationLookup.limits || {}, retryUnauthorizedAmounts,
              claimedUrls, retryUnauthorizedUrls, donationText, stripped
            );
            return buildSafeResponse(strippedResponse);
          }

          await logDonationValidationEvent(
            'passed', claimedAmounts, donationLookup.limits || {}, [],
            claimedUrls, [], donationText, donationText
          );
        }
      }

      // ============================================================
      // OPPONENT-FACT VALIDATOR (Phase 1.5)
      //
      // Catches unverified claims about opponents that web_search
      // gating didn't pre-empt. Same architectural shape as the
      // geographic and compliance validators: extract claims via
      // cheap Haiku audit, cross-check against authoritative sources
      // (Intel data, tool memory, user-provided messages), regen or
      // strip if drift detected.
      //
      // Skip entirely when workspace has no opponents in Intel —
      // nothing to cross-check against.
      // ============================================================
      const _intelOpponents = (intelContext && Array.isArray(intelContext.opponents))
        ? intelContext.opponents.filter(o => o && o.name)
        : [];

      if (_intelOpponents.length > 0) {
        const opponentSamText = extractTextFromContent(data.content);
        // Build "known facts" blob from all authoritative sources for
        // the audit Haiku to compare claims against.
        const intelSummary = _intelOpponents.map(o =>
          `- ${o.name} (${o.party || 'unknown party'})${o.office ? ', running for ' + o.office : ''}` +
          `${o.threatLevel != null ? ' | threat ' + o.threatLevel + '/10' : ''}` +
          `${o.keyRisk ? ' | risk: ' + o.keyRisk : ''}` +
          `${o.campaignFocus ? ' | focus: ' + o.campaignFocus : ''}` +
          `${o.bio ? ' | bio: ' + o.bio : ''}` +
          `${o.background ? ' | background: ' + o.background : ''}` +
          `${o.recentNews ? ' | recent: ' + o.recentNews : ''}` +
          `${o.userNotes ? ' | userNotes (USER-SUPPLIED, AUTHORITATIVE): ' + o.userNotes : ''}`
        ).join('\n');

        // User messages from this conversation (string-content user
        // messages — exclude tool_result blocks).
        const userClaimsBlob = (messages || [])
          .filter(m => m && m.role === 'user' && typeof m.content === 'string')
          .map(m => m.content)
          .join('\n---\n')
          .slice(0, 4000);  // cap

        async function extractUnauthorizedOpponentClaims(samText, intelStr, userMsgsStr) {
          const prompt =
            'You audit campaign coaching responses for unverified claims about opponents. Your output is JSON only — no preamble, no markdown.\n\n' +
            'OPPONENTS_AND_INTEL_DATA below includes BOTH user-input fields (name, party, office, threatLevel, keyRisk) AND auto-research fields (bio, background, recentNews, campaignFocus) AND user-supplied free-text notes (userNotes — the candidate\'s own on-the-ground intel). ALL fields are AUTHORITATIVE Intel data. Claims that quote, paraphrase, or summarize ANY of these fields — including auto-research and userNotes — are AUTHORIZED, not unverified.\n\n' +
            'OPPONENTS_AND_INTEL_DATA:\n' + (intelStr || 'none') + '\n\n' +
            'USER_MESSAGES_THIS_CONVERSATION:\n' + (userMsgsStr || 'none') + '\n\n' +
            'SAM_RESPONSE:\n' + samText + '\n\n' +
            'TASK: Identify each specific claim Sam made about an opponent that is NOT supported by OPPONENTS_AND_INTEL_DATA above and NOT supported by USER_MESSAGES.\n\n' +
            'A claim must be ABOUT THE OPPONENT — meaning a specific assertion of fact attributed to or describing one of the named opponents in OPPONENTS_AND_INTEL_DATA. Generic political dynamics, strategic commentary, or characterizations of districts/electorates that are not tied to a specific opponent are NOT in scope for this validator.\n\n' +
            'In-scope specifics: dollar amounts the opponent raised/spent, dates of opponent activity, organizational names attributed to the opponent (PACs, donors, employers), specific quotes attributed to opponents, voting-record specifics for the opponent, prior offices the opponent held, biographical details about the opponent (years, places, family).\n\n' +
            'DO NOT flag:\n' +
            '- General political-dynamics commentary not specific to any opponent ("Chamber endorsements move money", "tax reform plays well in suburban districts", "incumbents have an advantage")\n' +
            '- General statements ("opponent has been campaigning")\n' +
            '- Statements that paraphrase or summarize ANY field in OPPONENTS_AND_INTEL_DATA, including auto-research fields (bio, background, recentNews, campaignFocus, keyRisk) AND user-supplied notes (userNotes)\n' +
            '- The opponent\'s own name\n' +
            '- Statements about what the user should do (strategy advice)\n' +
            '- Office, party, jurisdiction, race-type info that\'s public race context\n' +
            '- Statements about ENDORSERS or other non-opponent named persons (this validator scope is opponents ONLY)\n' +
            '- Characterizations of the district\'s political lean ("red-leaning", "competitive", "blue") not tied to a specific opponent claim\n\n' +
            'Return JSON: {"claims": ["raised $129,500 last quarter", "Action For Florida PAC", "former state senator"]}\n' +
            'If no unauthorized claims: {"claims": []}\n' +
            'JSON ONLY.';
          try {
            const aResp = await fetch('https://api.anthropic.com/v1/messages', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
              body: JSON.stringify({
                model: 'claude-haiku-4-5-20251001',
                max_tokens: 600,
                temperature: 0,
                messages: [{ role: 'user', content: prompt }]
              })
            });
            const ad = await aResp.json();
            await logApiUsage('sam_opponent_validator', ad, rateLimitUserId, chatOwnerId);
            let txt = '';
            if (ad && ad.content && Array.isArray(ad.content)) {
              for (const b of ad.content) if (b && b.type === 'text' && b.text) txt += b.text;
            }
            const mm = txt.match(/\{[\s\S]*\}/);
            if (!mm) return [];
            const parsed = JSON.parse(mm[0]);
            return Array.isArray(parsed.claims) ? parsed.claims : [];
          } catch (e) {
            console.warn('[opponent_validator] extract failed:', e.message);
            return [];
          }
        }

        async function regenerateWithOpponentFeedback(originalMsgs, badContent, unauthorizedClaims) {
          const retryMsgs = [
            ...originalMsgs,
            { role: 'assistant', content: badContent },
            { role: 'user', content:
              'STOP. Your previous response made claims about opponents that aren\'t in the user\'s Intel data, ' +
              'tool results, or earlier messages: ' + JSON.stringify(unauthorizedClaims) + '. ' +
              'Rewrite using ONLY verified opponent information from Intel. If Intel doesn\'t have what\'s needed, ' +
              'defer honestly: "I don\'t have detailed information about your opponent in your Intel panel — tell me what you know about their fundraising, endorsements, or voting record and I\'ll factor it into your strategy." ' +
              'Reply with only the rewritten answer — no preamble, no acknowledgment of this correction.'
            }
          ];
          const regenResult = await callClaude(retryMsgs);
          if (workspaceEntities && workspaceEntities.length > 0 && regenResult && Array.isArray(regenResult.content)) {
            regenResult.content = demaskContentArray(regenResult.content, workspaceEntities);
          }
          return regenResult;
        }

        function stripOpponentClaims(samText, unauthorizedClaims) {
          if (!unauthorizedClaims || unauthorizedClaims.length === 0) return samText;
          const sentences = samText.split(/(?<=[.!?])\s+|\n+/);
          const cleaned = sentences.filter(s => {
            const sLower = s.toLowerCase();
            return !unauthorizedClaims.some(c => c && sLower.includes(String(c).toLowerCase()));
          });
          const joined = cleaned.join(' ').replace(/\s+/g, ' ').trim();
          if (joined.length < 60) {
            return "I don't have enough verified information about your opponent in your Intel panel to answer that confidently. Tell me what you know about them — fundraising, endorsements, voting record, prior offices — and I'll factor it into your strategy.";
          }
          return joined + '\n\n*(Note: removed opponent claims that could not be verified against your Intel data.)*';
        }

        async function logOpponentValidationEvent(action, claims, unauthorized, original, final) {
          try {
            await env.DB.prepare(
              'INSERT INTO sam_opponent_validation_events (id, conversation_id, workspace_owner_id, user_id, action_taken, opponent_claims_detected, unauthorized_claims, original_response_excerpt, final_response_excerpt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
            ).bind(
              generateId(16), conversation_id || null, chatOwnerId || null, rateLimitUserId || null,
              action,
              JSON.stringify(claims || []),
              JSON.stringify(unauthorized || []),
              (original || '').slice(0, 600),
              (final || '').slice(0, 600)
            ).run();
          } catch (e) {
            console.warn('[opponent_validator] log failed:', e.message);
          }
        }

        if (opponentSamText.length > 60) {
          // Phase 5b false-positive guard: only run audit if Sam's
          // response actually mentions an opponent by name. If Sam
          // is talking about endorsers, generic strategy, or other
          // non-opponent content, the validator has no target —
          // skip to avoid stripping clean responses (the bug from
          // the red-team battery: validator footer appended to a
          // response about DeSantis-the-endorser, not an opponent).
          const _opponentNameRefd = _intelOpponents.some(o => {
            if (!o.name) return false;
            const re = new RegExp('\\b' + String(o.name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
            return re.test(opponentSamText);
          });
          if (!_opponentNameRefd) {
            await logOpponentValidationEvent('false_positive_skipped', [], [], opponentSamText, opponentSamText);
          } else {
            const unauthorized = await extractUnauthorizedOpponentClaims(opponentSamText, intelSummary, userClaimsBlob);
            if (unauthorized.length > 0) {
              const retry = await regenerateWithOpponentFeedback(messages, data.content, unauthorized);
              const retryText = extractTextFromContent(retry.content);
              const retryUnauthorized = await extractUnauthorizedOpponentClaims(retryText, intelSummary, userClaimsBlob);
              if (retryUnauthorized.length === 0) {
                await logOpponentValidationEvent('regenerated', unauthorized, unauthorized, opponentSamText, retryText);
                return buildSafeResponse(retry);
              }
              const stripped = stripOpponentClaims(retryText, retryUnauthorized);
              const strippedResp = { ...retry, content: [{ type: 'text', text: stripped }] };
              await logOpponentValidationEvent('stripped', unauthorized, retryUnauthorized, opponentSamText, stripped);
              return buildSafeResponse(strippedResp);
            }
            await logOpponentValidationEvent('passed', [], [], opponentSamText, opponentSamText);
          }
        }
      }

      // ============================================================
      // CITATION VALIDATOR (Phase 5a)
      //
      // Catch-all post-processor for unverified specific factual
      // claims. Runs AFTER all fact-class validators (geographic,
      // compliance A/B, donation, opponent). Only reached when no
      // prior validator returned early — so this is the meta-layer
      // for claims that fall through fact-class detection.
      //
      // Splits unverified claims into:
      //   high_stakes (dollar/date/phone/url/person/statute) → STRIP
      //   soft (percentage/stat/benchmark/electoral) → TAG inline
      //
      // Stripped events count toward Safe Mode threshold via
      // getValidatorFiringBreakdown (filters action_taken IN
      // ('regenerated','stripped')). Tagged events do not — tags
      // are visible uncertainty signals, not reliability degradation.
      // ============================================================
      const _citationSamText = extractTextFromContent(data.content);

      // Skip when the entire response is just a clarifying question (short
      // and ends with ?). Sam's normal responses end with a follow-up
      // question by style, so we can't gate on "ends with ?" — instead
      // gate on "short AND ends with ?". Audit-Haiku already ignores
      // questions back to the user inside longer answers.
      const _trimmed = _citationSamText.trim();
      const _isShortQuestion = _trimmed.length < 200 && /\?\s*$/.test(_trimmed);

      // Phase 6a: bypass the 100-char threshold for short responses that
      // assert a day-of-week for a specific date. Sam's wrong-day misreads
      // ("May 22 is a Thursday") are typically 30-40 chars, below threshold.
      // These assertions are high-stakes and the validator must see them.
      const _hasDayDateAssertion = /\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/i.test(_citationSamText)
        && /\b(January|February|March|April|May|June|July|August|September|October|November|December)\b/i.test(_citationSamText);

      if ((_citationSamText.length >= 100 || _hasDayDateAssertion) && !_isShortQuestion) {
        // Build a rich GT block with human-readable date variants so the
        // audit-Haiku doesn't strip date claims that are just format
        // re-renderings of the Ground Truth election date (e.g.
        // "Tuesday, November 3, 2026" of "2026-11-03").
        let _electionHuman = '';
        if (electionDate) {
          try {
            const d = new Date(electionDate + 'T00:00:00');
            if (!isNaN(d.getTime())) {
              const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
              const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
              _electionHuman = ` (${days[d.getUTCDay()]}, ${months[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()})`;
            }
          } catch (e) {}
        }
        const _dayCountWindow = effectiveDays != null
          ? `${Math.max(0, effectiveDays - 2)}-${effectiveDays + 2} days (rendering varies by clock)`
          : 'unknown';
        const _gtSummary =
          `Candidate: ${candidateName || 'unknown'} | Office: ${specificOffice || 'unknown'} | ` +
          `Location: ${location || 'unknown'}, ${state || 'unknown'} | Party: ${party || 'not specified'} | ` +
          `Election date: ${electionDate || 'not set'}${_electionHuman} | Days to election: ${_dayCountWindow} | ` +
          `Budget: ${budgetStr} | Win number: ${winNumberStr} | Raised: ${raisedStr} | Donors: ${donorCount || 0} | ` +
          `Today: ${currentDate} (${isoToday})` +
          (earlyVotingStartDate ? (() => {
            // Compute days-to-early-voting window so day-count claims like
            // "175 days out" derived from this date are AUTHORIZED.
            let evDays = null;
            try {
              const evD = new Date(earlyVotingStartDate + 'T00:00:00');
              const today = new Date(isoToday + 'T00:00:00');
              if (!isNaN(evD.getTime()) && !isNaN(today.getTime())) {
                evDays = Math.round((evD - today) / 86400000);
              }
            } catch (e) {}
            const evWindow = evDays != null ? `${Math.max(0, evDays - 2)}-${evDays + 2} days` : 'unknown';
            return ` | Early voting starts: ${earlyVotingStartDate} (user-supplied, authoritative — ANY format restating this date is AUTHORIZED, including "October 22", "Oct 22, 2026", "10/22", etc.; day-count claims in the ${evWindow} window are AUTHORIZED as derivations from this date)`;
          })() : '') +
          (candidateBioText ? `\nCandidate bio (user-supplied, authoritative): ${candidateBioText}` : '') +
          (candidateSiteContent ? `\nCandidate site content available (${candidateSiteContent.length} chars from ${candidateSiteUrl}) — claims paraphrasing this content are AUTHORIZED` : '') +
          (typeof calendarReference === 'string' && calendarReference.length > 0
            ? `\n\nCALENDAR_REFERENCE (authoritative day-of-week assignments — claims that match these are AUTHORIZED):\n${calendarReference}`
            : '');

        const _intelBlob = (() => {
          const lines = [];
          if (intelContext && Array.isArray(intelContext.opponents)) {
            for (const o of intelContext.opponents) {
              if (!o || !o.name) continue;
              lines.push(
                `OPPONENT: ${o.name} (${o.party || 'unknown party'})` +
                `${o.office ? ', running for ' + o.office : ''}` +
                `${o.threatLevel != null ? ' | threat ' + o.threatLevel + '/10' : ''}` +
                `${o.keyRisk ? ' | risk: ' + o.keyRisk : ''}` +
                `${o.campaignFocus ? ' | focus: ' + o.campaignFocus : ''}` +
                `${o.bio ? ' | bio: ' + o.bio : ''}` +
                `${o.background ? ' | background: ' + o.background : ''}` +
                `${o.recentNews ? ' | recent: ' + o.recentNews : ''}` +
                `${o.userNotes ? ' | userNotes (USER-SUPPLIED, AUTHORITATIVE): ' + o.userNotes : ''}`
              );
            }
          }
          return lines.join('\n');
        })();

        const _toolMem = (typeof toolMemoryBlock === 'string' && toolMemoryBlock.length > 0) ? toolMemoryBlock : '';

        // In-turn tool results: web_search and tool_use_id pairs from
        // this turn's multi-round loop. extractToolPairs walks the
        // assembled messages array. Sam may have just searched the web
        // for verified facts (e.g. 2024 election results); those results
        // are authoritative for citations she makes in the same turn.
        const _inTurnTools = (() => {
          try {
            const pairs = extractToolPairs(messages || []);
            if (pairs.length === 0) return '';
            return pairs.map(p =>
              `[tool: ${p.name}] input: ${typeof p.input === 'object' ? JSON.stringify(p.input).slice(0, 400) : String(p.input).slice(0, 400)}\nresult: ${String(p.result || '').slice(0, 3000)}`
            ).join('\n---\n').slice(0, 12000);
          } catch (e) { return ''; }
        })();

        const _userMsgsForCit = (messages || [])
          .filter(m => m && m.role === 'user' && typeof m.content === 'string')
          .map(m => m.content)
          .join('\n---\n')
          .slice(0, 4000);

        async function validateUnsourcedClaims(samText) {
          const prompt =
            'You audit campaign coaching responses for unverified specific factual claims. Output JSON only — no preamble, no markdown.\n\n' +
            'AUTHORITATIVE_SOURCES:\n\n' +
            'GROUND_TRUTH:\n' + _gtSummary + '\n\n' +
            'INTEL_DATA (includes auto-research AND user-supplied userNotes — both authoritative):\n' + (_intelBlob || 'none') + '\n\n' +
            'TOOL_MEMORY (prior turns):\n' + (_toolMem || 'none') + '\n\n' +
            'IN_TURN_TOOL_RESULTS (this turn):\n' + (_inTurnTools || 'none') + '\n\n' +
            'USER_MESSAGES:\n' + (_userMsgsForCit || 'none') + '\n\n' +
            'SAM_RESPONSE:\n' + samText + '\n\n' +
            'TASK: Identify each specific factual claim in SAM_RESPONSE that is NOT supported by AUTHORITATIVE_SOURCES.\n\n' +
            'Specifics include:\n' +
            '- Dollar amounts, dates, phone numbers, URLs, addresses\n' +
            '- Named persons (other than candidate, opponents, endorsers shown in AUTHORITATIVE_SOURCES)\n' +
            '- Percentages, statistics, benchmarks ("80-120 doors per day", "5-10% response rate", "$30 cost per contact")\n' +
            '- Electoral history claims ("Republicans won 55.6% in 2022")\n' +
            '- Organizational characterizations of places ("this district trends Republican")\n' +
            '- Specific statute citations\n' +
            '- Day-of-week assertions for specific dates ("May 15 is a Friday", "May 22, 2026 is a Thursday") — these are HIGH_STAKES and must trace to CALENDAR_REFERENCE in GROUND_TRUTH or to a tool result. If the date falls outside the calendar reference window, the day-of-week assertion is unverified.\n' +
            '- Procedural rules ("in-kind contributions are reportable", "you must file Form X", "the fair market value counts as a donation", "donations above $Z must be itemized")\n' +
            '- Legal/regulatory claims about campaign finance, ethics, or compliance procedures stated as binding rules ("you\'re subject to the same individual contribution limits as cash", "the law requires disclosure within 10 days") — these change between cycles and jurisdictions and must trace to a lookup tool result or the authority block, never training-data recall\n\n' +
            'DO NOT flag:\n' +
            '- General strategy advice ("focus on persuadables", "increase donor outreach")\n' +
            '- Conditional statements ("if you do X, then Y")\n' +
            '- Questions back to user\n' +
            '- Public-record geographic facts (state names, county names, well-known city names)\n' +
            '- Information already in AUTHORITATIVE_SOURCES (paraphrase or quote)\n' +
            '- Information that traces to IN_TURN_TOOL_RESULTS (web_search, lookup_*, etc.) — Sam quoting her own tool results this turn is AUTHORIZED\n' +
            '- **CLAIMS WITH AN INLINE CITATION**: Any specific factual claim that is accompanied in the same sentence (or immediately following parenthetical) by a source attribution — inline URL (https://... or domain.tld), "Source: [name]", "Per [organization]", "According to [website/agency]", "[Source name] reports/shows/lists/says". Cited claims are AUTHORIZED — even if you cannot verify the source independently, the user can click through. This is the primary v2 default — Sam answers with citations and the citation is the verification mechanism.\n' +
            '- The election date in ANY format (ISO "2026-11-03", human "Tuesday, November 3, 2026", day-of-week prefixes, etc.) when it matches GROUND_TRUTH\'s election date\n' +
            '- The early voting start date in ANY format when it matches GROUND_TRUTH\'s "Early voting starts" entry (user-supplied; authoritative)\n' +
            '- Day-count claims (e.g. "188 days away", "6 months out") that fall within the GROUND_TRUTH days-to-election window — these are calculations, not unverified claims\n' +
            '- Candidate biographical claims that paraphrase or summarize GROUND_TRUTH\'s candidate bio or candidate site content (user-supplied; authoritative)\n' +
            '- Generic role references already in Ground Truth (e.g., the candidate\'s own party)\n' +
            '- Claims already accompanied by an explicit caveat ("industry benchmarks suggest...", "verify with...")\n\n' +
            'Categorize each unverified claim into one of two buckets:\n' +
            '- "high_stakes": specific dollar amounts, dates, phone numbers, URLs, addresses, named persons (not in AUTHORITATIVE_SOURCES), statute citations, day-of-week assertions for dates not traceable to CALENDAR_REFERENCE, procedural/legal/regulatory rules about campaign finance or compliance not traceable to a tool result → these will be STRIPPED\n' +
            '- "soft": percentages, statistics, benchmarks, electoral history, organizational characterizations → these will be TAGGED with "(unverified)"\n\n' +
            'Return JSON: {"high_stakes": ["claim text 1", ...], "soft": ["claim text 1", ...]}\n' +
            'Each claim should be a verbatim substring from SAM_RESPONSE so the post-processor can locate it.\n' +
            'If none: {"high_stakes": [], "soft": []}\n' +
            'JSON ONLY.';
          try {
            const aResp = await fetch('https://api.anthropic.com/v1/messages', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
              body: JSON.stringify({
                model: 'claude-haiku-4-5-20251001',
                max_tokens: 800,
                temperature: 0,
                messages: [{ role: 'user', content: prompt }]
              })
            });
            const ad = await aResp.json();
            await logApiUsage('sam_citation_validator', ad, rateLimitUserId, chatOwnerId);
            let txt = '';
            if (ad && ad.content && Array.isArray(ad.content)) {
              for (const b of ad.content) if (b && b.type === 'text' && b.text) txt += b.text;
            }
            const mm = txt.match(/\{[\s\S]*\}/);
            if (!mm) return { high_stakes: [], soft: [] };
            const parsed = JSON.parse(mm[0]);
            return {
              high_stakes: Array.isArray(parsed.high_stakes) ? parsed.high_stakes.filter(c => typeof c === 'string' && c.length > 0) : [],
              soft: Array.isArray(parsed.soft) ? parsed.soft.filter(c => typeof c === 'string' && c.length > 0) : []
            };
          } catch (e) {
            console.warn('[citation_validator] extract failed:', e.message);
            return { high_stakes: [], soft: [] };
          }
        }

        function stripUnverifiedClaims(samText, claims) {
          if (!claims || claims.length === 0) return samText;
          const sentences = samText.split(/(?<=[.!?])\s+|\n+/);
          const cleaned = sentences.filter(s => {
            const sLower = s.toLowerCase();
            return !claims.some(c => c && sLower.includes(String(c).toLowerCase()));
          });
          const joined = cleaned.join(' ').replace(/\s+/g, ' ').trim();
          if (joined.length < 60) {
            // Sam v2 Phase 2 strip-fallback: actionable smart deferral instead
            // of v1 defensive "I want to be grounded" message. Tells the user
            // where the authoritative source lives and offers a follow-up.
            // Specific URL routing requires question classifier (v2 Phase 5);
            // generic-but-actionable is the v2 Phase 2 floor.
            return "I tried to find a verified source for that and couldn't lock it down right now. For questions like this, your state's elections division (Secretary of State or Division of Elections) and your county Supervisor of Elections publish the current rules and dates — those are the authoritative sources. Want me to set a calendar reminder to follow up in a week, or do you want to share what you've heard so I can factor it into your strategy?";
          }
          return joined + '\n\n*(Note: removed specific claims that couldn\'t be traced to your race data, tools, or earlier messages.)*';
        }

        function tagUnverifiedClaims(samText, claims) {
          if (!claims || claims.length === 0) return samText;
          let out = samText;
          const TAG = ' *(unverified — verify before relying on)*';
          for (const c of claims) {
            if (!c) continue;
            const cStr = String(c);
            const idxLower = out.toLowerCase().indexOf(cStr.toLowerCase());
            if (idxLower < 0) continue;
            const after = out.slice(idxLower + cStr.length);
            // avoid double-tagging
            if (after.startsWith(TAG) || after.startsWith(' *(unverified')) continue;
            out = out.slice(0, idxLower + cStr.length) + TAG + after;
          }
          return out;
        }

        async function logCitationEvent(action, highStakes, soft, original, final) {
          try {
            const cats = {
              high_stakes_count: (highStakes || []).length,
              soft_count: (soft || []).length
            };
            await env.DB.prepare(
              'INSERT INTO sam_citation_validation_events (id, conversation_id, workspace_owner_id, user_id, action_taken, sam_unverified_claims, claim_categories, original_response_excerpt, final_response_excerpt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
            ).bind(
              generateId(16), conversation_id || null, chatOwnerId || null, rateLimitUserId || null,
              action,
              JSON.stringify({ high_stakes: highStakes || [], soft: soft || [] }),
              JSON.stringify(cats),
              (original || '').slice(0, 600),
              (final || '').slice(0, 600)
            ).run();
          } catch (e) {
            console.warn('[citation_validator] log failed:', e.message);
          }
        }

        // Sam v2 Phase 2: regenerate-with-citation path before strip fallback.
        // High-stakes uncited claim → ask Sam to rewrite with sources cited.
        // If retry still has uncited high-stakes claims → existing strip behavior.
        async function regenerateWithCitationFeedback(originalMsgs, badContent, uncitedClaims) {
          const retryMsgs = [
            ...originalMsgs,
            { role: 'assistant', content: badContent },
            { role: 'user', content:
              'STOP. Your previous response stated factual claims without citing sources: ' +
              JSON.stringify(uncitedClaims) + '.\n\n' +
              'Rewrite your response. For each factual claim about a date, dollar amount, named person, URL, address, statute, or law:\n' +
              '- Call web_search if you haven\'t already this turn\n' +
              '- Cite the source inline using the format "(Source: [domain])" OR "According to [organization]" OR "Per [URL]" OR "[Source name] reports..."\n' +
              '- Make URLs clickable when possible\n\n' +
              'If a claim cannot be sourced via web_search, replace it with a smart deferral: "I searched and didn\'t find [X] — [specific authoritative URL where it WILL be published] is where to check." Do NOT fall back to training-data answers.\n\n' +
              'Reply with only the rewritten answer — no preamble, no acknowledgment of this correction.'
            }
          ];
          const regenResult = await callClaude(retryMsgs);
          if (workspaceEntities && workspaceEntities.length > 0 && regenResult && Array.isArray(regenResult.content)) {
            regenResult.content = demaskContentArray(regenResult.content, workspaceEntities);
          }
          return regenResult;
        }

        const cv = await validateUnsourcedClaims(_citationSamText);
        if (cv.high_stakes.length > 0) {
          // Try regen-with-citation FIRST (one retry).
          const retry = await regenerateWithCitationFeedback(messages, data.content, cv.high_stakes);
          const retryText = extractTextFromContent(retry.content);
          const retryCv = await validateUnsourcedClaims(retryText);
          if (retryCv.high_stakes.length === 0) {
            // Regen succeeded — Sam now cites her claims. Tag any soft claims
            // that the retry might also have surfaced.
            let finalText = retryText;
            if (retryCv.soft.length > 0) {
              finalText = tagUnverifiedClaims(retryText, retryCv.soft);
            }
            const finalResp = { ...retry, content: [{ type: 'text', text: finalText }] };
            await logCitationEvent('regenerated_with_citation', cv.high_stakes, retryCv.soft, _citationSamText, finalText);
            return buildSafeResponse(finalResp);
          }
          // Regen still uncited → fall back to strip (existing v1 behavior).
          const stripped = stripUnverifiedClaims(retryText, retryCv.high_stakes);
          const strippedResp = { ...retry, content: [{ type: 'text', text: stripped }] };
          await logCitationEvent('stripped', cv.high_stakes, retryCv.high_stakes, _citationSamText, stripped);
          return buildSafeResponse(strippedResp);
        }
        if (cv.soft.length > 0) {
          const tagged = tagUnverifiedClaims(_citationSamText, cv.soft);
          const taggedResp = { ...data, content: [{ type: 'text', text: tagged }] };
          await logCitationEvent('tagged', [], cv.soft, _citationSamText, tagged);
          return buildSafeResponse(taggedResp);
        }
        await logCitationEvent('passed', [], [], _citationSamText, _citationSamText);
      }

      return buildSafeResponse(data);

    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }
  },
};
