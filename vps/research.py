from flask import Flask, request, jsonify
import requests
import os
from dotenv import load_dotenv
from datetime import datetime, timedelta
import trafilatura
from bs4 import BeautifulSoup
import re
import time

load_dotenv()

app = Flask(__name__)

API_KEY = "6j0e2psavrylnhzq51dtf874i9ucwg3bxokm"
FEC_API_KEY = os.getenv('FEC_API_KEY')
OPENSTATES_API_KEY = os.getenv('OPENSTATES_API_KEY')
FEC_BASE_URL = "https://api.open.fec.gov/v1"
OPENSTATES_BASE_URL = "https://v3.openstates.org"
SEARXNG_URL = "http://localhost:8080/search"

cache = {}
CACHE_TTL_HOURS = 24

def check_auth():
    key = request.headers.get('X-Search-Key')
    return key == API_KEY

def get_cached(key):
    if key in cache:
        entry = cache[key]
        if datetime.now() < entry['expires']:
            return entry['data']
        else:
            del cache[key]
    return None

def set_cached(key, data):
    cache[key] = {
        'data': data,
        'expires': datetime.now() + timedelta(hours=CACHE_TTL_HOURS)
    }

@app.route('/health', methods=['GET'])
def health():
    return jsonify({
        "ok": True,
        "service": "tcb-research",
        "fec_key_set": bool(FEC_API_KEY),
        "openstates_key_set": bool(OPENSTATES_API_KEY)
    })

# ============================================================
# FEC ENDPOINTS
# ============================================================

@app.route('/candidates/federal', methods=['POST'])
def federal_candidates():
    if not check_auth():
        return jsonify({"error": "unauthorized"}), 401

    data = request.json
    office = data.get('office', '').upper()
    state = data.get('state', '').upper()
    district = data.get('district', '')
    election_year = data.get('election_year', datetime.now().year)

    if not office or not state:
        return jsonify({"error": "office and state required"}), 400

    cache_key = f"fec_{office}_{state}_{district}_{election_year}"
    cached = get_cached(cache_key)
    if cached:
        return jsonify({**cached, "from_cache": True})

    try:
        params = {
            'api_key': FEC_API_KEY,
            'office': office,
            'state': state,
            'election_year': election_year,
            'per_page': 50
        }

        if district and office == 'H':
            params['district'] = district.zfill(2)

        response = requests.get(
            f"{FEC_BASE_URL}/candidates/search/",
            params=params,
            timeout=15
        )

        if response.status_code != 200:
            return jsonify({
                "success": False,
                "error": f"FEC API error: {response.status_code}"
            }), 500

        fec_data = response.json()
        candidates = []

        for c in fec_data.get('results', []):
            candidate = {
                'name': c.get('name', ''),
                'candidate_id': c.get('candidate_id', ''),
                'party': c.get('party_full', ''),
                'party_short': c.get('party', ''),
                'office': c.get('office_full', ''),
                'state': c.get('state', ''),
                'district': c.get('district', ''),
                'incumbent_challenge': c.get('incumbent_challenge_full', ''),
                'first_file_date': c.get('first_file_date', ''),
                'last_file_date': c.get('last_file_date', ''),
                'has_raised_funds': c.get('has_raised_funds', False),
                'candidate_status': c.get('candidate_status', ''),
                'active_through': c.get('active_through', 0),
                'committees': []
            }

            for comm in c.get('principal_committees', []):
                candidate['committees'].append({
                    'name': comm.get('name', ''),
                    'committee_id': comm.get('committee_id', ''),
                    'last_file_date': comm.get('last_file_date', '')
                })

            candidate['activity_status'] = determine_activity_status(candidate)
            candidates.append(candidate)

        result = {
            "success": True,
            "race": f"{office} {state} {district} {election_year}",
            "candidates": candidates,
            "total": len(candidates),
            "source": "fec_api"
        }

        set_cached(cache_key, result)
        return jsonify(result)

    except Exception as e:
        return jsonify({
            "success": False,
            "error": str(e)
        }), 500

