-- Punch-list item 4 (the one permitted D1 write): update Louisiana
-- campaign_reference rows for the 2026 U.S. House cycle.
--
-- Change: Act 7 of the 2026 Regular Session moved U.S. House races onto the
-- Nov 3, 2026 OPEN ("jungle") primary ballot (Dec 12, 2026 general runoff if
-- needed), same as state/parish offices; the earlier May 16, 2026 CLOSED
-- federal primary was cancelled; qualifying opens Aug 5, 2026 and closes
-- Aug 7, 2026 at 4:30 p.m.
--
-- Source stored with the rows: Act 7 of the 2026 Regular Session + LA SOS
-- release sos.la.gov/OurOffice/PublishedDocuments/05.14.26FallHouseRaces.pdf
--
-- Applied via:
--   wrangler d1 execute candidates-toolbox-db --remote --file migrations/002_la_house_2026.sql

UPDATE campaign_reference SET
  answer = 'As of Act 7 of the 2026 Regular Session, U.S. House races have been MOVED onto Louisiana''s Nov 3, 2026 open "jungle" primary ballot (the same open-primary system used for state and parish offices), with a Dec 12, 2026 general runoff if no candidate wins an outright majority. The earlier plan for a separate closed partisan U.S. House primary — the cancelled May 16, 2026 closed-primary races — no longer applies. U.S. Senate is not on the 2026 ballot. So for 2026, U.S. House candidates run in the same open primary as state offices.',
  source_name = 'Louisiana Act 7 of 2026 Regular Session; LA Secretary of State release (2026-05-14)',
  source_url = 'https://www.sos.la.gov/OurOffice/PublishedDocuments/05.14.26FallHouseRaces.pdf',
  last_verified_date = '2026-07-02',
  update_frequency = 'per_cycle',
  updated_at = datetime('now')
WHERE id = '56a2dabafbc9ca70';

UPDATE campaign_reference SET
  answer = 'Per Act 7 of the 2026 Regular Session, U.S. House races are on the Nov 3, 2026 open primary ballot, with a Dec 12, 2026 general runoff if no candidate receives a majority — the same open-primary schedule used for state and parish offices. The previously scheduled May 16, 2026 closed federal primary was cancelled. State and parish offices remain on the Nov 3, 2026 open primary as well.',
  source_name = 'Louisiana Act 7 of 2026 Regular Session; LA Secretary of State release (2026-05-14)',
  source_url = 'https://www.sos.la.gov/OurOffice/PublishedDocuments/05.14.26FallHouseRaces.pdf',
  last_verified_date = '2026-07-02',
  update_frequency = 'per_cycle',
  updated_at = datetime('now')
WHERE id = '082540aec9f1b04d';

UPDATE campaign_reference SET
  answer = 'For the Nov 3, 2026 open primary — which now includes U.S. House races (per Act 7 of the 2026 Regular Session) alongside state and parish offices — the qualifying period opens Wednesday, Aug 5, 2026 and closes Friday, Aug 7, 2026 at 4:30 p.m. The earlier split/closed-primary qualifying schedule for U.S. House was cancelled.',
  source_name = 'Louisiana Act 7 of 2026 Regular Session; LA Secretary of State release (2026-05-14)',
  source_url = 'https://www.sos.la.gov/OurOffice/PublishedDocuments/05.14.26FallHouseRaces.pdf',
  last_verified_date = '2026-07-02',
  update_frequency = 'per_cycle',
  updated_at = datetime('now')
WHERE id = '7b05300ec0cff83e';
