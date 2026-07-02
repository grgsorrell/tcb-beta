# 00 — PROJECT SNAPSHOT / OVERVIEW  (sam-overhaul branch)

The Candidate's Toolbox (TCB). Backend Cloudflare Worker ("Sam", **Google Gemini 2.5 Flash**) +
static-asset frontend + Cloudflare D1. This snapshot reflects the **sam-overhaul branch** at git
HEAD bac2d81 — Phases 0-6 of the Sam overhaul applied. NOT deployed (branch only).

SECURITY / REDACTION: secret VALUES scanned + redacted; env.* NAMES retained; the password-hash salt
literal is redacted to [REDACTED-password-hash-salt] in source dumps.

## OVERHAUL SUMMARY (what changed on this branch vs master)
- Prompt un-forked + modularized (lib/sam_prompt_modules.mjs): identity / FACT TRUST LADDER /
  hard constraints / tool guidance; ~8,700 -> ~1,886 base words. Guard: scripts/check_prompt_budget.mjs.
- request_web_search escape hatch (server-side grounding sub-loop) kills the router capability cliff.
- responseSchema for router + classifier + all 5 validators; thinkingBudget 512 on the main turn.
- sam_turn_trace table + per-turn tracing + Resend failure alerting; 30-message history cap;
  jurisdiction-neutral fallback.
- PBKDF2 password hashing (pbkdf2$210000$salt$hash) with transparent legacy-SHA-256 rehash on login.
- callClaude -> callGemini rename; beta rate-limit bypass via users.plan='beta'; logApiUsage default
  modelTag -> gemini-2.5-flash; CLAUDE.md rewritten to match reality.

## DEPLOYED WORKER VERSIONS
The branch is NOT deployed. Last deployed (pre-overhaul, master): backend
48492a27-cffc-4788-bdda-b32fd69efa4b, frontend a9a8e44d-66bb-4a65-9f8a-8d109b3d7337.

## CLOUDFLARE WORKER SECRETS — NAMES ONLY (unchanged; 12)
ADMIN_PASSWORD, ANTHROPIC_API_KEY (legacy/unused), BETA_PASSWORD, GEMINI_API_KEY, RESEND_API_KEY,
SHADOW_GEMINI_USER_IDS, STRIPE_ACTIVE, STRIPE_SECRET_KEY, STRIPE_STANDARD_MONTHLY,
STRIPE_WEBHOOK_SECRET, VPS_SEARCH_KEY, VPS_SEARCH_URL. Frontend (tcb-beta): none.

## WRANGLER CONFIG (backend only; frontend deploys via CLI flags)
----- wrangler.toml -----
name = "candidate-toolbox-secretary2"
main = "worker.js"
compatibility_date = "2026-04-07"
workers_dev = true

[[d1_databases]]
binding = "DB"
database_name = "candidates-toolbox-db"
database_id = "c0c58f4f-309e-487d-bbbc-f80b0714c137"

## ROW COUNTS (key tables)

## GIT LOG (git log --oneline -40)

bac2d81 overhaul phase 6: PBKDF2 hashing w/ transparent legacy rehash; callClaude->callGemini; beta rate-bypass via plan; logApiUsage gemini default; CLAUDE.md rewrite
d30d7cc overhaul phase 5: sam_turn_trace + per-turn tracing + Resend alerting; compliance/finance validators schema-ified; jurisdiction-neutral fallback; 30-msg history cap; URL-whitelist investigation
dddce47 overhaul phase 4: thinkingBudget 512 main turn; responseSchema for router/classifier/3 validators; googleSearch key normalize; de-Floridify validator regen refs
098e40b overhaul phase 3 follow-up: live Gemini functionResponse round-trip test
494358c overhaul phase 3: request_web_search escape hatch + server-side grounding sub-loop; router demoted to optimizer
855630e chore: add .gitattributes for LF normalization (kill CRLF diff churn)
bcdd3a7 overhaul phase 2: modularize prompt into identity/trust-ladder/constraints/tool-guidance; 8696->1886 words
8118122 overhaul phase 1: un-fork prompt — remove 5 samEngine gates on prompt content
22a5262 overhaul phase 0: recon — sam_engine distribution + base prompt word count
eea93d0 Fix Stripe activation: propagate userId to subscription, handle checkout.session.completed, log webhooks, guard period fields
bbe455b Add hard paywall: signup→checkout, login takeover, Sam gate; remove trials
7ba9c52 Update homepage CTAs from Request Beta Access to Early Access
4d6cf7b Add password reset flow with email link, single-use tokens, session invalidation
06bd49b Fix billing UI race condition: refresh topbar and settings after billing state hydrates
fee730b Exempt grandfathered beta users from upgrade prompts
a427b09 Switch signup default to standard plan for Stripe activation
022bfc3 Add Terms/Privacy consent requirement to signup
ffded32 Add Terms of Service and Privacy Policy pages
63bf6a8 Add client-side billing UI: Early Bird CTA, topbar upgrade pill, Stripe checkout flow
595c583 Username uniqueness hardening + Stripe prerequisites (webhook verification, subscriptions index, single-tier priceMap)
7eba0b0 Win number: VPS full-page prefetch for historical election data
ef512c7 Win number: extract real vote totals from search, not hardcoded turnout
5cd956a Win number: forceful MANDATORY BEHAVIOR rewrite
05dfc80 Win number: confidence-tag phrasing + anti-defer example to pass validator
50b49b8 Skip D1 bypass when message contains live-data triggers
2c9c5c5 Add win number calculation guidance: percentage fallback + never-refuse rule
228e6bb Fix win number research: target Ballotpedia for historical results + remove debug endpoint
7bdf3ca Fix D1 bypass false positives: match on question/category only + add main chat logging
83a7266 Fix Sam search capability messaging + router election results triggers
d1bfe72 Migrate all hardcoded URLs to thecandidatestoolbox.com
c8054bf Fix sentence splitter for name suffixes + calendar tool permission gate
a804a71 Add Sam AI disclaimer bar above chat input
3e5e0a2 Redesign TCB homepage: Three.js hero, Meet Sam demo + fix .assetsignore security gaps
d08be88 Add District Pulse citations via Gemini grounding
891dbea Fix budget visibility: sanitize input, hard constraint, await save
8561707 Add 3 hard-constraint blocks: municipal races, illegal contributions, calendar permission
692a5cc Add vps/research.py: FEC, OpenStates, Ballotpedia, and donor lookup endpoints
1c59ba0 Add FEC donor lookup tool + ban unverified state URLs
723017a Fix entity mask stale candidate name on profile rename
35b18f6 Tighten router: reduce unnecessary grounding calls by ~50%

