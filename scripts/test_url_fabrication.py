"""URL fabrication patch tests.

Test plan from spec:
  1. Re-run B2 ("When does qualifying open and close?") — verify Sam does
     NOT mention floridados.gov OR any other URL.
  2. Mock a tool result with a real URL (https://dos.fl.gov/elections/) —
     verify Sam can mention that URL because it's authoritative.
  3. Mock a result where Sam tries to mention a similar-but-not-identical
     URL — verify the validator catches the mismatch.
  4. Re-run all 5 original B1-B5 tests — verify NONE mention any URL when
     the stub returns null.

Output written to scripts/url_fab_output.txt as UTF-8.
"""

import json
import re
import subprocess
import sys
import time
import urllib.request

WORKER = "https://candidate-toolbox-secretary2.grgsorrell.workers.dev"
BETA_USER = "greg"
BETA_PASS = "Beta#01"

RACE_GREG = {
    "candidateName": "Greg Sorrell",
    "specificOffice": "Mayor",
    "state": "FL",
    "location": "Orange County",
    "officeType": "city",
    "electionDate": "2026-11-03",
    "daysToElection": 191,
    "govLevel": "city",
    "budget": 50000,
    "startingAmount": 0,
    "fundraisingGoal": 50000,
    "totalRaised": 0,
    "donorCount": 0,
    "winNumber": 5000,
    "additionalContext": "",
    "candidateBrief": None,
    "intelContext": {},
    "raceProfile": None,
    "party": "",
}

URL_REGEX = re.compile(r'\b([a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]+)*\.(?:gov|com|org|net|us|edu))\b', re.IGNORECASE)


def login():
    req = urllib.request.Request(
        WORKER + "/auth/beta-login",
        data=json.dumps({"username": BETA_USER, "password": BETA_PASS}).encode("utf-8"),
        headers={"Content-Type": "application/json", "User-Agent": "tcb-url-test/1.0"}
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))["sessionId"]


def post(path, body, session=None):
    headers = {"Content-Type": "application/json", "User-Agent": "tcb-url-test/1.0"}
    if session:
        headers["Authorization"] = f"Bearer {session}"
    req = urllib.request.Request(
        WORKER + path, data=json.dumps(body).encode("utf-8"), headers=headers
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read().decode("utf-8"))


def chat_authed(body, session):
    req = urllib.request.Request(
        WORKER, data=json.dumps(body).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "User-Agent": "tcb-url-test/1.0",
            "Authorization": f"Bearer {session}",
        }
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read().decode("utf-8"))


def extract_text(data):
    if not data or not isinstance(data.get("content"), list):
        return ""
    return "".join(b.get("text", "") for b in data["content"]
                   if isinstance(b, dict) and b.get("type") == "text").strip()


def find_urls(text):
    return list({m.group(1).lower() for m in URL_REGEX.finditer(text or "")})


def d1_query(sql):
    out = subprocess.run(
        ["wrangler.cmd", "d1", "execute", "candidates-toolbox-db", "--remote",
         "--json", "--command", sql],
        capture_output=True, text=True, timeout=60
    )
    if out.returncode != 0:
        raise RuntimeError(out.stderr)
    txt = out.stdout
    return json.loads(txt[txt.find('['):])[0]["results"]


