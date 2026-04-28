"""Phase 3 — Safe Mode tests.

Sections:
  A. Unit-style tests on getValidatorFiringBreakdown semantics:
     1. New conversation_id → count 0
     2. Seeded events (1 geographic + 1 compliance_a + 1 donation strip) → count 3
     3. Only 'passed' events → count 0
     4. Threshold triggers at exactly 3, not at 2

  B. Live Sam tests:
     5. Below-threshold: clean conversation, no banner
     6. Threshold trigger via D1-seeded events (deterministic), then live turn
        verifies Safe Mode banner appears AND Sam's response shows stricter
        deferral language
     7. Banner placement (literal text)
     8. Persistence: 3 more turns after activation, banner on each
     9. Fresh conversation_id reset: no Safe Mode carry-over
    10. Logging: exactly one row in sam_safe_mode_events with breakdown

  C. Regression spot-checks (existing validators still work)

Output: scripts/phase_3_output.txt
"""
import json, subprocess, sys, time, urllib.request

W = "https://candidate-toolbox-secretary2.grgsorrell.workers.dev"


def login(u="greg"):
    req = urllib.request.Request(W + "/auth/beta-login",
        data=json.dumps({"username": u, "password": "Beta#01"}).encode(),
        headers={"Content-Type": "application/json", "User-Agent": "tcb-p3/1.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        b = json.loads(r.read())
    return b["sessionId"], b["userId"]


def post(path, body, sess):
    req = urllib.request.Request(W + path, data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "User-Agent": "tcb-p3/1.0",
                 "Authorization": f"Bearer {sess}"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read())


def chat(body, sess):
    req = urllib.request.Request(W, data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "User-Agent": "tcb-p3/1.0",
                 "Authorization": f"Bearer {sess}"})
    with urllib.request.urlopen(req, timeout=180) as r:
        return json.loads(r.read())


def text_of(d):
    if not d or not isinstance(d.get("content"), list): return ""
    return "".join(b.get("text","") for b in d["content"] if isinstance(b,dict) and b.get("type")=="text").strip()


def d1(sql):
    out = subprocess.run(["wrangler.cmd","d1","execute","candidates-toolbox-db","--remote","--json","--command",sql],
                         capture_output=True, text=True, timeout=60)
    if out.returncode != 0: raise RuntimeError(out.stderr)
    return json.loads(out.stdout[out.stdout.find('['):])[0]["results"]


def d1_run(sql):
    out = subprocess.run(["wrangler.cmd","d1","execute","candidates-toolbox-db","--remote","--command",sql],
                         capture_output=True, text=True, timeout=60)
    return out.returncode == 0


RACE = {
    "candidateName":"Sarah Chen", "specificOffice":"Mayor", "state":"FL",
    "location":"Orange County", "officeType":"city",
    "electionDate":"2026-11-03", "daysToElection":189, "govLevel":"city",
    "budget":50000, "startingAmount":0, "fundraisingGoal":50000,
    "totalRaised":0, "donorCount":0, "winNumber":5000,
    "additionalContext":"", "candidateBrief":None, "intelContext":{},
    "raceProfile":None, "party":"", "history":[], "mode":"chat",
}


def turn(body, sess):
    """Send chat turn, server-resolves any tool calls, returns final data + text."""
    d1_resp = chat(body, sess)
    tools = [b for b in (d1_resp.get("content") or []) if isinstance(b, dict) and b.get("type") == "tool_use"]
    if not tools: return d1_resp, text_of(d1_resp)
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
    h2.append({"role":"assistant","content":d1_resp["content"]})
    h2.append({"role":"user","content":trs})
    b2 = dict(body); b2["history"] = h2
    d2 = chat(b2, sess)
    return d2, text_of(d2)


BANNER_MARKER = "\u26A0\uFE0F **Heads up:**"  # ⚠️ + heading


def write_section(f, title):
    f.write("\n" + "=" * 78 + "\n" + title + "\n" + "=" * 78 + "\n\n")


# ========== SECTION A ==========

def section_A(f, sess, uid):
    write_section(f, "SECTION A — Unit-style tests on getValidatorFiringBreakdown via Safe Mode trigger")
    # We can't call the helper directly (server-side closure), so we drive
    # the activation through the chat handler and observe sam_safe_mode_events
    # row presence. For pure-counter semantics we instead seed events into
    # the validator tables and ask sam_safe_mode_events to materialize.

    # Test 1: New conversation_id → no activation
    conv_new = f"p3_A1_new_{int(time.time()*1000)}"
    body = dict(RACE); body["conversation_id"] = conv_new
    body["message"] = "Hi, what should I work on this week?"
    _, t = turn(body, sess)
    rows = d1(f"SELECT COUNT(*) AS n FROM sam_safe_mode_events WHERE conversation_id = '{conv_new}'")
    new_count = (rows[0].get("n") if rows else 0)
    f.write(f"Test 1 — new conversation, no prior firings:\n")
    f.write(f"  sam_safe_mode_events row count: {new_count} (expected 0)\n")
    f.write(f"  Banner in response: {BANNER_MARKER in t}  (expected False)\n")
    f.write(f"  PASS: {(new_count == 0) and (BANNER_MARKER not in t)}\n\n")
    f.flush()

    # Test 2: Seed 3 events (1 geographic regen, 1 compliance_a regen, 1 donation strip)
    # Then send a turn and verify Safe Mode activates.
    conv_seed = f"p3_A2_seed_{int(time.time()*1000)}"
    d1_run(f"INSERT INTO sam_validation_events (id, conversation_id, workspace_owner_id, action_taken, jurisdiction_name, authorized_count, sam_mentioned_locations, unauthorized_locations) VALUES ('seedG_{int(time.time()*1000)}', '{conv_seed}', '{uid}', 'regenerated', 'Test', 0, '[]', '[\"Lake Mary\"]')")
    d1_run(f"INSERT INTO sam_compliance_validation_events (id, conversation_id, workspace_owner_id, action_taken) VALUES ('seedC_{int(time.time()*1000)}', '{conv_seed}', '{uid}', 'regenerated')")
    d1_run(f"INSERT INTO sam_donation_validation_events (id, conversation_id, workspace_owner_id, action_taken) VALUES ('seedD_{int(time.time()*1000)}', '{conv_seed}', '{uid}', 'stripped')")
    body = dict(RACE); body["conversation_id"] = conv_seed
    body["message"] = "What's on tap for this week?"
    _, t = turn(body, sess)
    rows = d1(f"SELECT trigger_count, triggering_validator_breakdown FROM sam_safe_mode_events WHERE conversation_id = '{conv_seed}'")
    f.write(f"Test 2 — 3 seeded firings (1 geo regen + 1 compliance_a regen + 1 donation strip):\n")
    f.write(f"  sam_safe_mode_events: {json.dumps(rows)}\n")
    f.write(f"  Banner in response: {BANNER_MARKER in t}  (expected True)\n")
    has_one_row = (len(rows) == 1)
    correct_count = has_one_row and rows[0].get("trigger_count") == 3
    f.write(f"  PASS: {has_one_row and correct_count and (BANNER_MARKER in t)}\n\n")
    f.flush()

    # Test 3: only 'passed' events → no activation
    conv_passed = f"p3_A3_passed_{int(time.time()*1000)}"
    for i in range(5):
        d1_run(f"INSERT INTO sam_validation_events (id, conversation_id, workspace_owner_id, action_taken, jurisdiction_name, authorized_count, sam_mentioned_locations, unauthorized_locations) VALUES ('seedP{i}_{int(time.time()*1000)}', '{conv_passed}', '{uid}', 'passed', 'Test', 0, '[]', '[]')")
    body = dict(RACE); body["conversation_id"] = conv_passed
    body["message"] = "What's on tap for this week?"
    _, t = turn(body, sess)
    rows = d1(f"SELECT COUNT(*) AS n FROM sam_safe_mode_events WHERE conversation_id = '{conv_passed}'")
    n = (rows[0].get("n") if rows else 0)
    f.write(f"Test 3 — 5 'passed' events only:\n")
    f.write(f"  sam_safe_mode_events count: {n} (expected 0)\n")
    f.write(f"  Banner in response: {BANNER_MARKER in t}  (expected False)\n")
    f.write(f"  PASS: {(n == 0) and (BANNER_MARKER not in t)}\n\n")
    f.flush()

    # Test 4: exactly 2 events → still below threshold
    conv_two = f"p3_A4_two_{int(time.time()*1000)}"
    d1_run(f"INSERT INTO sam_validation_events (id, conversation_id, workspace_owner_id, action_taken, jurisdiction_name, authorized_count, sam_mentioned_locations, unauthorized_locations) VALUES ('seedG2a_{int(time.time()*1000)}', '{conv_two}', '{uid}', 'regenerated', 'Test', 0, '[]', '[]')")
    d1_run(f"INSERT INTO sam_compliance_validation_events (id, conversation_id, workspace_owner_id, action_taken) VALUES ('seedC2_{int(time.time()*1000)}', '{conv_two}', '{uid}', 'regenerated')")
    body = dict(RACE); body["conversation_id"] = conv_two
    body["message"] = "What's on tap for this week?"
    _, t = turn(body, sess)
    rows = d1(f"SELECT COUNT(*) AS n FROM sam_safe_mode_events WHERE conversation_id = '{conv_two}'")
    n = (rows[0].get("n") if rows else 0)
    f.write(f"Test 4 — exactly 2 firings (BELOW threshold of 3):\n")
    f.write(f"  sam_safe_mode_events count: {n} (expected 0)\n")
    f.write(f"  Banner in response: {BANNER_MARKER in t}  (expected False)\n")
    f.write(f"  PASS: {(n == 0) and (BANNER_MARKER not in t)}\n\n")
    f.flush()


# ========== SECTION B ==========

def section_B(f, sess, uid):
    write_section(f, "SECTION B — Live Sam tests")

    # Test 5: Below threshold — full clean conversation, no banner
    conv5 = f"p3_B5_clean_{int(time.time()*1000)}"
    f.write("--- Test 5: Below threshold (5 clean turns) ---\n")
    questions = [
        "What should I work on this week?",
        "Help me think about my message.",
        "What's a good fundraising goal for a local race?",
        "How should I think about earned media?",
        "What's the best way to recruit volunteers?"
    ]
    history = []
    saw_banner = False
    for i, q in enumerate(questions, start=1):
        body = dict(RACE); body["message"] = q; body["history"] = history
        body["conversation_id"] = conv5
        _, t = turn(body, sess)
        if BANNER_MARKER in t: saw_banner = True
        history.append({"role":"user","content":q})
        history.append({"role":"assistant","content":t})
        f.write(f"  Turn {i} '{q}': banner={BANNER_MARKER in t}\n")
    f.write(f"  Banner ever appeared: {saw_banner}\n")
    f.write(f"  PASS: {not saw_banner}\n\n")
    f.flush()

    # Test 6: Threshold trigger via D1 seeding (deterministic)
    # Seed 3 firings, then send a turn — verify banner + stricter deferral.
    conv6 = f"p3_B6_trigger_{int(time.time()*1000)}"
    d1_run(f"INSERT INTO sam_validation_events (id, conversation_id, workspace_owner_id, action_taken, jurisdiction_name, authorized_count, sam_mentioned_locations, unauthorized_locations) VALUES ('B6g_{int(time.time()*1000)}', '{conv6}', '{uid}', 'regenerated', 'Test', 0, '[]', '[]')")
    d1_run(f"INSERT INTO sam_compliance_validation_events (id, conversation_id, workspace_owner_id, action_taken) VALUES ('B6c_{int(time.time()*1000)}', '{conv6}', '{uid}', 'regenerated')")
    d1_run(f"INSERT INTO sam_opponent_validation_events (id, conversation_id, workspace_owner_id, action_taken) VALUES ('B6o_{int(time.time()*1000)}', '{conv6}', '{uid}', 'regenerated')")
    body = dict(RACE); body["conversation_id"] = conv6
    body["message"] = "What date is the filing deadline?"
    d6, t6 = turn(body, sess)
    f.write("--- Test 6: Threshold trigger (3 D1-seeded firings, then live turn) ---\n")
    f.write(f"  Sam's response (full):\n{t6}\n\n")
    has_banner = BANNER_MARKER in t6
    has_stricter = ("don't have" in t6.lower() or "verify" in t6.lower() or "i\\'ve had" in t6.lower())
    f.write(f"  Banner present: {has_banner}\n")
    f.write(f"  Stricter deferral language: {has_stricter}\n")
    f.write(f"  PASS: {has_banner and has_stricter}\n\n")
    f.flush()

    # Test 7: Banner placement — paste literal full response
    f.write("--- Test 7: Banner placement (literal full response from Test 6) ---\n")
    f.write("BANNER STARTS BELOW:\n")
    f.write(t6 + "\n")
    f.write("BANNER ENDS ABOVE.\n")
    starts_with_banner = t6.startswith(BANNER_MARKER)
    has_separator = "---" in t6.split(BANNER_MARKER, 1)[1][:100] if BANNER_MARKER in t6 else False
    f.write(f"  Response starts with banner marker: {starts_with_banner}\n")
    f.write(f"  Banner separator '---' present: {has_separator}\n")
    f.write(f"  PASS: {starts_with_banner and has_separator}\n\n")
    f.flush()

    # Test 8: Persistence — 3 more turns in same conv, banner on each
    f.write("--- Test 8: Persistence (3 more turns in conv6) ---\n")
    history = [
        {"role":"user","content":body["message"]},
        {"role":"assistant","content":t6}
    ]
    persist_results = []
    for i, q in enumerate(["What about strategy?", "How should I think about volunteers?", "Anything urgent this week?"], start=1):
        body2 = dict(RACE); body2["message"] = q; body2["history"] = history
        body2["conversation_id"] = conv6
        _, tt = turn(body2, sess)
        present = BANNER_MARKER in tt
        persist_results.append(present)
        f.write(f"  Turn +{i} '{q}': banner={present}\n")
        history.append({"role":"user","content":q})
        history.append({"role":"assistant","content":tt})
    f.write(f"  All subsequent turns had banner: {all(persist_results)}\n")
    f.write(f"  PASS: {all(persist_results)}\n\n")
    f.flush()

    # Test 9: Fresh conversation_id → no Safe Mode carry-over
    conv9 = f"p3_B9_fresh_{int(time.time()*1000)}"
    body = dict(RACE); body["conversation_id"] = conv9
    body["message"] = "Hello, what should I focus on this week?"
    _, t9 = turn(body, sess)
    has_banner_fresh = BANNER_MARKER in t9
    rows = d1(f"SELECT COUNT(*) AS n FROM sam_safe_mode_events WHERE conversation_id = '{conv9}'")
    n_rows = (rows[0].get("n") if rows else 0)
    f.write("--- Test 9: Fresh conversation_id, no carry-over ---\n")
    f.write(f"  Banner in response: {has_banner_fresh}  (expected False)\n")
    f.write(f"  sam_safe_mode_events row for fresh conv: {n_rows}  (expected 0)\n")
    f.write(f"  PASS: {(not has_banner_fresh) and (n_rows == 0)}\n\n")
    f.flush()

    # Test 10: Logging — exactly one row in sam_safe_mode_events for conv6
    rows = d1(f"SELECT trigger_count, triggering_validator_breakdown, datetime(activated_at) AS at FROM sam_safe_mode_events WHERE conversation_id = '{conv6}' ORDER BY activated_at")
    f.write("--- Test 10: Logging — exactly ONE row per conv after activation ---\n")
    f.write(f"  Rows for conv6: {len(rows)}  (expected 1)\n")
    if rows:
        f.write(f"  trigger_count: {rows[0].get('trigger_count')}\n")
        f.write(f"  triggering_validator_breakdown: {rows[0].get('triggering_validator_breakdown')}\n")
        f.write(f"  activated_at: {rows[0].get('at')}\n")
    expected_breakdown = (rows and rows[0].get("trigger_count") == 3)
    f.write(f"  PASS: {(len(rows) == 1) and expected_breakdown}\n\n")
    f.flush()


# ========== SECTION C — regression spot-checks ==========

def section_C(f, sess):
    write_section(f, "SECTION C — Regression spot-checks (existing validators)")

    cases = [
        ("Class A compliance", "When is the filing deadline for my race?"),
        ("Class B finance",    "When are my quarterly finance reports due?"),
        ("Phase 2b donation",  "What's the maximum donation an individual can give?"),
        ("Date preprocessor",  "What date is next Saturday?"),
    ]
    for label, q in cases:
        body = dict(RACE); body["message"] = q
        body["conversation_id"] = f"p3_C_{label.replace(' ','_')}_{int(time.time()*1000)}"
        try:
            _, t = turn(body, sess)
        except Exception as e:
            t = f"[ERROR: {e}]"
        f.write(f"=== {label} ===\nQ: {q}\nSam: {t[:280]}{'...' if len(t)>280 else ''}\nBanner: {BANNER_MARKER in t}  (expected False — fresh conv)\n\n")
        f.flush()


def main():
    out_path = "scripts/phase_3_output.txt"
    f = open(out_path, "w", encoding="utf-8", newline="\n")
    f.write(f"Phase 3 — Safe Mode tests — {time.strftime('%Y-%m-%d %H:%M:%S')}\n\n")
    sess, uid = login("shannan")
    f.write(f"Shannan userId: {uid}\n")
    section_A(f, sess, uid)
    section_B(f, sess, uid)
    section_C(f, sess)
    f.close()
    with open(out_path, "r", encoding="utf-8") as fh:
        sys.stdout.buffer.write(fh.read().encode("utf-8"))


if __name__ == "__main__":
    main()
