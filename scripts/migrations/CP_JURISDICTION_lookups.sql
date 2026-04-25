-- Jurisdiction lookups cache table.
--
-- Backs the lookup_jurisdiction Sam tool, which gives Sam a verified
-- list of incorporated municipalities and unincorporated areas inside
-- a candidate's race jurisdiction. Without this, Sam hallucinates
-- adjacent-county cities (e.g. suggesting Altamonte Springs / Sanford
-- in Seminole County for an Orange County, FL Mayor race).
--
-- Cache TTL is 90 days — jurisdiction containment is stable data
-- (changes only on annexation or redistricting). Refresh-by-deletion
-- if the user reports stale data. Explicit refresh affordance in the
-- UI is deferred.
--
-- Lookup is workspace-agnostic — same jurisdiction returns the same
-- result regardless of which workspace asks. Cache key is
-- (office, state, jurisdiction_name); UNIQUE index enforces upsert.
--
-- source field tags which path resolved the lookup:
--   'Wikipedia'    — Wikipedia category-members API (counties, cities)
--   'OpenStates'   — OpenStates districts API (state legislative)
--   'Census'       — Census Tigerweb (US House districts) [future]
--   'identity'     — city races; jurisdiction IS the city, no children
--   'unsupported'  — type detection failed; Sam should fall back to
--                    broad guidance and flag the gap to the user
--
-- incorporated_municipalities and major_unincorporated_areas are
-- JSON arrays of strings.
--
-- Rollback: DROP TABLE jurisdiction_lookups.

CREATE TABLE IF NOT EXISTS jurisdiction_lookups (
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

CREATE UNIQUE INDEX IF NOT EXISTS idx_jurisdiction_lookup
  ON jurisdiction_lookups(office, state, jurisdiction_name);