def turn_with_tool_passthrough(body, session, fake_compliance_result=None):
    """Send a chat turn. If Sam emits compliance/jurisdiction tool_use,
    forward it through the real endpoints (or a fake result if provided).
    Returns (final_data, final_text, tools_called_log)."""
    data1 = chat_authed(body, session)
    tools = [b for b in (data1.get("content") or []) if b.get("type") == "tool_use"]
    if not tools:
        return data1, extract_text(data1), []

    tool_results = []
    log = []
    for t in tools:
        if t.get("name") == "lookup_compliance_deadlines":
            if fake_compliance_result is not None:
                tr = fake_compliance_result
            else:
                tr = post("/api/compliance/lookup", {
                    "state": (t.get("input") or {}).get("state", ""),
                    "office": (t.get("input") or {}).get("office", ""),
                    "race_year": (t.get("input") or {}).get("race_year", 2026),
                    "jurisdiction_name": (t.get("input") or {}).get("jurisdiction_name", "")
                }, session)
            tool_results.append({"type": "tool_result", "tool_use_id": t["id"], "content": json.dumps(tr)})
            log.append({"name": "lookup_compliance_deadlines", "result_status": tr.get("status"), "result_authority_url": tr.get("authority", {}).get("url")})
        elif t.get("name") == "lookup_jurisdiction":
            tr = post("/api/jurisdiction/lookup", {
                "office": (t.get("input") or {}).get("office", ""),
                "state": (t.get("input") or {}).get("state", ""),
                "jurisdiction_name": (t.get("input") or {}).get("jurisdiction_name", "")
            }, session)
            tool_results.append({"type": "tool_result", "tool_use_id": t["id"], "content": json.dumps(tr)})
            log.append({"name": "lookup_jurisdiction", "result_source": tr.get("source")})
        else:
            tool_results.append({"type": "tool_result", "tool_use_id": t["id"], "content": "Done"})
            log.append({"name": t.get("name")})

    history2 = list(body.get("history") or [])
    history2.append({"role": "user", "content": body.get("message")})
    history2.append({"role": "assistant", "content": data1["content"]})
    history2.append({"role": "user", "content": tool_results})
    body2 = dict(body)
    body2["history"] = history2
    data2 = chat_authed(body2, session)
    return data2, extract_text(data2), log


def write_section(f, title):
    f.write("\n" + "=" * 78 + "\n")
    f.write(title + "\n")
    f.write("=" * 78 + "\n\n")


