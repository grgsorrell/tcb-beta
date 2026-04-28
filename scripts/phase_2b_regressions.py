"""Phase 2b regression spot-checks — using shannan login for fresh quota."""
import json, subprocess, sys, time, urllib.request

W = "https://candidate-toolbox-secretary2.grgsorrell.workers.dev"


def login(u):
    req = urllib.request.Request(W + "/auth/beta-login",
        data=json.dumps({"username": u, "password": "Beta#01"}).encode(),
        headers={"Content-Type": "application/json", "User-Agent": "tcb-p2br/1.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())["sessionId"]


def post(path, body, sess):
    req = urllib.request.Request(W + path, data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "User-Agent": "tcb-p2br/1.0",
                 "Authorization": f"Bearer {sess}"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read())


def chat(body, sess):
    req = urllib.request.Request(W, data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "User-Agent": "tcb-p2br/1.0",
                 "Authorization": f"Bearer {sess}"})
    with urllib.request.urlopen(req, timeout=180) as r:
        return json.loads(r.read())


def text_of(d):
    if not d or not isinstance(d.get("content"), list): return ""
    return "".join(b.get("text","") for b in d["content"] if isinstance(b,dict) and b.get("type")=="text").strip()


def d1(sql):
    out = subprocess.run(["wrangler.cmd","d1","execute","candidates-toolbox-db","--remote","--json","--command",sql],
                         capture_output=True, text=True, timeout=60)
    return json.loads(out.stdout[out.stdout.find('['):])[0]["results"]


RACE = {
    "candidateName": "Sarah Chen", "specificOffice": "Mayor", "state": "FL",
    "location": "Orange County", "officeType": "city",
    "electionDate": "2026-11-03", "daysToElection": 189, "govLevel": "city",
    "budget": 50000, "startingAmount": 0, "fundraisingGoal": 50000,
    "totalRaised": 0, "donorCount": 0, "winNumber": 5000,
    "additionalContext": "", "candidateBrief": None, "intelContext": {},
    "raceProfile": None, "party": "", "history": [], "mode": "chat",
}


def turn(body, sess):
    d1_ = chat(body, sess)
    tools = [b for b in (d1_.get("content") or []) if isinstance(b, dict) and b.get("type") == "tool_use"]
    if not tools: return text_of(d1_)
    trs = []
    for t in tools:
        nm, inp = t.get("name"), t.get("input") or {}
        if nm == "lookup_donation_limits":
            r = post("/api/donation/lookup", {"state":inp.get("state",""),"office":inp.get("office",""),"race_year":inp.get("race_year",2026),"jurisdiction_name":inp.get("jurisdiction_name","")}, sess)
        elif nm == "lookup_finance_reports":
            r = post("/api/finance/lookup", {"state":inp.get("state",""),"office":inp.get("office",""),"race_year":inp.get("race_year",2026),"jurisdiction_name":inp.get("jurisdiction_name","")}, sess)
        elif nm == "lookup_compliance_deadlines":
            r = post("/api/compliance/lookup", {"state":inp.get("state",""),"office":inp.get("office",""),"race_year":inp.get("race_year",2026),"jurisdiction_name":inp.get("jurisdiction_name","")}, sess)
        elif nm == "lookup_jurisdiction":
            r = post("/api/jurisdiction/lookup", {"office":inp.get("office",""),"state":inp.get("state",""),"jurisdiction_name":inp.get("jurisdiction_name","")}, sess)
        else:
            r = "Done"
        trs.append({"type":"tool_result","tool_use_id":t["id"],"content":json.dumps(r) if not isinstance(r,str) else r})
    h2 = list(body.get("history") or [])
    h2.append({"role":"user","content":body.get("message")})
    h2.append({"role":"assistant","content":d1_["content"]})
    h2.append({"role":"user","content":trs})
    b2 = dict(body); b2["history"] = h2
    return text_of(chat(b2, sess))


def main():
    f = open("scripts/phase_2b_regressions_output.txt", "w", encoding="utf-8", newline="\n")
    f.write(f"Phase 2b regression spot-checks (shannan login) — {time.strftime('%Y-%m-%d %H:%M:%S')}\n\n")
    sess = login("shannan")

    cases = [
        ("compliance_A", "When is the filing deadline for my race?", "Class A compliance"),
        ("finance_B",    "When are my quarterly finance reports due?", "Class B finance"),
        ("donation_2b",  "What's the maximum donation an individual can give?", "Phase 2b donation"),
        ("date",         "What date is next Saturday?", "date preprocessor"),
        ("opp_gate",     "Search the web for everything you can find on my opponent.", "opponent gate"),
    ]
    for label, q, note in cases:
        body = dict(RACE); body["message"] = q
        body["conversation_id"] = f"reg_{label}_{int(time.time()*1000)}"
        if label == "opp_gate":
            body["intelContext"] = {"opponents": [{"name": "Mayra Uribe", "party": "R", "office": "Mayor"}]}
        f.write(f"=== {note} ===\nQ: {q}\n\n")
        try:
            t = turn(body, sess)
            f.write(t + "\n\n")
            if label == "opp_gate":
                time.sleep(0.5)
                rows = d1(f"SELECT action_taken FROM sam_opponent_validation_events WHERE conversation_id = '{body['conversation_id']}'")
                f.write(f"search_blocked event present: {any(r.get('action_taken')=='search_blocked' for r in rows)}\n")
        except Exception as e:
            f.write(f"[ERROR: {e}]\n")
        f.write("-" * 70 + "\n\n")
        f.flush()

    # Entity masking — has its own internal auth
    f.write("=== entity masking battery (test_entity_mask.py) ===\n")
    out = subprocess.run([sys.executable, "scripts/test_entity_mask.py"],
                         capture_output=True, text=True, timeout=600)
    summary = [l for l in out.stdout.splitlines() if "PASS:" in l or "PASS (" in l or "all round-trips" in l]
    for s in summary[-15:]: f.write("  " + s + "\n")
    f.close()
    with open("scripts/phase_2b_regressions_output.txt","r",encoding="utf-8") as fh:
        sys.stdout.buffer.write(fh.read().encode("utf-8"))


if __name__ == "__main__":
    main()
