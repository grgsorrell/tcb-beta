-- Safe-mode follow-up: fill NULL compliance_authorities.authority_url with
-- VERIFIED official state election-authority URLs (48 states). Each URL was
-- confirmed via live web search/fetch against the official .gov or *.state.XX.us
-- domain (see SAFEMODE_REPORT.md sweep table for per-state source citations).
-- WY was filled separately (sos.wyo.gov/Elections/); FL already populated.
-- Guarded: only overwrites rows still NULL/empty, matched by state_code, so
-- existing URLs are never clobbered. Applied via:
--   wrangler d1 execute candidates-toolbox-db --remote --file migrations/003_authority_urls.sql

UPDATE compliance_authorities SET authority_url='https://www.elections.alaska.gov/' WHERE state_code='AK' AND (authority_url IS NULL OR TRIM(authority_url)='');
UPDATE compliance_authorities SET authority_url='https://www.sos.alabama.gov/alabama-votes' WHERE state_code='AL' AND (authority_url IS NULL OR TRIM(authority_url)='');
UPDATE compliance_authorities SET authority_url='https://www.sos.arkansas.gov/elections/' WHERE state_code='AR' AND (authority_url IS NULL OR TRIM(authority_url)='');
UPDATE compliance_authorities SET authority_url='https://azsos.gov/elections' WHERE state_code='AZ' AND (authority_url IS NULL OR TRIM(authority_url)='');
UPDATE compliance_authorities SET authority_url='https://www.sos.ca.gov/elections' WHERE state_code='CA' AND (authority_url IS NULL OR TRIM(authority_url)='');
UPDATE compliance_authorities SET authority_url='https://www.sos.state.co.us/pubs/elections/' WHERE state_code='CO' AND (authority_url IS NULL OR TRIM(authority_url)='');
UPDATE compliance_authorities SET authority_url='https://portal.ct.gov/SOTS/Election-Services/V5-Side-Navigation/ELE---Election-Information' WHERE state_code='CT' AND (authority_url IS NULL OR TRIM(authority_url)='');
UPDATE compliance_authorities SET authority_url='https://elections.delaware.gov/' WHERE state_code='DE' AND (authority_url IS NULL OR TRIM(authority_url)='');
UPDATE compliance_authorities SET authority_url='https://sos.ga.gov/elections-division-georgia-secretary-states-office' WHERE state_code='GA' AND (authority_url IS NULL OR TRIM(authority_url)='');
UPDATE compliance_authorities SET authority_url='https://elections.hawaii.gov/' WHERE state_code='HI' AND (authority_url IS NULL OR TRIM(authority_url)='');
UPDATE compliance_authorities SET authority_url='https://sos.iowa.gov/elections-voting' WHERE state_code='IA' AND (authority_url IS NULL OR TRIM(authority_url)='');
UPDATE compliance_authorities SET authority_url='https://sos.idaho.gov/elections-division/' WHERE state_code='ID' AND (authority_url IS NULL OR TRIM(authority_url)='');
UPDATE compliance_authorities SET authority_url='https://www.elections.il.gov/' WHERE state_code='IL' AND (authority_url IS NULL OR TRIM(authority_url)='');
UPDATE compliance_authorities SET authority_url='https://www.in.gov/sos/elections/' WHERE state_code='IN' AND (authority_url IS NULL OR TRIM(authority_url)='');
UPDATE compliance_authorities SET authority_url='https://sos.ks.gov/elections/elections.html' WHERE state_code='KS' AND (authority_url IS NULL OR TRIM(authority_url)='');
UPDATE compliance_authorities SET authority_url='https://www.sos.ky.gov/elections' WHERE state_code='KY' AND (authority_url IS NULL OR TRIM(authority_url)='');
UPDATE compliance_authorities SET authority_url='https://www.sos.la.gov/electionsandvoting/' WHERE state_code='LA' AND (authority_url IS NULL OR TRIM(authority_url)='');
UPDATE compliance_authorities SET authority_url='https://www.sec.state.ma.us/divisions/elections/elections-and-voting.htm' WHERE state_code='MA' AND (authority_url IS NULL OR TRIM(authority_url)='');
UPDATE compliance_authorities SET authority_url='https://elections.maryland.gov/' WHERE state_code='MD' AND (authority_url IS NULL OR TRIM(authority_url)='');
UPDATE compliance_authorities SET authority_url='https://www.maine.gov/sos/elections-voting' WHERE state_code='ME' AND (authority_url IS NULL OR TRIM(authority_url)='');
UPDATE compliance_authorities SET authority_url='https://www.michigan.gov/sos/elections' WHERE state_code='MI' AND (authority_url IS NULL OR TRIM(authority_url)='');
UPDATE compliance_authorities SET authority_url='https://www.sos.mn.gov/elections-voting/' WHERE state_code='MN' AND (authority_url IS NULL OR TRIM(authority_url)='');
UPDATE compliance_authorities SET authority_url='https://www.sos.mo.gov/elections' WHERE state_code='MO' AND (authority_url IS NULL OR TRIM(authority_url)='');
UPDATE compliance_authorities SET authority_url='https://www.sos.ms.gov/elections-voting' WHERE state_code='MS' AND (authority_url IS NULL OR TRIM(authority_url)='');
UPDATE compliance_authorities SET authority_url='https://sosmt.gov/elections/' WHERE state_code='MT' AND (authority_url IS NULL OR TRIM(authority_url)='');
UPDATE compliance_authorities SET authority_url='https://www.ncsbe.gov/' WHERE state_code='NC' AND (authority_url IS NULL OR TRIM(authority_url)='');
UPDATE compliance_authorities SET authority_url='https://www.sos.nd.gov/elections' WHERE state_code='ND' AND (authority_url IS NULL OR TRIM(authority_url)='');
UPDATE compliance_authorities SET authority_url='https://sos.nebraska.gov/elections-division' WHERE state_code='NE' AND (authority_url IS NULL OR TRIM(authority_url)='');
UPDATE compliance_authorities SET authority_url='https://www.sos.nh.gov/elections' WHERE state_code='NH' AND (authority_url IS NULL OR TRIM(authority_url)='');
UPDATE compliance_authorities SET authority_url='https://nj.gov/state/elections/index.shtml' WHERE state_code='NJ' AND (authority_url IS NULL OR TRIM(authority_url)='');
UPDATE compliance_authorities SET authority_url='https://www.sos.nm.gov/voting-and-elections/' WHERE state_code='NM' AND (authority_url IS NULL OR TRIM(authority_url)='');
UPDATE compliance_authorities SET authority_url='https://www.nvsos.gov/elections' WHERE state_code='NV' AND (authority_url IS NULL OR TRIM(authority_url)='');
UPDATE compliance_authorities SET authority_url='https://elections.ny.gov/' WHERE state_code='NY' AND (authority_url IS NULL OR TRIM(authority_url)='');
UPDATE compliance_authorities SET authority_url='https://www.ohiosos.gov/elections/' WHERE state_code='OH' AND (authority_url IS NULL OR TRIM(authority_url)='');
UPDATE compliance_authorities SET authority_url='https://oklahoma.gov/elections.html' WHERE state_code='OK' AND (authority_url IS NULL OR TRIM(authority_url)='');
UPDATE compliance_authorities SET authority_url='https://sos.oregon.gov/elections/Pages/election-information.aspx' WHERE state_code='OR' AND (authority_url IS NULL OR TRIM(authority_url)='');
UPDATE compliance_authorities SET authority_url='https://www.pa.gov/agencies/dos/department-and-offices/be' WHERE state_code='PA' AND (authority_url IS NULL OR TRIM(authority_url)='');
UPDATE compliance_authorities SET authority_url='https://vote.sos.ri.gov/' WHERE state_code='RI' AND (authority_url IS NULL OR TRIM(authority_url)='');
UPDATE compliance_authorities SET authority_url='https://scvotes.gov/' WHERE state_code='SC' AND (authority_url IS NULL OR TRIM(authority_url)='');
UPDATE compliance_authorities SET authority_url='https://sdsos.gov/elections-voting/default.aspx' WHERE state_code='SD' AND (authority_url IS NULL OR TRIM(authority_url)='');
UPDATE compliance_authorities SET authority_url='https://sos.tn.gov/elections' WHERE state_code='TN' AND (authority_url IS NULL OR TRIM(authority_url)='');
UPDATE compliance_authorities SET authority_url='https://www.sos.texas.gov/elections/index.shtml' WHERE state_code='TX' AND (authority_url IS NULL OR TRIM(authority_url)='');
UPDATE compliance_authorities SET authority_url='https://elections.utah.gov/' WHERE state_code='UT' AND (authority_url IS NULL OR TRIM(authority_url)='');
UPDATE compliance_authorities SET authority_url='https://www.elections.virginia.gov/' WHERE state_code='VA' AND (authority_url IS NULL OR TRIM(authority_url)='');
UPDATE compliance_authorities SET authority_url='https://sos.vermont.gov/elections' WHERE state_code='VT' AND (authority_url IS NULL OR TRIM(authority_url)='');
UPDATE compliance_authorities SET authority_url='https://www.sos.wa.gov/elections' WHERE state_code='WA' AND (authority_url IS NULL OR TRIM(authority_url)='');
UPDATE compliance_authorities SET authority_url='https://elections.wi.gov/' WHERE state_code='WI' AND (authority_url IS NULL OR TRIM(authority_url)='');
UPDATE compliance_authorities SET authority_url='https://sos.wv.gov/elections' WHERE state_code='WV' AND (authority_url IS NULL OR TRIM(authority_url)='');