## FULL FILE TREE (line counts; new overhaul files marked)
   lines  path
      31  .assetsignore
     121  .claude/settings.local.json
      25  .gitattributes
       6  .gitignore
     885  CLAUDE.md
      18  README.md
      61  STRIPE_ACTIVATION.md
      14  _headers
     361  admin.html
    5634  app-pre-d1-backup.html
    9923  app.html
  binary  icon512.png
    1053  index.html
      94  lib/campaign_reference_lookup.mjs
     147  lib/classify_reference_lookup.mjs
      50  lib/extract_cited_urls.mjs
     157  lib/grounding_aware_validation.mjs
      92  lib/sam_prompt_modules.mjs
     273  lib/strip_tool_references.mjs
      28  migrations/001_sam_turn_trace.sql
      13  playwright.config.js
     255  privacy.html
     194  reset.html
     759  sam-2-analysis.md
     379  sam-2-grade-report.md
     404  sam-tests.spec.js
  binary  samavatar.png
      54  scripts/admin_dashboard_output.txt
     213  scripts/analyze_repetition.js
     177  scripts/analyze_repetition2.js
     137  scripts/analyze_repetition3.js
     215  scripts/audit_regenerated_with_url_history.mjs
      61  scripts/audit_v2_p7.py
      56  scripts/audit_v2_p7_output.txt
      21  scripts/audit_v2_p7_samples.py
      84  scripts/audit_v2_p7_samples_output.txt
      39  scripts/audit_v2_p7_schema.py
      50  scripts/audit_v2_p7_schema_output.txt
      60  scripts/b3_verify_output.txt
      87  scripts/c7_test_report.md
      58  scripts/check_prompt_budget.mjs
      52  scripts/citation_fix_output.txt
     219  scripts/compliance_test_output.txt
      33  scripts/date_battery_output.txt
      84  scripts/date_battery_today.py
      97  scripts/date_verify_output.txt
      38  scripts/diagnose_t9.py
      17  scripts/diagnose_t9_raw.py
     111  scripts/dossier_output.txt
      10  scripts/entity_mask_output.txt
      32  scripts/flagged_turns.json
     604  scripts/flagged_turns2.json
      53  scripts/geo_8x_output.txt
      82  scripts/geo_8x_run.py
     216  scripts/import_campaign_reference.mjs
    1352  scripts/import_data/alabama_full_v1.json
     112  scripts/import_data/alabama_full_v1.sql
    1352  scripts/import_data/alaska_full_v1.json
     112  scripts/import_data/alaska_full_v1.sql
    1052  scripts/import_data/arizona_full_v1.json
     112  scripts/import_data/arizona_full_v1.sql
    1352  scripts/import_data/arkansas_full_v1.json
     112  scripts/import_data/arkansas_full_v1.sql
    1244  scripts/import_data/california_full_v1.json
     106  scripts/import_data/california_full_v1.sql
    1370  scripts/import_data/colorado_full_v1.json
     113  scripts/import_data/colorado_full_v1.sql
    1370  scripts/import_data/connecticut_full_v1.json
     113  scripts/import_data/connecticut_full_v1.sql
    1298  scripts/import_data/dc_full_v1.json
     109  scripts/import_data/dc_full_v1.sql
    1352  scripts/import_data/delaware_full_v1.json
     112  scripts/import_data/delaware_full_v1.sql
    1318  scripts/import_data/florida_full_v1.json
     131  scripts/import_data/florida_full_v1.sql
    1276  scripts/import_data/georgia_full_v1.json
     128  scripts/import_data/georgia_full_v1.sql
    1352  scripts/import_data/hawaii_full_v1.json
     112  scripts/import_data/hawaii_full_v1.sql
    1352  scripts/import_data/idaho_full_v1.json
     112  scripts/import_data/idaho_full_v1.sql
    1352  scripts/import_data/indiana_full_v1.json
     112  scripts/import_data/indiana_full_v1.sql
    1280  scripts/import_data/iowa_full_v1.json
     108  scripts/import_data/iowa_full_v1.sql
    1334  scripts/import_data/kansas_full_v1.json
     111  scripts/import_data/kansas_full_v1.sql
    1334  scripts/import_data/kentucky_full_v1.json
     111  scripts/import_data/kentucky_full_v1.sql
    2280  scripts/import_data/louisiana_full_v1.json
     134  scripts/import_data/louisiana_full_v1.sql
    1172  scripts/import_data/maine_full_v1.json
     102  scripts/import_data/maine_full_v1.sql
    1352  scripts/import_data/maryland_full_v1.json
     112  scripts/import_data/maryland_full_v1.sql
    1334  scripts/import_data/massachusetts_full_v1.json
     111  scripts/import_data/massachusetts_full_v1.sql
    1024  scripts/import_data/michigan_full_v1.json
     110  scripts/import_data/michigan_full_v1.sql
    1352  scripts/import_data/minnesota_full_v1.json
     112  scripts/import_data/minnesota_full_v1.sql
    1352  scripts/import_data/mississippi_full_v1.json
     112  scripts/import_data/mississippi_full_v1.sql
    1352  scripts/import_data/missouri_full_v1.json
     112  scripts/import_data/missouri_full_v1.sql
    1352  scripts/import_data/montana_full_v1.json
     112  scripts/import_data/montana_full_v1.sql
    1352  scripts/import_data/nebraska_full_v1.json
     112  scripts/import_data/nebraska_full_v1.sql
    1334  scripts/import_data/nevada_full_v1.json
     111  scripts/import_data/nevada_full_v1.sql
    1244  scripts/import_data/new_hampshire_full_v1.json
     106  scripts/import_data/new_hampshire_full_v1.sql
    1334  scripts/import_data/new_jersey_full_v1.json
     111  scripts/import_data/new_jersey_full_v1.sql
    1352  scripts/import_data/new_mexico_full_v1.json
     112  scripts/import_data/new_mexico_full_v1.sql
    1352  scripts/import_data/new_york_full_v1.json
     112  scripts/import_data/new_york_full_v1.sql
    1220  scripts/import_data/north_carolina_full_v1.json
     124  scripts/import_data/north_carolina_full_v1.sql
    1334  scripts/import_data/north_dakota_full_v1.json
     111  scripts/import_data/north_dakota_full_v1.sql
    1280  scripts/import_data/ohio_full_v1.json
     108  scripts/import_data/ohio_full_v1.sql
    1352  scripts/import_data/oklahoma_full_v1.json
     112  scripts/import_data/oklahoma_full_v1.sql
    1352  scripts/import_data/oregon_full_v1.json
     112  scripts/import_data/oregon_full_v1.sql
     912  scripts/import_data/pennsylvania_full_v1.json
     102  scripts/import_data/pennsylvania_full_v1.sql
    1352  scripts/import_data/rhode_island_full_v1.json
     112  scripts/import_data/rhode_island_full_v1.sql
    1334  scripts/import_data/south_carolina_full_v1.json
     111  scripts/import_data/south_carolina_full_v1.sql
    1370  scripts/import_data/south_dakota_full_v1.json
     113  scripts/import_data/south_dakota_full_v1.sql
    1352  scripts/import_data/tennessee_full_v1.json
     112  scripts/import_data/tennessee_full_v1.sql
    1402  scripts/import_data/texas_full_v1.json
     137  scripts/import_data/texas_full_v1.sql
      72  scripts/import_data/texas_sample.json
      26  scripts/import_data/texas_sample.sql
    1370  scripts/import_data/utah_full_v1.json
     113  scripts/import_data/utah_full_v1.sql
    1334  scripts/import_data/vermont_full_v1.json
     111  scripts/import_data/vermont_full_v1.sql
    1122  scripts/import_data/virginia_full_v1.json
     117  scripts/import_data/virginia_full_v1.sql
    1352  scripts/import_data/washington_full_v1.json
     112  scripts/import_data/washington_full_v1.sql
    1316  scripts/import_data/west_virginia_full_v1.json
     110  scripts/import_data/west_virginia_full_v1.sql
    1208  scripts/import_data/wisconsin_full_v1.json
     103  scripts/import_data/wisconsin_full_v1.sql
    1352  scripts/import_data/wyoming_full_v1.json
     112  scripts/import_data/wyoming_full_v1.sql
      76  scripts/intel_notes_output.txt
     161  scripts/masked_prompt_sample.txt
      53  scripts/migrate_notes_folders_to_text_id.sql
      33  scripts/migrations/C1_add_workspace_owner_id.sql
     124  scripts/migrations/C2_backfill_workspace_owner_id.sql
      28  scripts/migrations/CP_ADMIN_SCHEMA.sql
      25  scripts/migrations/CP_BUDGET_sams_take.sql
      10  scripts/migrations/CP_B_sub_users_password_change_col.sql
      38  scripts/migrations/CP_CAMPAIGN_REFERENCE_DB.sql
      37  scripts/migrations/CP_CAMPAIGN_REFERENCE_LOOKUP_EVENTS.sql
      20  scripts/migrations/CP_CITATION_GROUNDING_TELEMETRY.sql
     100  scripts/migrations/CP_COMPLIANCE_AUTHORITIES.sql
      51  scripts/migrations/CP_COMPLIANCE_DEADLINES_CACHE.sql
      29  scripts/migrations/CP_C_login_attempts.sql
      54  scripts/migrations/CP_DONATION_LIMITS_CACHE.sql
      59  scripts/migrations/CP_ENTITY_MASK.sql
      51  scripts/migrations/CP_FINANCE_REPORTS_CACHE.sql
      46  scripts/migrations/CP_FL_AUTHORITY_BACKFILL.sql
      13  scripts/migrations/CP_GEMINI_FAILURES_RETRY_ATTEMPT.sql
      43  scripts/migrations/CP_GEMINI_PRODUCTION_FAILURES.sql
      46  scripts/migrations/CP_JURISDICTION_lookups.sql
      42  scripts/migrations/CP_OPPOSITION_NOTES.sql
      20  scripts/migrations/CP_PROFILES_CANDIDATE_SITE_V2.sql
      33  scripts/migrations/CP_SAM_BLANK_RESPONSE_EVENTS.sql
      51  scripts/migrations/CP_SAM_CITATION_VALIDATION_EVENTS.sql
      34  scripts/migrations/CP_SAM_CLASSIFICATION_EVENTS.sql
      49  scripts/migrations/CP_SAM_COMPLIANCE_VALIDATION_EVENTS.sql
      22  scripts/migrations/CP_SAM_COMPLIANCE_VAL_URL_COLUMNS.sql
      42  scripts/migrations/CP_SAM_DATE_REWRITES.sql
      45  scripts/migrations/CP_SAM_DONATION_VALIDATION_EVENTS.sql
      40  scripts/migrations/CP_SAM_FINANCE_VALIDATION_EVENTS.sql
      44  scripts/migrations/CP_SAM_OPPONENT_VALIDATION_EVENTS.sql
      26  scripts/migrations/CP_SAM_RATE_BYPASS_EVENTS.sql
      45  scripts/migrations/CP_SAM_SAFE_MODE_EVENTS.sql
      64  scripts/migrations/CP_SAM_TOOL_MEMORY.sql
      47  scripts/migrations/CP_SAM_TURN_LOGS.sql
      38  scripts/migrations/CP_SAM_VALIDATION_EVENTS.sql
      22  scripts/migrations/CP_SAM_VALIDATION_EVENTS_ADD_CONV_ID.sql
      58  scripts/migrations/CP_SHADOW_GEMINI_LOG.sql
      26  scripts/migrations/CP_USERS_SAM_ENGINE.sql
     112  scripts/phase_1_5_output.txt
     250  scripts/phase_2a_output.txt
     249  scripts/phase_2b_output.txt
     121  scripts/phase_2b_regressions.py
      57  scripts/phase_2b_regressions_output.txt
     118  scripts/phase_3_output.txt
     148  scripts/phase_4_output.txt
     237  scripts/phase_5_output.txt
     144  scripts/phase_6_output.txt
     175  scripts/phase_7_output.txt
     139  scripts/preprocessor_output.txt
     165  scripts/repro_websearch_diagnosis.js
     298  scripts/round_split.json
     206  scripts/safe_mode_output.txt
     164  scripts/safe_mode_threshold_output.txt
     183  scripts/safe_mode_websearch_fix_output.txt
     191  scripts/sam_dossier_run.py
      91  scripts/sam_v2_p1_output.txt
     227  scripts/sam_v2_p2_output.txt
     202  scripts/sam_v2_p3_output.txt
     202  scripts/sam_v2_p4_output.txt
     255  scripts/sam_v2_p5_output.txt
      61  scripts/sam_v2_p6_output.txt
     122  scripts/sample_block.py
      51  scripts/strip_cite_tags.mjs
     219  scripts/test_admin_dashboard.py
     319  scripts/test_calendar_reference.py
     201  scripts/test_citation_fix.py
     388  scripts/test_compliance_lookup.py
     198  scripts/test_date_preprocessor.py
     389  scripts/test_entity_mask.py
     134  scripts/test_gemini_functionresponse.mjs
     135  scripts/test_gemini_grounding_isolation.mjs
     280  scripts/test_intel_notes.py
     249  scripts/test_phase_1_5.py
     294  scripts/test_phase_2a.py
     303  scripts/test_phase_2b.py
     332  scripts/test_phase_3.py
     315  scripts/test_phase_4.py
     410  scripts/test_phase_5.py
      66  scripts/test_phase_5_force_strip.py
     282  scripts/test_phase_6.py
     290  scripts/test_phase_7.py
     182  scripts/test_renderer_autolink.js
     523  scripts/test_safe_mode_recalibration.py
     314  scripts/test_safe_mode_threshold.py
     395  scripts/test_safe_mode_websearch_fix.py
     300  scripts/test_sam_v2_p1.py
     379  scripts/test_sam_v2_p2.py
     316  scripts/test_sam_v2_p3.py
     393  scripts/test_sam_v2_p4.py
     390  scripts/test_sam_v2_p5.py
     224  scripts/test_sam_v2_p6.py
     301  scripts/test_tool_gating_split.py
     401  scripts/test_tool_memory.py
     282  scripts/test_url_fabrication.py
     136  scripts/test_url_format_real_sam.py
     219  scripts/test_validator_multiturn.py
      74  scripts/tool_gating_output.txt
       0  scripts/turn_logs.err
    1158  scripts/turn_logs.json
     122  scripts/url_fab_output.txt
      40  scripts/url_format_output.txt
     157  scripts/verify_b3.py
     145  scripts/verify_date_semantics.py
     234  scripts/verify_live.mjs
     263  scripts/verify_redesign.mjs
     125  scripts/vps_donor_top_endpoint_spec.md
     295  terms.html
     189  tests/fixtures/sample_masked_prompt.txt
     331  tests/grounding_aware_validation.test.mjs
     182  tests/strip_tool_references.test.mjs
     150  tests/verify_citation_url_extraction.test.mjs
     911  vps/research.py
    1563  worker-pre-d1-backup.js
    2052  worker-v1-backup-2026-04-15.js
    2052  worker-v1-backup.js
   11784  worker.js
       9  wrangler.toml