@app.route('/candidate/finances', methods=['POST'])
def candidate_finances():
    if not check_auth():
        return jsonify({"error": "unauthorized"}), 401

    data = request.json
    candidate_id = data.get('candidate_id', '')
    cycle = data.get('cycle', datetime.now().year)

    if not candidate_id:
        return jsonify({"error": "candidate_id required"}), 400

    cache_key = f"finance_{candidate_id}_{cycle}"
    cached = get_cached(cache_key)
    if cached:
        return jsonify({**cached, "from_cache": True})

    try:
        response = requests.get(
            f"{FEC_BASE_URL}/candidate/{candidate_id}/totals/",
            params={'api_key': FEC_API_KEY, 'cycle': cycle},
            timeout=15
        )

        if response.status_code != 200:
            return jsonify({"success": False, "error": "FEC API error"}), 500

        fec_data = response.json()
        results = fec_data.get('results', [])

        if not results:
            return jsonify({
                "success": True,
                "candidate_id": candidate_id,
                "has_data": False,
                "message": "No financial data filed"
            })

        totals = results[0]
        result = {
            "success": True,
            "candidate_id": candidate_id,
            "has_data": True,
            "summary": {
                "total_raised": totals.get('receipts', 0),
                "total_contributions": totals.get('contributions', 0),
                "individual_contributions": totals.get('individual_contributions', 0),
                "pac_contributions": totals.get('other_political_committee_contributions', 0),
                "party_contributions": totals.get('political_party_committee_contributions', 0),
                "total_spent": totals.get('disbursements', 0),
                "cash_on_hand": totals.get('last_cash_on_hand_end_period', 0),
                "debts": totals.get('last_debts_owed_by_committee', 0),
                "self_loans": totals.get('loans_made_by_candidate', 0),
                "last_report": totals.get('last_report_type_full', ''),
                "last_report_year": totals.get('last_report_year', 0),
                "coverage_end": totals.get('coverage_end_date', '')
            }
        }

        set_cached(cache_key, result)
        return jsonify(result)

    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

def determine_activity_status(candidate):
    last_file = candidate.get('last_file_date', '')
    fec_status = candidate.get('candidate_status', '')
    has_funds = candidate.get('has_raised_funds', False)

    if not last_file:
        return 'unknown'

    try:
        last_date = datetime.fromisoformat(last_file.replace('Z', '+00:00').split('T')[0])
        days_since = (datetime.now() - last_date).days

        if fec_status == 'C':
            return 'active'
        if days_since < 90:
            return 'active'
        if days_since > 180 and not has_funds:
            return 'inactive'
        if days_since < 180:
            return 'possibly_active'

        return 'inactive'
    except:
        return 'unknown'

