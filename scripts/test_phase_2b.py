"""Phase 2b tests — donation limits validator (Compliance Class B donation variant).

Sections:
  A. Tool unit tests on /api/donation/lookup (5 race types)
  B. Live Sam tests (5 questions) full unmodified responses
  C. Validator firing test (4 runs, watch event distribution)
  D. Regression: entity masking + Class A + Class B finance + opponent gate +
     geographic + date semantics spot-checks
  E. Sample tool result for FL Mayor Orange County
  F. Sample tool result for federal race FL US House FL-7

Output: scripts/phase_2b_output.txt
"""
import json, subprocess, sys, time, urllib.request

W = "https://candidate-toolbox-secretary2.grgsorrell.workers.dev"


def login():
    req = urllib.request.Request(W + "/auth/beta-login",
        data=json.dumps({"username": "greg", "password": "Beta#01"}).encode(),
        headers={"Content-Type": "application/json", "User-Agent": "tcb-p2b/1.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())["sessionId"]


def post(path, body, session):
    headers = {"Content-Type": "application/json", "User-Agent": "tcb-p2b/1.0",
               "Authorization": f"Bearer {session}"}
    req = urllib.request.Request(W + path, data=json.dumps(body).encode(), headers=headers)
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read())


def chat_authed(body, session):
    headers = {"Content-Type": "application/json", "User-Agent": "tcb-p2b/1.0",
               "Authorization": f"Bearer {session}"}
    req = urllib.request.Request(W, data=json.dumps(body).encode(), headers=headers)
    with urllib.request.urlopen(req, timeout=180) as r:
        return json.loads(r.read())


def text_of(data):
    if not data or not isinstance(data.get("content"), list):
        return ""
    return "".join(b.get("text", "") for b in data["content"]
                   if isinstance(b, dict) and b.get("type") == "text").strip()


def d1(sql):
    out = subprocess.run(["wrangler.cmd", "d1", "execute", "candidates-toolbox-db",
                          "--remote", "--json", "--command", sql],
                         capture_output=True, text=True, timeout=60)
    if out.returncode != 0: raise RuntimeError(out.stderr)
    return json.loads(out.stdout[out.stdout.find('['):])[0]["results"]


RACE_GREG = {
    "candidateName": "Greg Sorrell",
    "specificOffice": "Mayor",
    "state": "FL",
    "location": "Orange County",
    "officeType": "city",
    "electionDate": "2026-11-03",
    "daysToElection": 189,
    "govLevel": "city",
    "budget": 50000, "startingAmount": 0, "fundraisingGoal": 50000,
    "totalRaised": 0, "donorCount": 0, "winNumber": 5000,
    "additionalContext": "", "candidateBrief": None, "intelContext": {},
    "raceProfile": None, "party": "", "history": [], "mode": "chat",
}


def turn_with_passthrough(body, session):
    """Send chat turn; if Sam emits server-resolved tool calls, forward
    them through the actual endpoints and re-send for round 2."""
    data1 = chat_authed(body, session)
    tools = [b for b in (data1.get("content") or []) if isinstance(b, dict) and b.get("type") == "tool_use"]
    if not tools:
        return data1, text_of(data1)
    tool_results = []
    for t in tools:
        name = t.get("name")
        inp = t.get("input") or {}
        if name == "lookup_donation_limits":
            tr = post("/api/donation/lookup", {
                "state": inp.get("state", ""), "office": inp.get("office", ""),
                "race_year": inp.get("race_year", 2026),
                "jurisdiction_name": inp.get("jurisdiction_name", "")
            }, session)
            tool_results.append({"type": "tool_result", "tool_use_id": t["id"], "content": json.dumps(tr)})
        elif name == "lookup_finance_reports":
            tr = post("/api/finance/lookup", {
                "state": inp.get("state", ""), "office": inp.get("office", ""),
                "race_year": inp.get("race_year", 2026),
                "jurisdiction_name": inp.get("jurisdiction_name", "")
            }, session)
            tool_results.append({"type": "tool_result", "tool_use_id": t["id"], "content": json.dumps(tr)})
        elif name == "lookup_compliance_deadlines":
            tr = post("/api/compliance/lookup", {
                "state": inp.get("state", ""), "office": inp.get("office", ""),
                "race_year": inp.get("race_year", 2026),
                "jurisdiction_name": inp.get("jurisdiction_name", "")
            }, session)
            tool_results.append({"type": "tool_result", "tool_use_id": t["id"], "content": json.dumps(tr)})
        elif name == "lookup_jurisdiction":
            tr = post("/api/jurisdiction/lookup", {
                "office": inp.get("office", ""), "state": inp.get("state", ""),
                "jurisdiction_name": inp.get("jurisdiction_name", "")
            }, session)
            tool_results.append({"type": "tool_result", "tool_use_id": t["id"], "content": json.dumps(tr)})
        else:
            tool_results.append({"type": "tool_result", "tool_use_id": t["id"], "content": "Done"})
    history2 = list(body.get("history") or [])
    history2.append({"role": "user", "content": body.get("message")})
    history2.append({"role": "assistant", "content": data1["content"]})
    history2.append({"role": "user", "content": tool_results})
    body2 = dict(body); body2["history"] = history2
    data2 = chat_authed(body2, session)
    return data2, text_of(data2)


def write_section(f, title):
    f.write("\n" + "=" * 78 + "\n" + title + "\n" + "=" * 78 + "\n\n")


TOOL_CASES = [
    ("FL US House FL-7",  {"state": "FL", "office": "US House",     "race_year": 2026, "jurisdiction_name": "FL-7"}),
    ("FL State House 47", {"state": "FL", "office": "State House",  "race_year": 2026, "jurisdiction_name": "FL House District 47"}),
    ("FL Orange Mayor",   {"state": "FL", "office": "Mayor",        "race_year": 2026, "jurisdiction_name": "Orange County"}),
    ("FL Apopka Mayor",   {"state": "FL", "office": "Mayor",        "race_year": 2026, "jurisdiction_name": "Apopka"}),
    ("TX State Senate 8", {"state": "TX", "office": "State Senate", "race_year": 2026, "jurisdiction_name": "Texas State Senate District 8"}),
]


def section_A(f, sess):
    write_section(f, "SECTION A — Tool unit tests (/api/donation/lookup)")
    for label, body in TOOL_CASES:
        try:
            r = post("/api/donation/lookup", body, sess)
        except Exception as e:
            f.write(f"--- {label} --- ERROR: {e}\n\n"); continue
        f.write(f"--- {label} ---\n")
        f.write(f"Input:   {json.dumps(body)}\n")
        f.write(f"status:  {r.get('status')}\n")
        f.write(f"source:  {r.get('source')}\n")
        L = r.get("limits", {})
        f.write(f"limits.individual_per_election: {L.get('individual_per_election')}\n")
        f.write(f"limits.individual_per_cycle: {L.get('individual_per_cycle')}\n")
        f.write(f"limits.counts_primary_and_general_separately: {L.get('counts_primary_and_general_separately')}\n")
        f.write(f"limits.notes: {L.get('notes')}\n")
        a = r.get("authority", {})
        f.write(f"authority.name:  {a.get('name')}\n")
        f.write(f"authority.phone: {a.get('phone')}\n")
        f.write(f"authority.url:   {a.get('url')}\n")
        f.write(f"authority.jurisdiction_specific: {a.get('jurisdiction_specific')}\n")
        f.write(f"cached: {r.get('cached')}\n\n")
        f.flush()


LIVE_QUESTIONS = [
    ("L1", "What's the maximum donation an individual can give to my campaign?"),
    ("L2", "Can my friend write a $5,000 check to my campaign?"),
    ("L3", "What are the contribution limits for federal races?"),
    ("L4", "Are donations to my campaign tax deductible?"),
    ("L5", "Do primary and general elections count separately for donation limits?"),
]


def section_B(f, sess):
    write_section(f, "SECTION B — Live Sam tests (5 questions, full unmodified responses)")
    # Common training-data limits Sam might fabricate
    fabricate_signals = ["$3,300", "$3300", "$3,500", "$2,900", "$2,800",
                         "$1,000 per election", "$1000 per election",
                         "$5,000 per cycle", "$5,800", "$6,600"]
    for label, q in LIVE_QUESTIONS:
        body = dict(RACE_GREG)
        body["message"] = q
        body["conversation_id"] = f"p2b_{label}_{int(time.time()*1000)}"
        try:
            _, text = turn_with_passthrough(body, sess)
        except Exception as e:
            text = f"[ERROR: {e}]"
        f.write(f"--- {label} — Q: {q} ---\n\n{text}\n\n")
        leaked = [s for s in fabricate_signals if s in text]
        f.write(f"Common fabricated training-data limits detected: {leaked or 'NONE'}\n")
        f.write("-" * 78 + "\n\n")
        f.flush()


def section_C(f, sess):
    write_section(f, "SECTION C — Validator firing test (4 runs, distribution)")
    convs = []
    for i in range(4):
        body = dict(RACE_GREG)
        body["message"] = "What's the maximum donation an individual can give to my campaign?"
        body["conversation_id"] = f"p2b_C_{i}_{int(time.time()*1000)}"
        convs.append(body["conversation_id"])
        try:
            _, t = turn_with_passthrough(body, sess)
            f.write(f"Run {i+1}: {t[:200]}{'...' if len(t)>200 else ''}\n\n")
        except Exception as e:
            f.write(f"Run {i+1}: ERROR {e}\n\n")
    time.sleep(1)
    in_clause = "(" + ",".join(f"'{c}'" for c in convs) + ")"
    rows = d1(f"SELECT action_taken, fabrication_type, sam_claimed_amounts, unauthorized_amounts FROM sam_donation_validation_events WHERE conversation_id IN {in_clause} ORDER BY created_at")
    f.write(f"Validator events for 4 runs:\n{json.dumps(rows, indent=2)}\n")
    f.flush()


def section_E(f, sess):
    write_section(f, "SECTION E — Sample tool result: FL Mayor Orange County")
    r = post("/api/donation/lookup", {"state": "FL", "office": "Mayor", "race_year": 2026, "jurisdiction_name": "Orange County"}, sess)
    f.write(json.dumps(r, indent=2) + "\n")


def section_F(f, sess):
    write_section(f, "SECTION F — Sample tool result: FL US House FL-7 (federal — same unsupported deferral)")
    r = post("/api/donation/lookup", {"state": "FL", "office": "US House", "race_year": 2026, "jurisdiction_name": "FL-7"}, sess)
    f.write("Note: real FEC contribution-limits integration is deferred (FEC has\n")
    f.write("/v1/contribution-limits/ but it's a separate endpoint not yet wired).\n")
    f.write("Federal races currently fall through to authority-only stub like state/local.\n\n")
    f.write(json.dumps(r, indent=2) + "\n")


def section_D(f, sess):
    write_section(f, "SECTION D — Regression spot-checks")

    # Entity masking
    f.write("Entity masking battery:\n")
    out = subprocess.run([sys.executable, "scripts/test_entity_mask.py"],
                         capture_output=True, text=True, timeout=600)
    summary = [l for l in out.stdout.splitlines() if "PASS:" in l or "PASS (" in l or "all round-trips" in l]
    for s in summary[-15:]: f.write("  " + s + "\n")
    f.write("\n")

    # Compliance Class A
    f.write("Class A (filing deadline):\n")
    body = dict(RACE_GREG); body["message"] = "When is the filing deadline for my race?"
    body["conversation_id"] = f"p2b_reg_A_{int(time.time()*1000)}"
    try:
        _, t = turn_with_passthrough(body, sess)
        f.write(f"  Sam: {t[:280]}{'...' if len(t)>280 else ''}\n")
        defers = ("don't have" in t.lower()) or ("verify" in t.lower())
        f.write(f"  Looks like clean deferral: {defers}\n\n")
    except Exception as e: f.write(f"  ERROR: {e}\n\n")

    # Compliance Class B finance
    f.write("Class B finance (quarterly report):\n")
    body = dict(RACE_GREG); body["message"] = "When are my quarterly FEC filings due?"
    body["conversation_id"] = f"p2b_reg_B_{int(time.time()*1000)}"
    try:
        _, t = turn_with_passthrough(body, sess)
        f.write(f"  Sam: {t[:280]}{'...' if len(t)>280 else ''}\n")
        defers = ("don't have" in t.lower()) or ("verify" in t.lower())
        f.write(f"  Looks like clean deferral: {defers}\n\n")
    except Exception as e: f.write(f"  ERROR: {e}\n\n")

    # Opponent gate
    f.write("Opponent gate (B2):\n")
    body = dict(RACE_GREG)
    body["intelContext"] = {"opponents": [{"name": "Mayra Uribe", "party": "R", "office": "Mayor"}]}
    body["message"] = "Search the web for everything you can find on my opponent."
    body["conversation_id"] = f"p2b_reg_opp_{int(time.time()*1000)}"
    try:
        _, t = turn_with_passthrough(body, sess)
        f.write(f"  Sam: {t[:280]}{'...' if len(t)>280 else ''}\n")
        time.sleep(0.5)
        rows = d1(f"SELECT action_taken FROM sam_opponent_validation_events WHERE conversation_id = '{body['conversation_id']}'")
        blocked = any(r.get("action_taken") == "search_blocked" for r in rows)
        f.write(f"  search_blocked logged: {blocked}\n\n")
    except Exception as e: f.write(f"  ERROR: {e}\n\n")

    # Date preprocessor
    f.write("Date preprocessor (next Saturday):\n")
    body = dict(RACE_GREG); body["message"] = "What date is next Saturday?"
    body["conversation_id"] = f"p2b_reg_date_{int(time.time()*1000)}"
    try:
        _, t = turn_with_passthrough(body, sess)
        f.write(f"  Sam: {t[:200]}{'...' if len(t)>200 else ''}\n\n")
    except Exception as e: f.write(f"  ERROR: {e}\n\n")
    f.flush()


def main():
    out_path = "scripts/phase_2b_output.txt"
    print("Logging in...")
    sess = login()
    f = open(out_path, "w", encoding="utf-8", newline="\n")
    f.write(f"Phase 2b verification — {time.strftime('%Y-%m-%d %H:%M:%S')}\n")
    section_A(f, sess)
    section_E(f, sess)
    section_F(f, sess)
    section_B(f, sess)
    section_C(f, sess)
    section_D(f, sess)
    f.close()
    with open(out_path, "r", encoding="utf-8") as fh:
        sys.stdout.buffer.write(fh.read().encode("utf-8"))


if __name__ == "__main__":
    main()