## D1 SCHEMA (production, read-only dump; now includes sam_turn_trace)

-- D1 candidates-toolbox-db (55 tables)

CREATE TABLE _cf_KV (
        key TEXT PRIMARY KEY,
        value BLOB
      ) WITHOUT ROWID;

CREATE TABLE activity_log (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, user_name TEXT NOT NULL, action TEXT NOT NULL, details TEXT, created_at TEXT DEFAULT (datetime('now')));

CREATE TABLE admin_audit_log (
  id TEXT PRIMARY KEY,
  admin_user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_user_id TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE api_usage (id TEXT PRIMARY KEY, user_id TEXT, campaign_id TEXT, feature TEXT NOT NULL, input_tokens INTEGER, output_tokens INTEGER, estimated_cost REAL, model TEXT, created_at TEXT DEFAULT (datetime('now')), workspace_owner_id TEXT);

CREATE TABLE auth_tokens (   token TEXT PRIMARY KEY,   user_id TEXT NOT NULL,   expires_at TEXT NOT NULL,   used INTEGER DEFAULT 0,   FOREIGN KEY (user_id) REFERENCES users(id) );

CREATE TABLE briefings (   user_id TEXT NOT NULL,   date TEXT NOT NULL,   text TEXT, campaign_id TEXT, workspace_owner_id TEXT,   PRIMARY KEY (user_id, date),   FOREIGN KEY (user_id) REFERENCES users(id) );

CREATE TABLE budget (   user_id TEXT PRIMARY KEY,   total REAL DEFAULT 0,   categories TEXT DEFAULT '{}',   updated_at TEXT DEFAULT (datetime('now')), campaign_id TEXT,   FOREIGN KEY (user_id) REFERENCES users(id) );

CREATE TABLE budget_sams_take (
  workspace_owner_id TEXT PRIMARY KEY,
  campaign_id        TEXT,
  content            TEXT NOT NULL,
  generated_at       TEXT NOT NULL,
  budget_snapshot    TEXT
);

CREATE TABLE campaign_reference (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL,                -- two-letter state code, uppercased
  office_level TEXT NOT NULL,         -- JSON array as TEXT, e.g. '["state","district","county"]'
  category TEXT NOT NULL,             -- ballot_access | finance_ethics | voter_interaction | election_dates | residency | filing_requirements | redistricting | runoff_rules | recall_rules | candidate_eligibility
  question TEXT NOT NULL,
  question_variants TEXT,             -- JSON array as TEXT, optional
  answer TEXT NOT NULL,
  source_url TEXT NOT NULL,
  source_name TEXT,
  last_verified_date TEXT NOT NULL,   -- ISO YYYY-MM-DD
  update_frequency TEXT NOT NULL,     -- static | per_cycle | volatile
  verification_method TEXT NOT NULL,  -- official_source_direct | secondary_source | statute_citation
  scope TEXT,
  import_batch_id TEXT,               -- groups rows from a single import for rollback
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE campaign_reference_lookup_events (
  id TEXT PRIMARY KEY,
  conversation_id TEXT,
  user_id TEXT,
  workspace_owner_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),

  user_message_excerpt TEXT,           -- first 500 chars
  classifier_decision TEXT NOT NULL,   -- 'lookup_fired' | 'lookup_fired_no_matches' | 'no_state' | 'no_specific_category_match' | 'empty_message' | 'error' | 'skipped_non_gemini'
  state_extracted TEXT,                -- 2-letter code, NULL if state extraction failed
  category_extracted TEXT,             -- enum value, NULL if no category detected OR no lookup
  rows_returned INTEGER NOT NULL DEFAULT 0,
  row_ids TEXT,                        -- JSON array of matched ids (for debug)
  raw_classifier_output TEXT           -- JSON of full classifier result (for forensic)
);

CREATE TABLE campaigns (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, candidate_name TEXT, party TEXT, specific_office TEXT, office_level TEXT, location TEXT, state TEXT, election_date TEXT, budget_total REAL DEFAULT 0, win_number INTEGER, status TEXT DEFAULT 'active', created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));