@app.route('/race/full', methods=['POST'])
def full_race_analysis():
    if not check_auth():
        return jsonify({"error": "unauthorized"}), 401

    data = request.json
    office = data.get('office', '').upper()
    state = data.get('state', '').upper()
    district = data.get('district', '')
    election_year = data.get('election_year', datetime.now().year)

    if not office or not state:
        return jsonify({"error": "office and state required"}), 400

    cache_key = f"race_{office}_{state}_{district}_{election_year}"
    cached = get_cached(cache_key)
    if cached:
        return jsonify({**cached, "from_cache": True})

    try:
        params = {
            'api_key': FEC_API_KEY,
            'office': office,
            'state': state,
            'election_year': election_year,
            'per_page': 50
        }

        if district and office == 'H':
            params['district'] = district.zfill(2)

        response = requests.get(
            f"{FEC_BASE_URL}/candidates/search/",
            params=params,
            timeout=15
        )

        fec_data = response.json()
        candidates = []

        for c in fec_data.get('results', []):
            candidate = {
                'name': c.get('name', ''),
                'candidate_id': c.get('candidate_id', ''),
                'party': c.get('party_full', ''),
                'party_short': c.get('party', ''),
                'district': c.get('district', ''),
                'incumbent_challenge': c.get('incumbent_challenge_full', ''),
                'last_file_date': c.get('last_file_date', ''),
                'candidate_status': c.get('candidate_status', ''),
                'has_raised_funds': c.get('has_raised_funds', False),
                'activity_status': determine_activity_status({
                    'last_file_date': c.get('last_file_date', ''),
                    'candidate_status': c.get('candidate_status', ''),
                    'has_raised_funds': c.get('has_raised_funds', False)
                })
            }

            try:
                fin_response = requests.get(
                    f"{FEC_BASE_URL}/candidate/{c['candidate_id']}/totals/",
                    params={'api_key': FEC_API_KEY, 'cycle': election_year},
                    timeout=10
                )

                if fin_response.status_code == 200:
                    fin_data = fin_response.json()
                    fin_results = fin_data.get('results', [])

                    if fin_results:
                        totals = fin_results[0]
                        candidate['finances'] = {
                            'total_raised': totals.get('receipts', 0),
                            'cash_on_hand': totals.get('last_cash_on_hand_end_period', 0),
                            'total_spent': totals.get('disbursements', 0),
                            'individual_contributions': totals.get('individual_contributions', 0),
                            'pac_contributions': totals.get('other_political_committee_contributions', 0),
                            'debts': totals.get('last_debts_owed_by_committee', 0),
                            'self_loans': totals.get('loans_made_by_candidate', 0),
                            'last_report': totals.get('last_report_type_full', '')
                        }
                    else:
                        candidate['finances'] = None
                else:
                    candidate['finances'] = None
            except:
                candidate['finances'] = None

            candidates.append(candidate)

        result = {
            "success": True,
            "race": f"{office} {state} {district} {election_year}",
            "candidates": candidates,
            "total": len(candidates),
            "active_count": len([c for c in candidates if c['activity_status'] == 'active']),
            "inactive_count": len([c for c in candidates if c['activity_status'] == 'inactive']),
            "source": "fec_api"
        }

        set_cached(cache_key, result)
        return jsonify(result)

    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

# ============================================================
# OPENSTATES ENDPOINTS
# ============================================================

@app.route('/legislator/lookup', methods=['POST'])
def legislator_lookup():
    if not check_auth():
        return jsonify({"error": "unauthorized"}), 401

    data = request.json
    name = data.get('name', '')
    state = data.get('state', '').lower()
    chamber = data.get('chamber', '')

    if not name or not state:
        return jsonify({"error": "name and state required"}), 400

    cache_key = f"openstates_lookup_{state}_{name}_{chamber}"
    cached = get_cached(cache_key)
    if cached:
        return jsonify({**cached, "from_cache": True})

    try:
        params = {
            'jurisdiction': state,
            'name': name,
            'apikey': OPENSTATES_API_KEY,
            'per_page': 10
        }

        if chamber:
            params['org_classification'] = chamber

        response = requests.get(
            f"{OPENSTATES_BASE_URL}/people",
            params=params,
            timeout=15
        )

        if response.status_code != 200:
            return jsonify({
                "success": False,
                "error": f"OpenStates API error: {response.status_code}"
            }), 500

        os_data = response.json()
        legislators = []

        for p in os_data.get('results', []):
            legislator = {
                'id': p.get('id', ''),
                'name': p.get('name', ''),
                'party': p.get('party', ''),
                'given_name': p.get('given_name', ''),
                'family_name': p.get('family_name', ''),
                'email': p.get('email', ''),
                'image': p.get('image', ''),
                'birth_date': p.get('birth_date', ''),
                'openstates_url': p.get('openstates_url', '')
            }

            role = p.get('current_role', {})
            if role:
                legislator['title'] = role.get('title', '')
                legislator['district'] = role.get('district', '')
                legislator['chamber'] = role.get('org_classification', '')

            legislators.append(legislator)

        result = {
            "success": True,
            "query": {"name": name, "state": state, "chamber": chamber},
            "legislators": legislators,
            "total": len(legislators),
            "source": "openstates_api"
        }

        set_cached(cache_key, result)
        return jsonify(result)

    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