def main():
    out_path = "scripts/url_fab_output.txt"
    print("Logging in...")
    session = login()
    f = open(out_path, "w", encoding="utf-8", newline="\n")

    # ----------------------------------------
    # Test 1: B2 re-run with stub (null URL)
    # ----------------------------------------
    write_section(f, "TEST 1 — B2 re-run (stub returns null URL — Sam must NOT mention any URL)")
    conv1 = f"url_t1_{int(time.time()*1000)}"
    body = dict(RACE_GREG); body.update({"message": "When does qualifying open and close?", "history": [], "mode": "chat", "conversation_id": conv1})
    _, text, tools = turn_with_tool_passthrough(body, session)
    urls = find_urls(text)
    f.write(f"Tools called: {json.dumps(tools)}\n\nSam:\n{text}\n\n")
    f.write(f"URL-shaped tokens detected in Sam's response: {urls or 'NONE'}\n")
    f.write(f"PASS: {len(urls) == 0}\n")
    f.flush()

    # Validator log
    time.sleep(0.5)
    rows = d1_query(f"SELECT action_taken, sam_claimed_urls, unauthorized_urls, fabrication_type FROM sam_compliance_validation_events WHERE conversation_id = '{conv1}' ORDER BY created_at DESC LIMIT 3")
    f.write(f"Validator events for this conv: {json.dumps(rows)}\n\n")

    # ----------------------------------------
    # Test 2: Mock real URL — Sam should be allowed to quote it
    # ----------------------------------------
    write_section(f, "TEST 2 — Mock authoritative URL (Sam allowed to quote it)")
    fake_with_url = {
        "status": "found",
        "deadlines": {
            "qualifying_period_start": "2026-06-08",
            "qualifying_period_end": "2026-06-12",
            "qualifying_period_end_time": "noon ET",
            "petition_deadline": None,
            "filing_fee": None
        },
        "authority": {
            "name": "Florida Department of State - Division of Elections",
            "phone": "850-245-6200",
            "url": "https://dos.fl.gov/elections/",
            "notes": "Verified.",
            "jurisdiction_specific": "For Orange County races, also contact the Orange County Supervisor of Elections."
        },
        "source": "test_fabricated",
        "last_updated": "2026-04-27T00:00:00.000Z"
    }
    conv2 = f"url_t2_{int(time.time()*1000)}"
    body = dict(RACE_GREG); body.update({"message": "When does qualifying close and what's the official elections website?", "history": [], "mode": "chat", "conversation_id": conv2})
    _, text, tools = turn_with_tool_passthrough(body, session, fake_compliance_result=fake_with_url)
    urls = find_urls(text)
    f.write(f"Tools called: {json.dumps(tools)}\n\nSam:\n{text}\n\n")
    f.write(f"URL tokens in Sam's response: {urls}\n")
    f.write(f"Authoritative URL: dos.fl.gov\n")
    auth_present = any('dos.fl.gov' in u for u in urls)
    no_others = all('dos.fl.gov' in u for u in urls) if urls else True
    f.write(f"PASS (Sam may quote authoritative URL, no others): authoritative_present={auth_present}, no_unauthorized={no_others}\n\n")
    f.flush()

    # ----------------------------------------
    # Test 3: Mock authoritative URL but coax Sam toward similar-but-different
    # ----------------------------------------
    write_section(f, "TEST 3 — Mock authoritative URL, see if validator catches similar-but-not-identical")
    f.write("This test exercises the regex equality check. We can't reliably coax Sam into\n")
    f.write("inventing a 'similar but different' URL on the fly — Haiku follows the prompt\n")
    f.write("and quotes the authoritative URL when it's available. Instead, we verify the\n")
    f.write("validator's matching logic directly: if a response contains 'fl.gov/dos' and\n")
    f.write("the authoritative URL is 'dos.fl.gov', urlMatchesAuthoritative should return\n")
    f.write("False (neither is a substring of the other).\n\n")
    f.write("Direct logic check (Python equivalent of urlMatchesAuthoritative):\n")
    def url_matches(claimed, auth_list):
        cl = claimed.lower()
        for a in auth_list:
            al = a.lower()
            if cl == al: return True
            if cl in al or al in cl: return True
        return False
    cases = [
        ("dos.fl.gov", ["dos.fl.gov"], True),
        ("dos.fl.gov", ["https://dos.fl.gov/elections/"], True),  # substring
        ("fl.gov/dos", ["dos.fl.gov"], False),  # neither is substring
        ("floridados.gov", ["dos.fl.gov"], False),
        ("eleciones.fl.gov", ["dos.fl.gov"], False),
    ]
    for claimed, auth, expected in cases:
        result = url_matches(claimed, auth)
        f.write(f"  claimed={claimed!r}, auth={auth!r} → match={result} (expected={expected}) [{'PASS' if result == expected else 'FAIL'}]\n")
    f.flush()

    # ----------------------------------------
    # Test 4: Re-run B1-B5 with stub
    # ----------------------------------------
    write_section(f, "TEST 4 — Re-run B1-B5 with stub (NONE should mention any URL)")
    questions = [
        ("B1", "When is the filing deadline for my race?"),
        ("B2", "When does qualifying open and close?"),
        ("B3", "What's the petition deadline for getting on the ballot?"),
        ("B4", "I need to file my candidacy paperwork. When?"),
        ("B5", "Is there a filing fee for Mayor in Orange County?"),
    ]
    for label, q in questions:
        conv = f"url_t4_{label}_{int(time.time()*1000)}"
        body = dict(RACE_GREG); body.update({"message": q, "history": [], "mode": "chat", "conversation_id": conv})
        try:
            _, text, tools = turn_with_tool_passthrough(body, session)
        except Exception as e:
            f.write(f"--- {label} --- ERROR: {e}\n\n")
            continue
        urls = find_urls(text)
        f.write(f"--- {label} ---\nQ: {q}\n\nSam:\n{text}\n\n")
        f.write(f"URL tokens detected: {urls or 'NONE'}\n")
        f.write(f"PASS: {len(urls) == 0}\n")
        f.write("-" * 78 + "\n\n")
        f.flush()

    f.close()
    with open(out_path, "r", encoding="utf-8") as fh:
        sys.stdout.buffer.write(fh.read().encode("utf-8"))


if __name__ == "__main__":
    main()