CREATE TABLE chat_history (   user_id TEXT PRIMARY KEY,   messages TEXT NOT NULL,   updated_at TEXT DEFAULT (datetime('now')) , campaign_id TEXT);

CREATE TABLE compliance_authorities (
  id                  TEXT PRIMARY KEY,
  state_code          TEXT NOT NULL,
  jurisdiction_type   TEXT NOT NULL,
  jurisdiction_name   TEXT,
  authority_name      TEXT NOT NULL,
  authority_phone     TEXT,
  authority_url       TEXT,
  notes               TEXT,
  created_at          TEXT DEFAULT (datetime('now'))
);

CREATE TABLE compliance_deadlines_cache (
  id                              TEXT PRIMARY KEY,
  state_code                      TEXT NOT NULL,
  office_normalized               TEXT NOT NULL,
  race_year                       INTEGER NOT NULL,
  jurisdiction_name               TEXT,
  status                          TEXT NOT NULL,
  qualifying_period_start         TEXT,
  qualifying_period_end           TEXT,
  qualifying_period_end_time      TEXT,
  petition_deadline               TEXT,
  filing_fee                      TEXT,
  authority_name                  TEXT,
  authority_phone                 TEXT,
  authority_url                   TEXT,
  authority_notes                 TEXT,
  authority_jurisdiction_specific TEXT,
  source                          TEXT,
  last_updated                    TEXT,
  created_at                      TEXT DEFAULT (datetime('now'))
, web_search_excerpt TEXT, web_search_url TEXT);