@app.route('/legislator/by-district', methods=['POST'])
def legislator_by_district():
    if not check_auth():
        return jsonify({"error": "unauthorized"}), 401

    data = request.json
    state = data.get('state', '').lower()
    chamber = data.get('chamber', 'lower')
    district = data.get('district', '')

    if not state or not district:
        return jsonify({"error": "state and district required"}), 400

    cache_key = f"openstates_district_{state}_{chamber}_{district}"
    cached = get_cached(cache_key)
    if cached:
        return jsonify({**cached, "from_cache": True})

    try:
        params = {
            'jurisdiction': state,
            'org_classification': chamber,
            'district': district,
            'apikey': OPENSTATES_API_KEY,
            'per_page': 10
        }

        response = requests.get(
            f"{OPENSTATES_BASE_URL}/people",
            params=params,
            timeout=15
        )

        if response.status_code != 200:
            return jsonify({"success": False, "error": "OpenStates API error"}), 500

        os_data = response.json()
        legislators = []

        for p in os_data.get('results', []):
            role = p.get('current_role', {})
            legislator = {
                'id': p.get('id', ''),
                'name': p.get('name', ''),
                'party': p.get('party', ''),
                'title': role.get('title', '') if role else '',
                'district': role.get('district', '') if role else '',
                'chamber': role.get('org_classification', '') if role else '',
                'email': p.get('email', ''),
                'image': p.get('image', ''),
                'openstates_url': p.get('openstates_url', '')
            }
            legislators.append(legislator)

        result = {
            "success": True,
            "legislators": legislators,
            "total": len(legislators),
            "source": "openstates_api"
        }

        set_cached(cache_key, result)
        return jsonify(result)

    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

# ============================================================
# BALLOTPEDIA — BeautifulSoup structured parser
# ============================================================

def search_ballotpedia_urls(query, max_results=5):
    """Use SearXNG to find relevant Ballotpedia URLs"""
    try:
        params = {
            "q": f"site:ballotpedia.org {query}",
            "format": "json",
            "categories": "general",
            "language": "en"
        }

        response = requests.get(SEARXNG_URL, params=params, timeout=10)
        data = response.json()

        urls = []
        for result in data.get('results', [])[:max_results]:
            url = result.get('url', '')
            if 'ballotpedia.org' in url and 'news.ballotpedia' not in url:
                urls.append({
                    'url': url,
                    'title': result.get('title', ''),
                    'snippet': result.get('content', '')
                })

        return urls
    except Exception as e:
        return []

def fetch_ballotpedia_html(url, timeout=60):
    """Fetch raw HTML from Ballotpedia"""
    try:
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
        response = requests.get(url, headers=headers, timeout=timeout)

        if response.status_code != 200:
            return None

        return response.text
    except Exception as e:
        return None

def extract_candidates_from_text(text):
    """Extract candidate names from Ballotpedia prose using patterns"""
    candidates = []

    # Pattern 1: "X, Y, and Z are running in the [primary/general] for..."
    pattern1 = r'([\w\s\.\-\']+(?:,\s+[\w\s\.\-\']+)*(?:,?\s+and\s+[\w\s\.\-\']+)?)\s+(?:are|is|ran|are running|ran in|advanced from)\s+(?:in\s+)?the\s+(Democratic|Republican|Libertarian|Green|nonpartisan|general)'

    for match in re.finditer(pattern1, text, re.IGNORECASE):
        names_str = match.group(1)
        party = match.group(2)

        # Split on commas and "and"
        names = re.split(r',\s*(?:and\s+)?|\s+and\s+', names_str)

        for name in names:
            name = name.strip()
            if name and len(name) > 2 and len(name) < 60:
                # Filter out common false positives
                if not any(skip in name.lower() for skip in ['the ', 'a ', 'an ', 'following', 'candidates', 'incumbent']):
                    candidates.append({
                        'name': name,
                        'party': party,
                        'source': 'prose_pattern'
                    })

    # Deduplicate by name
    seen = set()
    unique = []
    for c in candidates:
        key = c['name'].lower()
        if key not in seen:
            seen.add(key)
            unique.append(c)

    return unique

