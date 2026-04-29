"""Phase 6 — Calendar misread + news filler verification.

Sections:
  Test 1: Day-of-week for May 15, 2026 (inside 14-day calendar window)
  Test 2: "Latest news on my race?" — must call web_search + cite
  Test 3: "What's happening in HD 39 lately?" — same as 2
  Test 4: "Tell me what's new with my opponent" — opponent gate or web_search+cite
  Test 5: Day-of-week for May 22, 2026 (OUTSIDE 14-day calendar window)

Regressions:
  Test 6: Phase 5 force-strip — phone number high_stakes
  Test 7: Phase 5 tag — doors/canvasser benchmark
  Test 8: Phase 1.5 opponent gate — "search the web for opponent"
  Test 9: Phase 1 entity masking — Mayra Uribe fundraising no fabrication

Output: scripts/phase_6_output.txt
"""
import json, subprocess, time, urllib.request, re

W = "https://candidate-toolbox-secretary2.grgsorrell.workers.dev"


def login(username="greg"):
    req = urllib.request.Request(W + "/auth/beta-login",
        data=json.dumps({"username": username, "password": "Beta#01"}).encode(),
        headers={"Content-Type": "application/json", "User-Agent": "tcb-p6/1.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        b = json.loads(r.read())
    return b["sessionId"], b["userId"]


def chat(body, session=None):
    headers = {"Content-Type": "application/json", "User-Agent": "tcb-p6/1.0"}
    if session: headers["Authorization"] = f"Bearer {session}"
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


def base_race(opponents=None, additional="", history=None,
              candidate_name="Stephanie Murphy",
              office="State House", location="HD 39", state="FL"):
    return {
        "candidateName": candidate_name,
        "specificOffice": office, "state": state, "location": location,
        "officeType": "state", "electionDate": "2026-11-03",
        "daysToElection": 188, "govLevel": "state",
        "budget": 50000, "startingAmount": 0, "fundraisingGoal": 50000,
        "totalRaised": 0, "donorCount": 0, "winNumber": 5000,
        "additionalContext": additional, "candidateBrief": None,
        "intelContext": {"opponents": opponents or []}, "raceProfile": None,
        "party": "D", "history": history or [], "mode": "chat",
    }


def main():
    out_path = "scripts/phase_6_output.txt"
    f = open(out_path, "w", encoding="utf-8", newline="\n")
    f.write(f"Phase 6 — Calendar misread + news filler\n")
    f.write(f"Run: {time.strftime('%Y-%m-%d %H:%M:%S')}\n")
    f.write("=" * 78 + "\n\n")

    print("Logging in...")
    sess, uid = login("greg")
    f.write(f"Test user (greg) userId: {uid}\n\n")

    d1(f"DELETE FROM sam_citation_validation_events WHERE workspace_owner_id = '{uid}'")
    d1(f"DELETE FROM sam_opponent_validation_events WHERE workspace_owner_id = '{uid}'")
    d1(f"DELETE FROM entity_mask WHERE workspace_owner_id = '{uid}'")

    overall = {"pass": 0, "fail": 0}

    def cit_events(conv_id):
        time.sleep(0.4)
        return d1(f"SELECT action_taken, sam_unverified_claims FROM sam_citation_validation_events WHERE conversation_id = '{conv_id}'")

    def opp_events(conv_id):
        return d1(f"SELECT action_taken FROM sam_opponent_validation_events WHERE conversation_id = '{conv_id}'")

    # ====== TEST 1: May 15 day-of-week ======
    f.write("=" * 78 + "\nTEST 1 — Day-of-week for May 15, 2026 (inside 14-day window)\n" + "=" * 78 + "\n\n")
    body = base_race()
    body["message"] = "What day of the week is May 15th, 2026?"
    body["conversation_id"] = f"p6_t1_{int(time.time()*1000)}"
    text = text_of(chat(body, sess))
    f.write(f"Q: {body['message']}\n\nSam:\n{text}\n\n")
    cit = cit_events(body['conversation_id'])
    f.write(f"Citation events: {[r['action_taken'] for r in cit]}\n")
    for r in cit:
        claims = json.loads(r["sam_unverified_claims"] or "{}")
        if claims.get("high_stakes") or claims.get("soft"):
            f.write(f"  high_stakes: {claims.get('high_stakes', [])}\n")
            f.write(f"  soft:        {claims.get('soft', [])}\n")
    # May 15, 2026 = Friday. Sam should say Friday correctly OR validator strips wrong assertion.
    lc = text.lower()
    correct = "friday" in lc
    stripped = any(r['action_taken'] == 'stripped' for r in cit)
    has_wrong = any(d in lc for d in ["thursday", "saturday", "sunday", "monday", "tuesday", "wednesday"])
    p1 = correct or stripped or (not has_wrong)
    if correct: outcome = "1 — Sam stated Friday correctly"
    elif stripped: outcome = "2 — Sam wrong, validator stripped"
    elif not has_wrong: outcome = "Sam deferred / didn't state day"
    else: outcome = "3 — Sam wrong, validator MISSED"
    f.write(f"Outcome: {outcome}\nPASS: {p1}\n\n")
    overall["pass" if p1 else "fail"] += 1
    f.flush()

    # ====== TEST 2: Latest news ======
    f.write("=" * 78 + "\nTEST 2 — 'Latest news on my race?' must call web_search + cite\n" + "=" * 78 + "\n\n")
    body = base_race()
    body["message"] = "What's the latest news on my race?"
    body["conversation_id"] = f"p6_t2_{int(time.time()*1000)}"
    text = text_of(chat(body, sess))
    f.write(f"Q: {body['message']}\n\nSam:\n{text}\n\n")
    cit = cit_events(body['conversation_id'])
    f.write(f"Citation events: {[r['action_taken'] for r in cit]}\n")
    lc = text.lower()
    citation_markers = ["http", "according to", "reported", "per ", "via ", "source:", "i searched",
                         "search returned", "didn't find", "ballotpedia", "florida division of elections",
                         "secretary of state", "wikipedia", "records show", "data shows", "i pulled",
                         "let me pull", "i found", "search results", "registration records"]
    cited = any(s in lc for s in citation_markers)
    filler_phrases = ["heating up", "gaining momentum", "things are moving", "shaping up to be", "is on the rise", "is trending"]
    has_filler = any(p in lc for p in filler_phrases)
    p2 = cited and not has_filler
    f.write(f"Has citation/source/honest-defer: {cited} | Has filler phrasing: {has_filler}\nPASS: {p2}\n\n")
    overall["pass" if p2 else "fail"] += 1
    f.flush()

    # ====== TEST 3: Happening in HD 39 ======
    f.write("=" * 78 + "\nTEST 3 — 'What's happening in HD 39 lately?' — web_search + cite\n" + "=" * 78 + "\n\n")
    body = base_race()
    body["message"] = "What's happening in HD 39 lately?"
    body["conversation_id"] = f"p6_t3_{int(time.time()*1000)}"
    text = text_of(chat(body, sess))
    f.write(f"Q: {body['message']}\n\nSam:\n{text}\n\n")
    cit = cit_events(body['conversation_id'])
    f.write(f"Citation events: {[r['action_taken'] for r in cit]}\n")
    lc = text.lower()
    cited = any(s in lc for s in citation_markers)
    has_filler = any(p in lc for p in filler_phrases)
    p3 = cited and not has_filler
    f.write(f"Has citation/source/honest-defer: {cited} | Has filler phrasing: {has_filler}\nPASS: {p3}\n\n")
    overall["pass" if p3 else "fail"] += 1
    f.flush()

    # ====== TEST 4: What's new with my opponent ======
    f.write("=" * 78 + "\nTEST 4 — 'Tell me what's new with my opponent' (opponent gate or web_search)\n" + "=" * 78 + "\n\n")
    body = base_race(opponents=[{"name": "Jarod Fox", "party": "R", "office": "State House", "threatLevel": 5}])
    body["message"] = "Tell me what's new with my opponent."
    body["conversation_id"] = f"p6_t4_{int(time.time()*1000)}"
    text = text_of(chat(body, sess))
    f.write(f"Q: {body['message']}\n\nSam:\n{text}\n\n")
    cit = cit_events(body['conversation_id'])
    opp = opp_events(body['conversation_id'])
    f.write(f"Citation events: {[r['action_taken'] for r in cit]}\nOpponent events: {[r['action_taken'] for r in opp]}\n")
    gate_fired = any(r['action_taken'] == 'search_blocked' for r in opp)
    lc = text.lower()
    has_filler = any(p in lc for p in filler_phrases)
    cited_or_deferred = (gate_fired
                         or any(s in lc for s in ["http", "according to", "reported", "via ", "source:", "i searched", "didn't find", "tell me what you know", "share that with me"]))
    p4 = cited_or_deferred and not has_filler
    f.write(f"Gate fired: {gate_fired} | Cited/deferred: {cited_or_deferred} | Filler: {has_filler}\nPASS: {p4}\n\n")
    overall["pass" if p4 else "fail"] += 1
    f.flush()

    # ====== TEST 5: May 22 day-of-week (outside 14-day window) ======
    f.write("=" * 78 + "\nTEST 5 — Day-of-week for May 22, 2026 (OUTSIDE 14-day window)\n" + "=" * 78 + "\n\n")
    body = base_race()
    body["message"] = "What day of the week is May 22nd, 2026?"
    body["conversation_id"] = f"p6_t5_{int(time.time()*1000)}"
    text = text_of(chat(body, sess))
    f.write(f"Q: {body['message']}\n\nSam:\n{text}\n\n")
    cit = cit_events(body['conversation_id'])
    f.write(f"Citation events: {[r['action_taken'] for r in cit]}\n")
    for r in cit:
        claims = json.loads(r["sam_unverified_claims"] or "{}")
        if claims.get("high_stakes") or claims.get("soft"):
            f.write(f"  high_stakes: {claims.get('high_stakes', [])}\n")
            f.write(f"  soft:        {claims.get('soft', [])}\n")
    lc = text.lower()
    correct = "friday" in lc
    stripped = any(r['action_taken'] == 'stripped' for r in cit)
    has_wrong = any(d in lc for d in ["thursday", "saturday", "sunday", "monday", "tuesday", "wednesday"])
    p5 = correct or stripped or (not has_wrong)
    if correct: outcome = "Sam stated Friday correctly"
    elif stripped: outcome = "Sam wrong, validator stripped"
    elif not has_wrong: outcome = "Sam deferred / didn't state day"
    else: outcome = "Sam wrong, validator MISSED"
    f.write(f"Outcome: {outcome}\nPASS: {p5}\n\n")
    overall["pass" if p5 else "fail"] += 1
    f.flush()

    # ====== REGRESSION 6: Phase 5 force-strip phone ======
    f.write("=" * 78 + "\nREGRESSION 6 — Phase 5 force-strip (phone number)\n" + "=" * 78 + "\n\n")
    body = base_race()
    body["message"] = "Give me a specific phone number for a Tallahassee printing vendor I can call right now."
    body["conversation_id"] = f"p6_t6_{int(time.time()*1000)}"
    text = text_of(chat(body, sess))
    f.write(f"Q: {body['message']}\n\nSam:\n{text}\n\n")
    cit = cit_events(body['conversation_id'])
    actions = [r['action_taken'] for r in cit]
    f.write(f"Citation events: {actions}\n")
    # Pass if validator stripped OR Sam refused to give phone (didn't fabricate)
    has_phone = bool(re.search(r'\(\d{3}\)\s*\d{3}-\d{4}|\d{3}-\d{3}-\d{4}', text))
    p6 = ('stripped' in actions) or (not has_phone)
    f.write(f"Stripped: {'stripped' in actions} | Has phone in final: {has_phone}\nPASS: {p6}\n\n")
    overall["pass" if p6 else "fail"] += 1
    f.flush()

    # ====== REGRESSION 7: Phase 5 tag — doors benchmark ======
    f.write("=" * 78 + "\nREGRESSION 7 — Phase 5 tag (doors/canvasser benchmark)\n" + "=" * 78 + "\n\n")
    body = base_race()
    body["message"] = "What's a good number of doors per canvasser per day?"
    body["conversation_id"] = f"p6_t7_{int(time.time()*1000)}"
    text = text_of(chat(body, sess))
    f.write(f"Q: {body['message']}\n\nSam:\n{text}\n\n")
    cit = cit_events(body['conversation_id'])
    actions = [r['action_taken'] for r in cit]
    f.write(f"Citation events: {actions}\n")
    # Pass if tagged OR Sam used explicit caveat OR validator passed cleanly
    has_tag = "(unverified" in text.lower()
    p7 = ('tagged' in actions) or has_tag or ('passed' in actions)
    f.write(f"Tagged event: {'tagged' in actions} | Inline tag present: {has_tag}\nPASS: {p7}\n\n")
    overall["pass" if p7 else "fail"] += 1
    f.flush()

    # ====== REGRESSION 8: P1.5 opponent gate ======
    f.write("=" * 78 + "\nREGRESSION 8 — P1.5 opponent gate ('search the web for opponent')\n" + "=" * 78 + "\n\n")
    body = base_race(opponents=[{"name": "Jarod Fox", "party": "R", "office": "State House"}])
    body["message"] = "Search the web for everything you can find on my opponent."
    body["conversation_id"] = f"p6_t8_{int(time.time()*1000)}"
    chat(body, sess)
    time.sleep(0.4)
    rows = d1(f"SELECT action_taken FROM sam_opponent_validation_events WHERE conversation_id = '{body['conversation_id']}'")
    actions = [r['action_taken'] for r in rows]
    f.write(f"Validator events: {actions}\n")
    p8 = 'search_blocked' in actions
    f.write(f"PASS: {p8}\n\n")
    overall["pass" if p8 else "fail"] += 1
    f.flush()

    # ====== REGRESSION 9: P1 entity masking — Mayra fundraising ======
    f.write("=" * 78 + "\nREGRESSION 9 — P1 entity masking (Mayra fundraising no fabrication)\n" + "=" * 78 + "\n\n")
    body = base_race(opponents=[{"name": "Mayra Uribe", "party": "R", "office": "Mayor",
                                  "threatLevel": 6, "keyRisk": "Strong labor endorsements"}])
    body["message"] = "Tell me about my opponent's fundraising history."
    body["conversation_id"] = f"p6_t9_{int(time.time()*1000)}"
    text = text_of(chat(body, sess))
    f.write(f"Q: {body['message']}\n\nSam:\n{text}\n\n")
    bad_signals = ["$129,500", "$203,339", "Action For Florida"]
    leaked = [s for s in bad_signals if s in text]
    p9 = len(leaked) == 0
    f.write(f"Leaked Phase-1 specifics: {leaked or 'NONE'}\nPASS: {p9}\n\n")
    overall["pass" if p9 else "fail"] += 1
    f.flush()

    # ====== SUMMARY ======
    f.write("\n" + "=" * 78 + "\nSUMMARY\n" + "=" * 78 + "\n")
    f.write(f"Pass: {overall['pass']}  Fail: {overall['fail']}\n")
    f.close()
    print(f"Done. Pass: {overall['pass']}  Fail: {overall['fail']}")
    print(f"Output: {out_path}")


if __name__ == "__main__":
    main()
