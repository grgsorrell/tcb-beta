# `/donor/top` — VPS endpoint specification

This endpoint must be deployed on the research VPS at
`research.thecandidatestoolbox.com`. Worker.js's `/api/donor/lookup`
proxies to it; until this endpoint is live, `lookup_top_donors` returns
`status: 'unavailable'` and Sam will defer to fec.gov/data/candidates/.

## Endpoint

`POST /donor/top`

## Auth

`X-Search-Key: <VPS_SEARCH_KEY>` — same shared secret used by the existing
`/candidates/federal` and `/candidate/finances` endpoints.

## Request body

```json
{
  "office": "H" | "S" | "P",
  "state": "LA",
  "district": "05",
  "election_year": 2024,
  "party": "REP" | "DEM" | "IND" | null,
  "incumbent_name": "Julia Letlow" | null,
  "top_n": 20
}
```

- `office` — FEC office code. Required.
- `state` — Two-letter state code. Required.
- `district` — Two-digit padded district number for House. Empty string for Senate/President.
- `election_year` — Two-year cycle, e.g. 2024, 2022.
- `party` — Optional FEC party_short. Worker may send 'R'/'D' shorthand; normalize to FEC values.
- `incumbent_name` — Optional. If provided, skip the roster lookup and resolve this name directly via fuzzy match.
- `top_n` — How many donors to return. Default 20, max 50.

## Behavior

### Step 1 — Resolve `committee_id`

If `incumbent_name` is provided, fuzzy-match it against the FEC roster
for (office, state, district, election_year). Same fuzzy-match logic as
the existing `/candidates/federal` endpoint.

If `incumbent_name` is empty, return the top match by activity_status
('I' if available, else first).

If no match: respond `{ "success": false, "status": "no_match" }`.

Once you have a `candidate_id`, query FEC `/v1/candidate/{candidate_id}/committees/`
to get the candidate's **principal campaign committee** (`designation: 'P'`).
Use that committee's `committee_id` for Schedule A.

### Step 2 — Query FEC Schedule A

```
GET https://api.open.fec.gov/v1/schedule_a/
  ?api_key=<FEC_API_KEY>
  &committee_id=<committee_id>
  &two_year_transaction_period=<election_year>
  &is_individual=true
  &sort=-contribution_receipt_amount
  &per_page=<top_n>
```

(`two_year_transaction_period` must be even — 2022, 2024, 2026.)

### Step 3 — Format response

```json
{
  "success": true,
  "candidate_name": "Julia Letlow",
  "candidate_id": "H1LA05122",
  "committee_id": "C00738468",
  "committee_url": "https://www.fec.gov/data/committee/C00738468/",
  "donors": [
    {
      "name": "John Smith",
      "amount": 6600,
      "employer": "Acme Corp",
      "occupation": "CEO",
      "city": "Monroe",
      "state": "LA",
      "zip": "71201",
      "contribution_date": "2024-03-15"
    },
    ...
  ]
}
```

Each donor row is built from these FEC fields:
- `contributor_name` → `name`
- `contribution_receipt_amount` → `amount`
- `contributor_employer` → `employer`
- `contributor_occupation` → `occupation`
- `contributor_city` → `city`
- `contributor_state` → `state`
- `contributor_zip` → `zip`
- `contribution_receipt_date` → `contribution_date`

## Failure responses

```json
{ "success": false, "status": "no_match", "message": "No candidate matched the inputs." }
{ "success": false, "status": "empty", "message": "Committee resolved but no donor rows returned." }
{ "success": false, "status": "fec_error", "message": "FEC API returned <code>." }
```

## Caching (optional)

Past-cycle Schedule A data is stable. Consider in-memory or Redis cache
keyed on `(committee_id, election_year, top_n)` with a long TTL (30 days).
Current-cycle data updates ~monthly per FEC reporting calendar — short
TTL (~24h) is fine.

## Rate limits

FEC API has a default rate limit of 1,000 requests/hour per key. Each
`/donor/top` call hits FEC twice (roster + schedule_a) or three times
(roster + committee lookup + schedule_a). Stay under 300 endpoint calls
per hour to be safe.