def parse_ballotpedia_page(html, url):
    """Parse a Ballotpedia page using BeautifulSoup"""
    soup = BeautifulSoup(html, 'html.parser')

    result = {
        'url': url,
        'title': '',
        'candidates': [],
        'election_dates': {},
        'incumbent': '',
        'district_info': '',
        'race_info': '',
        'content_summary': ''
    }

    # Get page title
    title_tag = soup.find('h1', id='firstHeading') or soup.find('title')
    if title_tag:
        result['title'] = title_tag.get_text().strip()

    # Remove navigation, scripts, style elements
    for element in soup(['script', 'style', 'nav', 'footer']):
        element.decompose()

    # Find main content
    content = soup.find('div', id='mw-content-text') or soup.find('div', class_='mw-parser-output')

    if not content:
        return result

    # Extract text from main content
    full_text = content.get_text(separator=' ', strip=True)

    # Extract candidates from prose
    prose_candidates = extract_candidates_from_text(full_text)
    result['candidates'] = prose_candidates

    # Look for infobox table (right side of page)
    infobox = content.find('table', class_=re.compile(r'infobox|wikitable'))
    if infobox:
        rows = infobox.find_all('tr')
        for row in rows:
            cells = row.find_all(['th', 'td'])
            if len(cells) >= 2:
                label = cells[0].get_text().strip().lower()
                value = cells[1].get_text().strip()

                if 'incumbent' in label:
                    result['incumbent'] = value
                elif 'election' in label and 'date' in label:
                    result['election_dates']['election'] = value
                elif 'primary' in label:
                    result['election_dates']['primary'] = value
                elif 'filing' in label:
                    result['election_dates']['filing_deadline'] = value

    # Look for candidate tables
    for table in content.find_all('table'):
        # Skip infoboxes and navboxes
        if table.get('class') and any(c in str(table.get('class')) for c in ['infobox', 'navbox', 'metadata']):
            continue

        rows = table.find_all('tr')
        if len(rows) < 2:
            continue

        # Check headers
        headers = [h.get_text().strip().lower() for h in rows[0].find_all(['th', 'td'])]

        # Candidate table indicators
        if any(term in ' '.join(headers) for term in ['candidate', 'name']):
            for row in rows[1:]:
                cells = row.find_all(['td', 'th'])
                if len(cells) >= 1:
                    name_cell = cells[0]
                    name = name_cell.get_text().strip()

                    if name and len(name) > 2 and len(name) < 60:
                        party = ''
                        if len(cells) > 1:
                            party = cells[1].get_text().strip()

                        # Check if already in candidates
                        existing = next((c for c in result['candidates'] if c['name'].lower() == name.lower()), None)
                        if existing:
                            if not existing.get('party') and party:
                                existing['party'] = party
                        else:
                            result['candidates'].append({
                                'name': name,
                                'party': party,
                                'source': 'table'
                            })

    # Extract summary paragraphs (first 3 substantive paragraphs)
    paragraphs = content.find_all('p')
    summary_parts = []
    for p in paragraphs[:10]:
        text = p.get_text().strip()
        if len(text) > 100:
            summary_parts.append(text)
            if len(summary_parts) >= 3:
                break

    result['content_summary'] = '\n\n'.join(summary_parts)

    return result