CREATE TABLE contributions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, donor_name TEXT, amount REAL DEFAULT 0, source TEXT DEFAULT 'individual', date TEXT, employer TEXT, occupation TEXT, notes TEXT, created_at TEXT DEFAULT (datetime('now')), campaign_id TEXT, workspace_owner_id TEXT);

CREATE TABLE donation_limits_cache (
  id                TEXT PRIMARY KEY,
  state_code        TEXT NOT NULL,
  office_normalized TEXT NOT NULL,
  race_year         INTEGER NOT NULL,
  jurisdiction_name TEXT,
  status            TEXT NOT NULL,
  limits_json       TEXT,
  authority_json    TEXT,
  source            TEXT,
  last_updated      TEXT,
  created_at        TEXT DEFAULT (datetime('now'))
, web_search_excerpt TEXT, web_search_url TEXT);

CREATE TABLE endorsements (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, title TEXT, status TEXT DEFAULT 'Pursuing', notes TEXT, date TEXT, added_by_sam INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')), campaign_id TEXT, workspace_owner_id TEXT);

CREATE TABLE entity_mask (
  id                  TEXT PRIMARY KEY,
  workspace_owner_id  TEXT NOT NULL,
  entity_type         TEXT NOT NULL,
  real_name           TEXT NOT NULL,
  placeholder         TEXT NOT NULL,
  first_seen_at       TEXT DEFAULT (datetime('now')),
  created_at          TEXT DEFAULT (datetime('now'))
);

CREATE TABLE events (   id TEXT PRIMARY KEY,   user_id TEXT NOT NULL,   name TEXT NOT NULL,   date TEXT,   time TEXT,   end_time TEXT,   location TEXT,   created_at TEXT DEFAULT (datetime('now')), campaign_id TEXT, workspace_owner_id TEXT,   FOREIGN KEY (user_id) REFERENCES users(id) );

CREATE TABLE finance_reports_cache (
  id                TEXT PRIMARY KEY,
  state_code        TEXT NOT NULL,
  office_normalized TEXT NOT NULL,
  race_year         INTEGER NOT NULL,
  jurisdiction_name TEXT,
  status            TEXT NOT NULL,
  reports_json      TEXT,
  authority_json    TEXT,
  source            TEXT,
  last_updated      TEXT,
  created_at        TEXT DEFAULT (datetime('now'))
, web_search_excerpt TEXT, web_search_url TEXT);

CREATE TABLE "folders" (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  campaign_id TEXT,
  workspace_owner_id TEXT
);

CREATE TABLE gemini_production_failures (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT,
  workspace_owner_id  TEXT,
  conversation_id     TEXT,
  created_at          TEXT DEFAULT (datetime('now')),

  -- Failure classification. One of:
  --   'timeout'      — geminiCallSam's 15s AbortSignal fired
  --   'rate_limit'   — HTTP 429 from Google
  --   'auth'         — HTTP 401/403 (missing/invalid API key)
  --   '5xx'          — HTTP 5xx (Google upstream)
  --   'malformed'    — response parsed but no candidates/text/usage
  --   'unhandled'    — outer try/catch caught an unexpected exception
  failure_mode        TEXT,

  status_code         INTEGER,    -- HTTP status if applicable, NULL otherwise
  error_message       TEXT        -- truncated 500 chars for triage
, retry_attempt INTEGER DEFAULT 1);

CREATE TABLE invoices (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, subscription_id TEXT, stripe_invoice_id TEXT, amount REAL NOT NULL, currency TEXT DEFAULT 'usd', status TEXT, paid_at TEXT, created_at TEXT DEFAULT (datetime('now')));

CREATE TABLE jurisdiction_lookups (
  id                          TEXT PRIMARY KEY,
  office                      TEXT NOT NULL,
  state                       TEXT NOT NULL,
  jurisdiction_name           TEXT NOT NULL,
  jurisdiction_type           TEXT NOT NULL,
  official_name               TEXT,
  incorporated_municipalities TEXT,
  major_unincorporated_areas  TEXT,
  source                      TEXT,
  last_updated                TEXT,
  created_at                  TEXT DEFAULT (datetime('now'))
);

CREATE TABLE login_attempts (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  success INTEGER NOT NULL,
  attempted_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE "notes" (
  id TEXT PRIMARY KEY,
  folder_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  title TEXT,
  content TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  campaign_id TEXT,
  workspace_owner_id TEXT
);

CREATE TABLE opponents (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, campaign_id TEXT, name TEXT NOT NULL, data TEXT, last_researched_at TEXT, created_at TEXT DEFAULT (datetime('now')), workspace_owner_id TEXT, FOREIGN KEY (user_id) REFERENCES users(id));

CREATE TABLE opposition_notes (
  id                  TEXT PRIMARY KEY,
  workspace_owner_id  TEXT NOT NULL,
  opponent_name       TEXT NOT NULL,
  notes               TEXT,
  created_at          TEXT DEFAULT (datetime('now')),
  updated_at          TEXT DEFAULT (datetime('now'))
);

CREATE TABLE password_reset_tokens (token TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), used_at TEXT);

CREATE TABLE password_resets (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, token TEXT UNIQUE NOT NULL, expires_at TEXT NOT NULL, used INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')));

CREATE TABLE payment_methods (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, stripe_payment_method_id TEXT, type TEXT, last4 TEXT, brand TEXT, exp_month INTEGER, exp_year INTEGER, is_default INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')));

CREATE TABLE profiles (   user_id TEXT PRIMARY KEY,   candidate_name TEXT,   specific_office TEXT,   office_level TEXT,   party TEXT,   location TEXT,   state TEXT,   election_date TEXT,   filing_status TEXT,   win_number INTEGER,   win_number_data TEXT,   onboarding_complete INTEGER DEFAULT 0,   updated_at TEXT DEFAULT (datetime('now')), candidate_site_url TEXT, candidate_site_content TEXT, candidate_site_fetched_at TEXT, candidate_bio_text TEXT, early_voting_start_date TEXT,   FOREIGN KEY (user_id) REFERENCES users(id) );

CREATE TABLE sam_blank_response_events (
  id                  TEXT PRIMARY KEY,
  conversation_id     TEXT,
  workspace_owner_id  TEXT,
  user_id             TEXT,
  original_blanked    INTEGER NOT NULL,
  retry_attempted     INTEGER NOT NULL,
  retry_blanked       INTEGER NOT NULL,
  fallback_used       INTEGER NOT NULL,
  created_at          TEXT DEFAULT (datetime('now'))
);

CREATE TABLE sam_citation_validation_events (
  id                          TEXT PRIMARY KEY,
  conversation_id             TEXT,
  workspace_owner_id          TEXT,
  user_id                     TEXT,
  action_taken                TEXT NOT NULL,
  sam_unverified_claims       TEXT,
  claim_categories            TEXT,
  original_response_excerpt   TEXT,
  final_response_excerpt      TEXT,
  created_at                  TEXT DEFAULT (datetime('now'))
, grounding_used INTEGER DEFAULT 0, sourced_claims_count INTEGER DEFAULT 0, tier1_unsourced_count INTEGER DEFAULT 0, tier2_demoted_count INTEGER DEFAULT 0, tier3_caught_count INTEGER DEFAULT 0, claims_not_found_in_response_count INTEGER DEFAULT 0, grounding_supports_json TEXT);

CREATE TABLE sam_classification_events (
  id                    TEXT PRIMARY KEY,
  conversation_id       TEXT,
  workspace_owner_id    TEXT,
  user_id               TEXT,
  user_message_excerpt  TEXT,
  classified_category   TEXT NOT NULL,
  classifier_failed     INTEGER DEFAULT 0,
  created_at            TEXT DEFAULT (datetime('now'))
);

CREATE TABLE sam_compliance_validation_events (
  id                          TEXT PRIMARY KEY,
  conversation_id             TEXT,
  workspace_owner_id          TEXT,
  user_id                     TEXT,
  action_taken                TEXT NOT NULL,
  sam_claimed_dates           TEXT,
  authoritative_dates         TEXT,
  unauthorized_dates          TEXT,
  original_response_excerpt   TEXT,
  final_response_excerpt      TEXT,
  created_at                  TEXT DEFAULT (datetime('now'))
, sam_claimed_urls TEXT, unauthorized_urls TEXT, fabrication_type TEXT);

CREATE TABLE sam_date_rewrites (
  id                  TEXT PRIMARY KEY,
  conversation_id     TEXT,
  workspace_owner_id  TEXT,
  user_id             TEXT,
  original_message    TEXT,
  rewritten_message   TEXT,
  patterns_matched    TEXT,
  created_at          TEXT DEFAULT (datetime('now'))
);

CREATE TABLE sam_donation_validation_events (
  id                          TEXT PRIMARY KEY,
  conversation_id             TEXT,
  workspace_owner_id          TEXT,
  user_id                     TEXT,
  action_taken                TEXT NOT NULL,
  sam_claimed_amounts         TEXT,
  authoritative_amounts       TEXT,
  unauthorized_amounts        TEXT,
  sam_claimed_urls            TEXT,
  unauthorized_urls           TEXT,
  fabrication_type            TEXT,
  original_response_excerpt   TEXT,
  final_response_excerpt      TEXT,
  created_at                  TEXT DEFAULT (datetime('now'))
);

CREATE TABLE sam_finance_validation_events (
  id                          TEXT PRIMARY KEY,
  conversation_id             TEXT,
  workspace_owner_id          TEXT,
  user_id                     TEXT,
  action_taken                TEXT NOT NULL,
  sam_claimed_dates           TEXT,
  authoritative_dates         TEXT,
  unauthorized_dates          TEXT,
  sam_claimed_urls            TEXT,
  unauthorized_urls           TEXT,
  fabrication_type            TEXT,
  original_response_excerpt   TEXT,
  final_response_excerpt      TEXT,
  created_at                  TEXT DEFAULT (datetime('now'))
);

CREATE TABLE sam_opponent_validation_events (
  id                          TEXT PRIMARY KEY,
  conversation_id             TEXT,
  workspace_owner_id          TEXT,
  user_id                     TEXT,
  action_taken                TEXT NOT NULL,
  opponent_claims_detected    TEXT,
  unauthorized_claims         TEXT,
  blocked_search_query        TEXT,
  original_response_excerpt   TEXT,
  final_response_excerpt      TEXT,
  created_at                  TEXT DEFAULT (datetime('now'))
);

CREATE TABLE sam_rate_bypass_events (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL,
  username          TEXT,
  call_count_today  INTEGER,
  created_at        TEXT DEFAULT (datetime('now'))
);

CREATE TABLE sam_safe_mode_events (
  id                              TEXT PRIMARY KEY,
  conversation_id                 TEXT NOT NULL,
  workspace_owner_id              TEXT,
  user_id                         TEXT,
  trigger_count                   INTEGER NOT NULL,
  activated_at                    TEXT DEFAULT (datetime('now')),
  triggering_validator_breakdown  TEXT
);

CREATE TABLE sam_tool_memory (
  id                  TEXT PRIMARY KEY,
  conversation_id     TEXT NOT NULL,
  workspace_owner_id  TEXT,
  tool_name           TEXT NOT NULL,
  tool_use_id         TEXT,
  parameters          TEXT,
  result              TEXT,
  created_at          TEXT DEFAULT (datetime('now'))
);

CREATE TABLE sam_turn_logs (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT,
  workspace_owner_id  TEXT,
  created_at          TEXT DEFAULT (datetime('now')),
  user_message        TEXT,
  tool_calls          TEXT,
  response_excerpt    TEXT
, conversation_id TEXT);

CREATE TABLE sam_turn_trace (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        TEXT,
  ts             TEXT,
  route          TEXT,
  tools_called   TEXT,
  gemini_error   TEXT,
  was_blank      INTEGER,
  did_retry      INTEGER,
  validator_result TEXT,
  input_tokens   INTEGER,
  output_tokens  INTEGER,
  latency_ms     INTEGER
);

CREATE TABLE sam_validation_events (
  id                          TEXT PRIMARY KEY,
  workspace_owner_id          TEXT,
  user_id                     TEXT,
  created_at                  TEXT DEFAULT (datetime('now')),
  jurisdiction_name           TEXT,
  authorized_count            INTEGER,
  sam_mentioned_locations     TEXT,    -- JSON array of all places Sam mentioned
  unauthorized_locations      TEXT,    -- JSON subset that triggered validation
  action_taken                TEXT,    -- 'passed' | 'regenerated' | 'stripped'
  original_response_excerpt   TEXT,    -- first 600 chars of Sam's first response
  final_response_excerpt      TEXT     -- first 600 chars of what was actually delivered
, conversation_id TEXT);

CREATE TABLE sessions (   session_id TEXT PRIMARY KEY,   user_id TEXT NOT NULL,   created_at TEXT DEFAULT (datetime('now')),   expires_at TEXT NOT NULL, campaign_id TEXT,   FOREIGN KEY (user_id) REFERENCES users(id) );

CREATE TABLE shadow_gemini_log (id TEXT PRIMARY KEY, conversation_id TEXT, user_id TEXT, workspace_owner_id TEXT, turn_index INTEGER, created_at TEXT DEFAULT (datetime('now')), user_message TEXT, classifier_category TEXT, haiku_response TEXT, haiku_latency_ms INTEGER, haiku_validator_results TEXT, gemini_response TEXT, gemini_latency_ms INTEGER, gemini_input_tokens INTEGER, gemini_output_tokens INTEGER, gemini_grounding_used INTEGER, gemini_grounding_urls TEXT, gemini_error TEXT, validator_audit_passes TEXT, validator_audit_failures TEXT);

CREATE TABLE sqlite_sequence(name,seq);

CREATE TABLE sub_users (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL, permissions_json TEXT NOT NULL, status TEXT DEFAULT 'active', created_at TEXT DEFAULT (datetime('now')), last_login TEXT, must_change_password INTEGER DEFAULT 1, last_password_change_at TEXT);

CREATE TABLE subscriptions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, stripe_customer_id TEXT, stripe_subscription_id TEXT, plan TEXT NOT NULL, billing_period TEXT DEFAULT 'monthly', status TEXT DEFAULT 'active', current_period_start TEXT, current_period_end TEXT, cancel_at_period_end INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));

CREATE TABLE tasks (   id TEXT PRIMARY KEY,   user_id TEXT NOT NULL,   name TEXT NOT NULL,   date TEXT,   category TEXT DEFAULT 'general',   completed INTEGER DEFAULT 0,   created_at TEXT DEFAULT (datetime('now')), campaign_id TEXT, workspace_owner_id TEXT,   FOREIGN KEY (user_id) REFERENCES users(id) );

CREATE TABLE usage_logs (   user_id TEXT NOT NULL,   date TEXT NOT NULL,   message_count INTEGER DEFAULT 0,   PRIMARY KEY (user_id, date) );

CREATE TABLE users (   id TEXT PRIMARY KEY,   email TEXT UNIQUE NOT NULL,   created_at TEXT DEFAULT (datetime('now')) , username TEXT, password_hash TEXT, full_name TEXT, plan TEXT DEFAULT 'trial', trial_started TEXT, trial_ends TEXT, status TEXT DEFAULT 'active', is_admin INTEGER DEFAULT 0, is_disabled INTEGER DEFAULT 0, sam_engine TEXT DEFAULT 'haiku', terms_accepted_at TEXT);

CREATE TABLE webhook_events (id TEXT PRIMARY KEY, event_id TEXT, event_type TEXT, matched_user_id TEXT, received_at TEXT NOT NULL DEFAULT (datetime('now')));

