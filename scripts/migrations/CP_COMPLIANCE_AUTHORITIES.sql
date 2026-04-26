-- Compliance authorities — authority contact stub data.
--
-- Backs the authority field returned by lookup_compliance_deadlines
-- (and the retrofit lookup_jurisdiction unsupported case). Always
-- queryable so Sam has someone to defer to even when she can't get
-- verified deadline data.
--
-- This checkpoint populates STUB data only:
--   - 50 state-level rows, one per US state
--   - 1 default_unknown fallback row
--
-- The authority_name uses the "Secretary of State" pattern — this is
-- generally close to correct for most states but exact division names
-- vary (Wisconsin uses an Elections Commission; Florida's is under
-- Department of State; etc.). Real population with exact names,
-- verified phone numbers, and county/city-level coverage is a future
-- checkpoint. The placeholder phone "(verify on state government
-- website)" makes the stub status explicit so Sam doesn't read fake
-- digits to a user.
--
-- Rollback: DROP TABLE compliance_authorities.

CREATE TABLE IF NOT EXISTS compliance_authorities (
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

CREATE INDEX IF NOT EXISTS idx_compliance_auth_lookup
  ON compliance_authorities(state_code, jurisdiction_type, jurisdiction_name);

-- Default fallback for when state-level lookup misses entirely.
INSERT OR IGNORE INTO compliance_authorities
  (id, state_code, jurisdiction_type, jurisdiction_name, authority_name, authority_phone, authority_url, notes)
VALUES
  ('seed_default', 'XX', 'default_unknown', NULL,
   'state elections office',
   '(search "<state> secretary of state elections" online for current contact info)',
   NULL,
   'No verified contact data for this jurisdiction. Search the state government website for the elections division contact.');

-- 50 state-level seed rows. authority_name uses a "Secretary of State"
-- pattern; phone and url are explicit placeholders.
INSERT OR IGNORE INTO compliance_authorities (id, state_code, jurisdiction_type, jurisdiction_name, authority_name, authority_phone, authority_url, notes) VALUES
  ('seed_AL', 'AL', 'state', NULL, 'Alabama Secretary of State - Elections Division', '(verify on state government website)', NULL, 'Stub data — verify exact contact info and division responsible for elections at the state government website.'),
  ('seed_AK', 'AK', 'state', NULL, 'Alaska Division of Elections',                       '(verify on state government website)', NULL, 'Stub data — verify exact contact info and division responsible for elections at the state government website.'),
  ('seed_AZ', 'AZ', 'state', NULL, 'Arizona Secretary of State - Elections Division',    '(verify on state government website)', NULL, 'Stub data — verify exact contact info and division responsible for elections at the state government website.'),
  ('seed_AR', 'AR', 'state', NULL, 'Arkansas Secretary of State - Elections Division',   '(verify on state government website)', NULL, 'Stub data — verify exact contact info and division responsible for elections at the state government website.'),
  ('seed_CA', 'CA', 'state', NULL, 'California Secretary of State - Elections Division', '(verify on state government website)', NULL, 'Stub data — verify exact contact info and division responsible for elections at the state government website.'),
  ('seed_CO', 'CO', 'state', NULL, 'Colorado Secretary of State - Elections Division',   '(verify on state government website)', NULL, 'Stub data — verify exact contact info and division responsible for elections at the state government website.'),
  ('seed_CT', 'CT', 'state', NULL, 'Connecticut Secretary of the State - Elections Division', '(verify on state government website)', NULL, 'Stub data — verify exact contact info and division responsible for elections at the state government website.'),
  ('seed_DE', 'DE', 'state', NULL, 'Delaware Department of Elections',                   '(verify on state government website)', NULL, 'Stub data — verify exact contact info and division responsible for elections at the state government website.'),
  ('seed_FL', 'FL', 'state', NULL, 'Florida Department of State - Division of Elections', '(verify on state government website)', NULL, 'Stub data — verify exact contact info and division responsible for elections at the state government website.'),
  ('seed_GA', 'GA', 'state', NULL, 'Georgia Secretary of State - Elections Division',    '(verify on state government website)', NULL, 'Stub data — verify exact contact info and division responsible for elections at the state government website.'),
  ('seed_HI', 'HI', 'state', NULL, 'Hawaii Office of Elections',                          '(verify on state government website)', NULL, 'Stub data — verify exact contact info and division responsible for elections at the state government website.'),
  ('seed_ID', 'ID', 'state', NULL, 'Idaho Secretary of State - Elections Division',      '(verify on state government website)', NULL, 'Stub data — verify exact contact info and division responsible for elections at the state government website.'),
  ('seed_IL', 'IL', 'state', NULL, 'Illinois State Board of Elections',                  '(verify on state government website)', NULL, 'Stub data — verify exact contact info and division responsible for elections at the state government website.'),
  ('seed_IN', 'IN', 'state', NULL, 'Indiana Secretary of State - Elections Division',    '(verify on state government website)', NULL, 'Stub data — verify exact contact info and division responsible for elections at the state government website.'),
  ('seed_IA', 'IA', 'state', NULL, 'Iowa Secretary of State - Elections Division',       '(verify on state government website)', NULL, 'Stub data — verify exact contact info and division responsible for elections at the state government website.'),
  ('seed_KS', 'KS', 'state', NULL, 'Kansas Secretary of State - Elections Division',     '(verify on state government website)', NULL, 'Stub data — verify exact contact info and division responsible for elections at the state government website.'),
  ('seed_KY', 'KY', 'state', NULL, 'Kentucky Secretary of State - Elections Division',   '(verify on state government website)', NULL, 'Stub data — verify exact contact info and division responsible for elections at the state government website.'),
  ('seed_LA', 'LA', 'state', NULL, 'Louisiana Secretary of State - Elections Division',  '(verify on state government website)', NULL, 'Stub data — verify exact contact info and division responsible for elections at the state government website.'),
  ('seed_ME', 'ME', 'state', NULL, 'Maine Secretary of State - Bureau of Corporations, Elections and Commissions', '(verify on state government website)', NULL, 'Stub data — verify exact contact info and division responsible for elections at the state government website.'),
  ('seed_MD', 'MD', 'state', NULL, 'Maryland State Board of Elections',                  '(verify on state government website)', NULL, 'Stub data — verify exact contact info and division responsible for elections at the state government website.'),
  ('seed_MA', 'MA', 'state', NULL, 'Massachusetts Secretary of the Commonwealth - Elections Division', '(verify on state government website)', NULL, 'Stub data — verify exact contact info and division responsible for elections at the state government website.'),
  ('seed_MI', 'MI', 'state', NULL, 'Michigan Secretary of State - Bureau of Elections',  '(verify on state government website)', NULL, 'Stub data — verify exact contact info and division responsible for elections at the state government website.'),
  ('seed_MN', 'MN', 'state', NULL, 'Minnesota Secretary of State - Elections Division',  '(verify on state government website)', NULL, 'Stub data — verify exact contact info and division responsible for elections at the state government website.'),
  ('seed_MS', 'MS', 'state', NULL, 'Mississippi Secretary of State - Elections Division', '(verify on state government website)', NULL, 'Stub data — verify exact contact info and division responsible for elections at the state government website.'),
  ('seed_MO', 'MO', 'state', NULL, 'Missouri Secretary of State - Elections Division',   '(verify on state government website)', NULL, 'Stub data — verify exact contact info and division responsible for elections at the state government website.'),
  ('seed_MT', 'MT', 'state', NULL, 'Montana Secretary of State - Elections and Voter Services Division', '(verify on state government website)', NULL, 'Stub data — verify exact contact info and division responsible for elections at the state government website.'),
  ('seed_NE', 'NE', 'state', NULL, 'Nebraska Secretary of State - Elections Division',   '(verify on state government website)', NULL, 'Stub data — verify exact contact info and division responsible for elections at the state government website.'),
  ('seed_NV', 'NV', 'state', NULL, 'Nevada Secretary of State - Elections Division',     '(verify on state government website)', NULL, 'Stub data — verify exact contact info and division responsible for elections at the state government website.'),
  ('seed_NH', 'NH', 'state', NULL, 'New Hampshire Secretary of State - Elections Division', '(verify on state government website)', NULL, 'Stub data — verify exact contact info and division responsible for elections at the state government website.'),
  ('seed_NJ', 'NJ', 'state', NULL, 'New Jersey Department of State - Division of Elections', '(verify on state government website)', NULL, 'Stub data — verify exact contact info and division responsible for elections at the state government website.'),
  ('seed_NM', 'NM', 'state', NULL, 'New Mexico Secretary of State - Bureau of Elections', '(verify on state government website)', NULL, 'Stub data — verify exact contact info and division responsible for elections at the state government website.'),
  ('seed_NY', 'NY', 'state', NULL, 'New York State Board of Elections',                  '(verify on state government website)', NULL, 'Stub data — verify exact contact info and division responsible for elections at the state government website.'),
  ('seed_NC', 'NC', 'state', NULL, 'North Carolina State Board of Elections',            '(verify on state government website)', NULL, 'Stub data — verify exact contact info and division responsible for elections at the state government website.'),
  ('seed_ND', 'ND', 'state', NULL, 'North Dakota Secretary of State - Elections Unit',   '(verify on state government website)', NULL, 'Stub data — verify exact contact info and division responsible for elections at the state government website.'),
  ('seed_OH', 'OH', 'state', NULL, 'Ohio Secretary of State - Elections Division',       '(verify on state government website)', NULL, 'Stub data — verify exact contact info and division responsible for elections at the state government website.'),
  ('seed_OK', 'OK', 'state', NULL, 'Oklahoma State Election Board',                       '(verify on state government website)', NULL, 'Stub data — verify exact contact info and division responsible for elections at the state government website.'),
  ('seed_OR', 'OR', 'state', NULL, 'Oregon Secretary of State - Elections Division',     '(verify on state government website)', NULL, 'Stub data — verify exact contact info and division responsible for elections at the state government website.'),
  ('seed_PA', 'PA', 'state', NULL, 'Pennsylvania Department of State - Bureau of Commissions, Elections and Legislation', '(verify on state government website)', NULL, 'Stub data — verify exact contact info and division responsible for elections at the state government website.'),
  ('seed_RI', 'RI', 'state', NULL, 'Rhode Island Secretary of State - Elections Division', '(verify on state government website)', NULL, 'Stub data — verify exact contact info and division responsible for elections at the state government website.'),
  ('seed_SC', 'SC', 'state', NULL, 'South Carolina Election Commission',                  '(verify on state government website)', NULL, 'Stub data — verify exact contact info and division responsible for elections at the state government website.'),
  ('seed_SD', 'SD', 'state', NULL, 'South Dakota Secretary of State - Elections Division', '(verify on state government website)', NULL, 'Stub data — verify exact contact info and division responsible for elections at the state government website.'),
  ('seed_TN', 'TN', 'state', NULL, 'Tennessee Secretary of State - Division of Elections', '(verify on state government website)', NULL, 'Stub data — verify exact contact info and division responsible for elections at the state government website.'),
  ('seed_TX', 'TX', 'state', NULL, 'Texas Secretary of State - Elections Division',      '(verify on state government website)', NULL, 'Stub data — verify exact contact info and division responsible for elections at the state government website.'),
  ('seed_UT', 'UT', 'state', NULL, 'Utah Lieutenant Governor - Elections Office',         '(verify on state government website)', NULL, 'Stub data — verify exact contact info and division responsible for elections at the state government website.'),
  ('seed_VT', 'VT', 'state', NULL, 'Vermont Secretary of State - Elections Division',    '(verify on state government website)', NULL, 'Stub data — verify exact contact info and division responsible for elections at the state government website.'),
  ('seed_VA', 'VA', 'state', NULL, 'Virginia Department of Elections',                    '(verify on state government website)', NULL, 'Stub data — verify exact contact info and division responsible for elections at the state government website.'),
  ('seed_WA', 'WA', 'state', NULL, 'Washington Secretary of State - Elections Division', '(verify on state government website)', NULL, 'Stub data — verify exact contact info and division responsible for elections at the state government website.'),
  ('seed_WV', 'WV', 'state', NULL, 'West Virginia Secretary of State - Elections Division', '(verify on state government website)', NULL, 'Stub data — verify exact contact info and division responsible for elections at the state government website.'),
  ('seed_WI', 'WI', 'state', NULL, 'Wisconsin Elections Commission',                      '(verify on state government website)', NULL, 'Stub data — verify exact contact info and division responsible for elections at the state government website.'),
  ('seed_WY', 'WY', 'state', NULL, 'Wyoming Secretary of State - Elections Division',    '(verify on state government website)', NULL, 'Stub data — verify exact contact info and division responsible for elections at the state government website.');