@app.route('/race/ballotpedia', methods=['POST'])
def ballotpedia_race():
    """Search for race on Ballotpedia and parse structured data"""
    if not check_auth():
        return jsonify({"error": "unauthorized"}), 401

    data = request.json
    office = data.get('office', '')
    state = data.get('state', '')
    district = data.get('district', '')
    year = data.get('year', datetime.now().year)
    location = data.get('location', '')

    if not office or not state:
        return jsonify({"error": "office and state required"}), 400

    cache_key = f"ballotpedia_v2_{office}_{state}_{district}_{location}_{year}"
    cached = get_cached(cache_key)
    if cached:
        return jsonify({**cached, "from_cache": True})

    # Build search query
    query_parts = [office, state]
    if district:
        query_parts.append(f"district {district}")
    if location:
        query_parts.append(location)
    query_parts.append(f"election {year}")

    search_query = " ".join(query_parts)

    # Find Ballotpedia URLs via search
    urls = search_ballotpedia_urls(search_query, max_results=5)

    if not urls:
        return jsonify({
            "success": False,
            "error": "No Ballotpedia pages found",
            "query": search_query
        })

    # Try to parse each URL, combine results
    all_candidates = []
    sources = []
    all_content = []
    election_info = {}

    for url_info in urls[:3]:
        html = fetch_ballotpedia_html(url_info['url'])
        if not html:
            continue

        parsed = parse_ballotpedia_page(html, url_info['url'])

        if parsed['candidates']:
            for c in parsed['candidates']:
                # Dedup by name
                if not any(existing['name'].lower() == c['name'].lower() for existing in all_candidates):
                    all_candidates.append(c)

        if parsed['election_dates']:
            election_info.update(parsed['election_dates'])

        if parsed['incumbent'] and not election_info.get('incumbent'):
            election_info['incumbent'] = parsed['incumbent']

        if parsed['content_summary']:
            all_content.append(f"=== {parsed['title']} ===\n{parsed['content_summary']}")

        sources.append({
            'url': parsed['url'],
            'title': parsed['title']
        })

        time.sleep(0.5)

    if not all_candidates and not all_content:
        return jsonify({
            "success": False,
            "error": "Pages found but could not extract data",
            "urls_tried": [u['url'] for u in urls]
        })

    result = {
        "success": True,
        "query": search_query,
        "candidates": all_candidates,
        "total_candidates": len(all_candidates),
        "election_info": election_info,
        "content": '\n\n'.join(all_content),
        "sources": sources,
        "source": "ballotpedia_parsed"
    }

    set_cached(cache_key, result)
    return jsonify(result)

@app.route('/candidate/ballotpedia', methods=['POST'])
def ballotpedia_candidate():
    """Find a candidate's Ballotpedia page and parse it"""
    if not check_auth():
        return jsonify({"error": "unauthorized"}), 401

    data = request.json
    name = data.get('name', '')
    state = data.get('state', '')

    if not name:
        return jsonify({"error": "name required"}), 400

    cache_key = f"ballotpedia_candidate_v2_{name}_{state}"
    cached = get_cached(cache_key)
    if cached:
        return jsonify({**cached, "from_cache": True})

    query = f"{name} {state}" if state else name
    urls = search_ballotpedia_urls(query, max_results=5)

    if not urls:
        return jsonify({
            "success": False,
            "error": "Candidate not found on Ballotpedia"
        })

    # Find best URL match (prefer exact name in URL)
    name_formatted = name.replace(' ', '_').lower()
    best_url = None
    for u in urls:
        if name_formatted in u['url'].lower():
            best_url = u
            break

    if not best_url:
        best_url = urls[0]

    html = fetch_ballotpedia_html(best_url['url'], timeout=60)

    if not html:
        return jsonify({
            "success": False,
            "error": "Could not fetch candidate page",
            "url_tried": best_url['url']
        })

    parsed = parse_ballotpedia_page(html, best_url['url'])

    result = {
        "success": True,
        "name": name,
        "title": parsed['title'],
        "summary": parsed['content_summary'],
        "url": parsed['url'],
        "source": "ballotpedia_parsed"
    }

    set_cached(cache_key, result)
    return jsonify(result)



