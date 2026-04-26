"""Compliance-validator checkpoint tests.

Sections:
  A. Tool unit tests — direct hits to /api/compliance/lookup for 5 race types
  B. Live Sam tests — 5 compliance questions, full unmodified responses
  C. Validator firing test — verify the validator catches an invented date
  D. Jurisdiction retrofit test — federal district lookup returns authority
  E. Sample tool result — literal output for FL Mayor Orange County

Output written to scripts/compliance_test_output.txt as UTF-8.
"""

import json
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


def login():
    req = urllib.request.Request(
        WORKER + "/auth/beta-login",
        data=json.dumps({"username": BETA_USER, "password": BETA_PASS}).encode("utf-8"),
        headers={"Content-Type": "application/json", "User-Agent": "tcb-cmp-test/1.0"}
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        body = json.loads(r.read().decode("utf-8"))
    return body["sessionId"]


def post(path, body, session=None):
    headers = {"Content-Type": "application/json", "User-Agent": "tcb-cmp-test/1.0"}
    if session:
        headers["Authorization"] = f"Bearer {session}"
    req = urllib.request.Request(
        WORKER + path,
        data=json.dumps(body).encode("utf-8"),
        headers=headers
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read().decode("utf-8"))


def chat_root(body):
    """Send chat request to root path (no auth needed for chat handler)."""
    req = urllib.request.Request(
        WORKER,
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json", "User-Agent": "tcb-cmp-test/1.0"}
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read().decode("utf-8"))


def chat_authed(body, session):
    req = urllib.request.Request(
        WORKER,
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "User-Agent": "tcb-cmp-test/1.0",
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


def write_section(f, title):
    f.write("\n" + "=" * 78 + "\n")
    f.write(title + "\n")
    f.write("=" * 78 + "\n\n")


# ==========================================================
# SECTION A — Tool unit tests
# ==========================================================

TOOL_CASES = [
    ("FL US House FL-7",   {"state": "FL", "office": "US House",       "race_year": 2026, "jurisdiction_name": "FL-7"}),
    ("FL State House 47",  {"state": "FL", "office": "State House",    "race_year": 2026, "jurisdiction_name": "FL House District 47"}),
    ("FL Orange Mayor",    {"state": "FL", "office": "Mayor",          "race_year": 2026, "jurisdiction_name": "Orange County"}),
    ("FL Apopka Mayor",    {"state": "FL", "office": "Mayor",          "race_year": 2026, "jurisdiction_name": "Apopka"}),
    ("TX State Senate 8",  {"state": "TX", "office": "State Senate",   "race_year": 2026, "jurisdiction_name": "Texas State Senate District 8"}),
]


def section_A(f, session):
    write_section(f, "SECTION A — Tool unit tests (/api/compliance/lookup)")
    for label, body in TOOL_CASES:
        try:
            result = post("/api/compliance/lookup", body, session)
        except Exception as e:
            f.write(f"--- {label} --- ERROR: {e}\n\n")
            continue
        f.write(f"--- {label} ---\n")
        f.write(f"Input: {json.dumps(body)}\n")
        f.write(f"status: {result.get('status')}\n")
        f.write(f"source: {result.get('source')}\n")
        f.write(f"deadlines: {json.dumps(result.get('deadlines'))}\n")
        f.write(f"authority.name:  {result.get('authority',{}).get('name')}\n")
        f.write(f"authority.phone: {result.get('authority',{}).get('phone')}\n")
        f.write(f"authority.url:   {result.get('authority',{}).get('url')}\n")
        f.write(f"authority.notes: {result.get('authority',{}).get('notes')}\n")
        f.write(f"authority.jurisdiction_specific: {result.get('authority',{}).get('jurisdiction_specific')}\n")
        f.write(f"cached: {result.get('cached')}\n\n")
        f.flush()


# ==========================================================
# SECTION B — Live Sam tests
# ==========================================================

LIVE_QUESTIONS = [
    ("B1", "When is the filing deadline for my race?"),
    ("B2", "When does qualifying open and close?"),
    ("B3", "What's the petition deadline for getting on the ballot?"),
    ("B4", "I need to file my candidacy paperwork. When?"),
    ("B5", "Is there a filing fee for Mayor in Orange County?"),
]


def turn_with_tool_passthrough(body, session, label):
    """Send a chat turn. If Sam emits tool_use blocks, fetch their results
    via authenticated endpoints and re-send for round 2. Returns the final
    user-visible text."""
    data1 = chat_authed(body, session)
    tools = [b for b in (data1.get("content") or []) if b.get("type") == "tool_use"]
    if not tools:
        return data1, extract_text(data1), []

    # Execute tool calls server-side via the actual endpoints
    tool_results = []
    tool_calls_log = []
    for t in tools:
        if t.get("name") == "lookup_compliance_deadlines":
            try:
                tr = post("/api/compliance/lookup", {
                    "state": (t.get("input") or {}).get("state", ""),
                    "office": (t.get("input") or {}).get("office", ""),
                    "race_year": (t.get("input") or {}).get("race_year", 2026),
                    "jurisdiction_name": (t.get("input") or {}).get("jurisdiction_name", "")
                }, session)
                tool_results.append({
                    "type": "tool_result", "tool_use_id": t["id"], "content": json.dumps(tr)
                })
                tool_calls_log.append({"name": "lookup_compliance_deadlines", "input": t.get("input"), "result_status": tr.get("status")})
            except Exception as e:
                tool_results.append({
                    "type": "tool_result", "tool_use_id": t["id"], "content": json.dumps({"error": str(e)})
                })
        elif t.get("name") == "lookup_jurisdiction":
            try:
                tr = post("/api/jurisdiction/lookup", {
                    "office": (t.get("input") or {}).get("office", ""),
                    "state": (t.get("input") or {}).get("state", ""),
                    "jurisdiction_name": (t.get("input") or {}).get("jurisdiction_name", "")
                }, session)
                tool_results.append({
                    "type": "tool_result", "tool_use_id": t["id"], "content": json.dumps(tr)
                })
                tool_calls_log.append({"name": "lookup_jurisdiction", "input": t.get("input"), "result_source": tr.get("source")})
            except Exception as e:
                tool_results.append({
                    "type": "tool_result", "tool_use_id": t["id"], "content": json.dumps({"error": str(e)})
                })
        else:
            tool_results.append({
                "type": "tool_result", "tool_use_id": t["id"], "content": "Done"
            })
            tool_calls_log.append({"name": t.get("name"), "input": t.get("input")})

    # Round 2 with tool results threaded
    history2 = list(body.get("history") or [])
    history2.append({"role": "user", "content": body.get("message")})
    history2.append({"role": "assistant", "content": data1["content"]})
    history2.append({"role": "user", "content": tool_results})
    body2 = dict(body)
    body2["history"] = history2
    data2 = chat_authed(body2, session)
    return data2, extract_text(data2), tool_calls_log


def section_B(f, session):
    write_section(f, "SECTION B — Live Sam tests (5 compliance questions, full unmodified responses)")
    for label, q in LIVE_QUESTIONS:
        conv = f"cmp_{label}_{int(time.time()*1000)}"
        body = dict(RACE_GREG)
        body.update({"message": q, "history": [], "mode": "chat", "conversation_id": conv})
        try:
            _, text, tool_log = turn_with_tool_passthrough(body, session, label)
        except Exception as e:
            f.write(f"--- {label} --- ERROR: {e}\n\n")
            continue
        f.write(f"--- {label} ---\nQ: {q}\n\n")
        f.write(f"Tools called: {json.dumps(tool_log) if tool_log else 'none'}\n\n")
        f.write("Sam:\n")
        f.write(text + "\n\n")
        f.write("-" * 78 + "\n\n")
        f.flush()


# ==========================================================
# SECTION C — Validator firing test
# ==========================================================

def section_C(f, session):
    write_section(f, "SECTION C — Validator firing test")
    f.write("Setup: ask a compliance question, intercept Sam's tool_use, return\n")
    f.write("a fabricated tool_result with a SPECIFIC qualifying_period_end of\n")
    f.write("'2026-06-12' so the lookup has authoritative data. Then ask Sam to\n")
    f.write("recall the deadline. If she says '2026-06-12' validator passes. If\n")
    f.write("she invents a different date, validator should regenerate.\n\n")
    f.write("(This forces the lookup to have known dates so we can detect if Sam\n")
    f.write("drifts to a different one.)\n\n")

    conv = f"cmp_validator_{int(time.time()*1000)}"
    base_body = dict(RACE_GREG)
    base_body.update({"message": "When does qualifying close?", "history": [], "mode": "chat", "conversation_id": conv})
    data1 = chat_authed(base_body, session)
    tools = [b for b in (data1.get("content") or []) if b.get("type") == "tool_use"]
    f.write(f"Round 1: Sam emitted {len(tools)} tool_use block(s)\n")
    if tools and tools[0].get("name") == "lookup_compliance_deadlines":
        # Fabricate a 'found' result
        fake_result = {
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
                "phone": "(verify on state government website)",
                "url": None,
                "notes": "Stub data — verify directly.",
                "jurisdiction_specific": "For Orange County races, contact the Orange County Supervisor of Elections."
            },
            "source": "test_fabricated",
            "last_updated": "2026-04-27T00:00:00.000Z"
        }
        f.write(f"Fabricated tool_result: status='found', qualifying_period_end='2026-06-12'\n\n")

        history2 = [
            {"role": "user", "content": base_body["message"]},
            {"role": "assistant", "content": data1["content"]},
            {"role": "user", "content": [{"type": "tool_result", "tool_use_id": tools[0]["id"], "content": json.dumps(fake_result)}]}
        ]
        body2 = dict(base_body); body2["history"] = history2
        data2 = chat_authed(body2, session)
        text2 = extract_text(data2)
        f.write("Round 2 Sam response:\n" + text2 + "\n\n")

        # Now check validation events for this conversation
        time.sleep(0.5)
        events = d1_query(f"SELECT action_taken, sam_claimed_dates, unauthorized_dates, original_response_excerpt, final_response_excerpt FROM sam_compliance_validation_events WHERE conversation_id = '{conv}' ORDER BY created_at DESC")
        f.write(f"sam_compliance_validation_events rows for this conv: {len(events)}\n")
        for ev in events:
            f.write(f"  - action: {ev['action_taken']}\n")
            f.write(f"    claimed: {ev['sam_claimed_dates']}\n")
            f.write(f"    unauthorized: {ev['unauthorized_dates']}\n")
            f.write(f"    excerpt: {(ev.get('final_response_excerpt') or '')[:200]}\n")
    else:
        f.write("Sam did NOT emit lookup_compliance_deadlines on round 1 — validator firing test inconclusive.\n")
    f.write("\n")
    f.flush()


# ==========================================================
# SECTION D — Jurisdiction retrofit test
# ==========================================================

def section_D(f, session):
    write_section(f, "SECTION D — Jurisdiction retrofit (federal district returns authority)")
    try:
        result = post("/api/jurisdiction/lookup", {
            "office": "US House",
            "state": "FL",
            "jurisdiction_name": "FL-7"
        }, session)
    except Exception as e:
        f.write(f"ERROR: {e}\n\n")
        return
    f.write("Direct call: /api/jurisdiction/lookup with FL-7 (federal district)\n\n")
    f.write(f"source: {result.get('source')}\n")
    f.write(f"jurisdiction_type: {result.get('jurisdiction_type')}\n")
    f.write(f"authority field present: {bool(result.get('authority'))}\n")
    if result.get("authority"):
        a = result["authority"]
        f.write(f"  authority.name: {a.get('name')}\n")
        f.write(f"  authority.phone: {a.get('phone')}\n")
        f.write(f"  authority.url: {a.get('url')}\n")
        f.write(f"  authority.notes: {a.get('notes')}\n")
        f.write(f"  authority.jurisdiction_specific: {a.get('jurisdiction_specific')}\n")
    f.write(f"\nFull result: {json.dumps(result, indent=2)}\n\n")
    f.flush()


# ==========================================================
# SECTION E — Sample tool result for FL Mayor Orange County
# ==========================================================

def section_E(f, session):
    write_section(f, "SECTION E — Sample lookup_compliance_deadlines result for FL Mayor Orange County")
    try:
        result = post("/api/compliance/lookup", {
            "state": "FL", "office": "Mayor", "race_year": 2026, "jurisdiction_name": "Orange County"
        }, session)
    except Exception as e:
        f.write(f"ERROR: {e}\n\n")
        return
    f.write("Direct call: /api/compliance/lookup with FL Mayor Orange County 2026\n\n")
    f.write(json.dumps(result, indent=2) + "\n\n")
    f.flush()


# ==========================================================
# Main
# ==========================================================

def main():
    out_path = "scripts/compliance_test_output.txt"
    print("Logging in...")
    session = login()
    print(f"Got session: {session[:16]}...")

    f = open(out_path, "w", encoding="utf-8", newline="\n")
    section_A(f, session)
    section_E(f, session)  # E before B/C so the sample is up-front
    section_D(f, session)
    section_B(f, session)
    section_C(f, session)
    f.close()

    with open(out_path, "r", encoding="utf-8") as fh:
        sys.stdout.buffer.write(fh.read().encode("utf-8"))


if __name__ == "__main__":
    main()