@app.route("/donor/top", methods=["POST"])
def donor_top():
    import re
    if not check_auth():
        return jsonify({"success": False, "status": "unauthorized"}), 401
    fec_api_key = os.environ.get("FEC_API_KEY")
    if not fec_api_key:
        return jsonify({"success": False, "status": "fec_error", "message": "FEC_API_KEY not configured"}), 500
    body = request.get_json(silent=True) or {}
    office = (body.get("office") or "").upper()
    state = (body.get("state") or "").upper()
    district = str(body.get("district") or "").strip()
    election_year = body.get("election_year")
    incumbent_name = (body.get("incumbent_name") or "").strip() or None
    try:
        top_n = max(1, min(50, int(body.get("top_n") or 20)))
    except (TypeError, ValueError):
        top_n = 20
    if office not in ("H", "S", "P") or not state or not isinstance(election_year, int):
        return jsonify({"success": False, "status": "invalid_input"}), 400
    FEC_BASE = "https://api.open.fec.gov/v1"
    roster_params = {"api_key": fec_api_key, "office": office, "state": state, "election_year": election_year, "per_page": 100, "sort": "name"}
    if office == "H":
        roster_params["district"] = district.zfill(2)
    try:
        r = requests.get(FEC_BASE + "/candidates/", params=roster_params, timeout=60)
        r.raise_for_status()
        roster = (r.json() or {}).get("results", [])
    except Exception as e:
        return jsonify({"success": False, "status": "fec_error", "message": str(e)}), 502
    if not roster:
        return jsonify({"success": False, "status": "no_match", "message": "no candidates found"})
    def _fuzzy(inp, fec):
        inp = (inp or "").lower().strip()
        fec = (fec or "").lower().strip()
        tokens = [t for t in re.split(r"[\s,]+", inp) if len(t) > 1]
        return bool(tokens) and all(t in fec for t in tokens)
    if incumbent_name:
        candidate = next((c for c in roster if _fuzzy(incumbent_name, c.get("name", ""))), None)
        if not candidate:
            return jsonify({"success": False, "status": "no_match", "message": "no candidate matched"})
    else:
        candidate = next((c for c in roster if c.get("incumbent_challenge") == "I"), roster[0])
    candidate_id = candidate.get("candidate_id")
    candidate_name = candidate.get("name")
    try:
        r = requests.get(FEC_BASE + "/candidate/" + candidate_id + "/committees/", params={"api_key": fec_api_key, "designation": "P", "per_page": 5}, timeout=60)
        r.raise_for_status()
        committees = (r.json() or {}).get("results", [])
    except Exception as e:
        return jsonify({"success": False, "status": "fec_error", "message": str(e)}), 502
    if not committees:
        return jsonify({"success": False, "status": "no_match", "message": "no principal committee found"})
    committee_id = committees[0].get("committee_id")
    try:
        r = requests.get(FEC_BASE + "/schedules/schedule_a/", params={"api_key": fec_api_key, "committee_id": committee_id, "two_year_transaction_period": election_year, "is_individual": "true", "sort_descending": "true", "per_page": top_n}, timeout=60)
        r.raise_for_status()
        rows = (r.json() or {}).get("results", [])
    except Exception as e:
        return jsonify({"success": False, "status": "fec_error", "message": str(e)}), 502
    if not rows:
        return jsonify({"success": False, "status": "empty", "candidate_name": candidate_name, "committee_id": committee_id})
    donors = [{"name": d.get("contributor_name"), "amount": d.get("contribution_receipt_amount"), "employer": d.get("contributor_employer"), "occupation": d.get("contributor_occupation"), "city": d.get("contributor_city"), "state": d.get("contributor_state"), "zip": d.get("contributor_zip")} for d in rows]
    return jsonify({"success": True, "candidate_name": candidate_name, "candidate_id": candidate_id, "committee_id": committee_id, "committee_url": "https://www.fec.gov/data/committee/" + committee_id + "/", "donors": donors})


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=8890, debug=False)
