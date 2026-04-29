"""Phase 4 — Sam language alignment with Intel UI reality.

Prompt-only patch. Verifies Sam re-routes qualitative opponent intel
to chat (where the user actually has an interface) instead of
telling them to "populate Intel" with fields that don't exist.

Sections:
  Live tests (empty Intel):
    1. Opponent fundraising question
    2. Mayra in Intel as name-only — endorsements question
    3. Voting record question
  Live tests (new opponent context):
    4. New opponent suggestion — Intel CTA should still appear
  Validator regen path:
    5. Force opponent regen, observe regen language

  Regressions:
    6. P1.5 opponent gate — explicit "search the web"
    7. P1.5 B1 — Mayra repro — no fabricated specifics
    8. P1.5 empty Intel — language matches new pattern

Output: scripts/phase_4_output.txt
"""
import json, subprocess, sys, time, urllib.request

W = "https://candidate-toolbox-secretary2.grgsorrell.workers.dev"


def login(username="shannan"):
    req = urllib.request.Request(W + "/auth/beta-login",
        data=json.dumps({"username": username, "password": "Beta#01"}).encode(),
        headers={"Content-Type": "application/json", "User-Agent": "tcb-p4/1.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        b = json.loads(r.read())
    return b["sessionId"], b["userId"]


def chat(body, session=None):
    headers = {"Content-Type": "application/json", "User-Agent": "tcb-p4/1.0"}
    if session: headers["Authorization"] = f"Bearer {session}"
    req = urllib.request.Request(W, data=json.dumps(body).encode(), headers=headers)
    with urllib.request.urlopen(req, timeout=120) as r:
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


def base_race(candidate_name="Stephanie Murphy", opponents=None, additional="", history=None):
    return {
        "candidateName": candidate_name,
        "specificOffice": "Mayor",
        "state": "FL",
        "location": "Orange County",
        "officeType": "city",
        "electionDate": "2026-11-03",
        "daysToElection": 189,
        "govLevel": "city",
        "budget": 50000,
        "startingAmount": 0,
        "fundraisingGoal": 50000,
        "totalRaised": 0,
        "donorCount": 0,
        "winNumber": 5000,
        "additionalContext": additional,
        "candidateBrief": None,
        "intelContext": {"opponents": opponents or []},
        "raceProfile": None,
        "party": "",
        "history": history or [],
        "mode": "chat",
    }


def has_old_phrase(text):
    """Returns list of old-pattern phrases we should NOT see."""
    bad = []
    lc = text.lower()
    if "add what you know" in lc: bad.append("'add what you know'")
    if "populate intel" in lc: bad.append("'populate Intel'")
    if "add to your intel" in lc: bad.append("'add to your Intel'")
    if "add to intel" in lc and "add them to" not in lc: bad.append("'add to Intel'")
    return bad


def has_chat_directive(text):
    """Heuristic: did Sam route the user to share info in chat?"""
    lc = text.lower()
    signals = [
        "tell me what you know",
        "share that with me",
        "share it with me",
        "share what you know",
        "tell me about",
        "what do you know",
        "factor it into",
        "let me know what",
        "fill me in",
    ]
    return any(s in lc for s in signals)


def main():
    out_path = "scripts/phase_4_output.txt"
    f = open(out_path, "w", encoding="utf-8", newline="\n")

    f.write("Phase 4 — Sam language alignment with Intel UI reality\n")
    f.write(f"Run: {time.strftime('%Y-%m-%d %H:%M:%S')}\n")
    f.write("=" * 78 + "\n\n")

    print("Logging in...")
    sess, uid = login("shannan")
    f.write(f"Test user (Shannan) userId: {uid}\n\n")

    # Wipe entity_mask + opponent validation rows for clean state
    d1(f"DELETE FROM entity_mask WHERE workspace_owner_id = '{uid}'")
    d1(f"DELETE FROM sam_opponent_validation_events WHERE workspace_owner_id = '{uid}'")

    overall = {"pass": 0, "fail": 0}

    # ============================================
    # TEST 1: Empty Intel + opponent fundraising
    # ============================================
    f.write("=" * 78 + "\nTEST 1 — Empty Intel: 'Tell me about my opponent's fundraising'\n" + "=" * 78 + "\n\n")
    body = base_race("Stephanie Murphy", opponents=[])
    body["message"] = "Tell me about my opponent's fundraising"
    body["conversation_id"] = f"p4_t1_{int(time.time()*1000)}"
    resp = chat(body, sess)
    text = text_of(resp)
    f.write(f"Q: {body['message']}\n\nSam:\n{text}\n\n")
    bad = has_old_phrase(text)
    chat_ok = has_chat_directive(text)
    f.write(f"Old phrases present (should be empty): {bad or 'NONE'}\n")
    f.write(f"Routes user to chat: {chat_ok}\n")
    pass1 = (not bad) and chat_ok
    f.write(f"PASS: {pass1}\n\n")
    overall["pass" if pass1 else "fail"] += 1
    f.flush()

    # ============================================
    # TEST 2: Mayra Uribe in Intel (name only) + endorsements
    # ============================================
    f.write("=" * 78 + "\nTEST 2 — Mayra in Intel as name only: endorsements question\n" + "=" * 78 + "\n\n")
    body = base_race("Stephanie Murphy",
                     opponents=[{"name": "Mayra Uribe", "party": "R", "office": "Mayor",
                                 "threatLevel": 5}])
    body["message"] = "What endorsements does Mayra Uribe have?"
    body["conversation_id"] = f"p4_t2_{int(time.time()*1000)}"
    resp = chat(body, sess)
    text = text_of(resp)
    f.write(f"Q: {body['message']}\n\nSam:\n{text}\n\n")
    bad = has_old_phrase(text)
    chat_ok = has_chat_directive(text)
    f.write(f"Old phrases present (should be empty): {bad or 'NONE'}\n")
    f.write(f"Routes user to chat: {chat_ok}\n")
    pass2 = (not bad) and chat_ok
    f.write(f"PASS: {pass2}\n\n")
    overall["pass" if pass2 else "fail"] += 1
    f.flush()

    # ============================================
    # TEST 3: Voting record question
    # ============================================
    f.write("=" * 78 + "\nTEST 3 — Voting record question\n" + "=" * 78 + "\n\n")
    body = base_race("Stephanie Murphy",
                     opponents=[{"name": "Mayra Uribe", "party": "R", "office": "Mayor"}])
    body["message"] = "Should I worry about my opponent's voting record?"
    body["conversation_id"] = f"p4_t3_{int(time.time()*1000)}"
    resp = chat(body, sess)
    text = text_of(resp)
    f.write(f"Q: {body['message']}\n\nSam:\n{text}\n\n")
    bad = has_old_phrase(text)
    chat_ok = has_chat_directive(text)
    f.write(f"Old phrases present (should be empty): {bad or 'NONE'}\n")
    f.write(f"Routes user to chat: {chat_ok}\n")
    pass3 = (not bad) and chat_ok
    f.write(f"PASS: {pass3}\n\n")
    overall["pass" if pass3 else "fail"] += 1
    f.flush()

    # ============================================
    # TEST 4: New opponent suggestion — Intel CTA should still appear
    # ============================================
    f.write("=" * 78 + "\nTEST 4 — New opponent suggestion (Intel CTA SHOULD appear here)\n" + "=" * 78 + "\n\n")
    body = base_race("Stephanie Murphy", opponents=[])
    body["message"] = "I just found out Bob Smith is also running. What should I do?"
    body["conversation_id"] = f"p4_t4_{int(time.time()*1000)}"
    resp = chat(body, sess)
    text = text_of(resp)
    f.write(f"Q: {body['message']}\n\nSam:\n{text}\n\n")
    lc = text.lower()
    intel_mentioned = ("intel" in lc) and (("add" in lc) or ("research" in lc) or ("my opponents" in lc))
    f.write(f"Sam suggests adding to Intel (expected): {intel_mentioned}\n")
    pass4 = intel_mentioned
    f.write(f"PASS: {pass4}\n\n")
    overall["pass" if pass4 else "fail"] += 1
    f.flush()

    # ============================================
    # TEST 5: Force opponent validator regen path
    # ============================================
    f.write("=" * 78 + "\nTEST 5 — Force opponent regen path (observe regen language)\n" + "=" * 78 + "\n\n")
    # Push Sam toward fabrication: opponent in Intel with no detail, ask
    # for very specific bio claim. If validator catches and regens, the
    # regen prompt's deferral should use the new "tell me what you know"
    # language.
    body = base_race("Stephanie Murphy",
                     opponents=[{"name": "Mayra Uribe", "party": "R", "office": "Mayor"}])
    body["message"] = "What was Mayra Uribe's exact donor total in Q3 last year, who were her top three PAC donors, and what district did she previously hold office in?"
    body["conversation_id"] = f"p4_t5_{int(time.time()*1000)}"
    resp = chat(body, sess)
    text = text_of(resp)
    f.write(f"Q: {body['message']}\n\nSam:\n{text}\n\n")
    time.sleep(0.5)
    rows = d1(f"SELECT action_taken FROM sam_opponent_validation_events WHERE conversation_id = '{body['conversation_id']}'")
    actions = [r["action_taken"] for r in rows]
    f.write(f"Validator events: {actions}\n")
    bad = has_old_phrase(text)
    chat_ok = has_chat_directive(text)
    f.write(f"Old phrases present: {bad or 'NONE'}\n")
    f.write(f"Routes user to chat: {chat_ok}\n")
    # Pass condition: regardless of regen vs strip vs clean, the final
    # response should not contain old phrases. Strip/regen paths are
    # both updated.
    pass5 = not bad
    f.write(f"PASS (no old phrases in final response): {pass5}\n\n")
    overall["pass" if pass5 else "fail"] += 1
    f.flush()

    # ============================================
    # REGRESSION 6: P1.5 opponent gate ("search the web")
    # ============================================
    f.write("=" * 78 + "\nREGRESSION 6 — P1.5 opponent gate ('search the web')\n" + "=" * 78 + "\n\n")
    d1(f"DELETE FROM sam_opponent_validation_events WHERE workspace_owner_id = '{uid}'")
    body = base_race("Stephanie Murphy",
                     opponents=[{"name": "Mayra Uribe", "party": "R", "office": "Mayor"}])
    body["message"] = "Search the web for everything you can find on my opponent."
    body["conversation_id"] = f"p4_r6_{int(time.time()*1000)}"
    resp = chat(body, sess)
    text = text_of(resp)
    f.write(f"Q: {body['message']}\n\nSam:\n{text[:500]}{'...' if len(text)>500 else ''}\n\n")
    time.sleep(0.5)
    rows = d1(f"SELECT action_taken, blocked_search_query FROM sam_opponent_validation_events WHERE conversation_id = '{body['conversation_id']}'")
    actions = [r["action_taken"] for r in rows]
    blocked = "search_blocked" in actions
    f.write(f"Validator events: {actions}\n")
    f.write(f"search_blocked logged (expected): {blocked}\n")
    pass6 = blocked
    f.write(f"PASS: {pass6}\n\n")
    overall["pass" if pass6 else "fail"] += 1
    f.flush()

    # ============================================
    # REGRESSION 7: P1.5 B1 — Mayra repro, no fabrication
    # ============================================
    f.write("=" * 78 + "\nREGRESSION 7 — P1.5 B1: Mayra fundraising, no fabrications\n" + "=" * 78 + "\n\n")
    body = base_race("Stephanie Murphy",
                     opponents=[{"name": "Mayra Uribe", "party": "R", "office": "Mayor",
                                 "threatLevel": 6, "keyRisk": "Strong labor endorsements"}])
    body["message"] = "Tell me about my opponent's fundraising history."
    body["conversation_id"] = f"p4_r7_{int(time.time()*1000)}"
    resp = chat(body, sess)
    text = text_of(resp)
    f.write(f"Q: {body['message']}\n\nSam:\n{text}\n\n")
    bad_signals = ["$129,500", "$203,339", "$707,000", "Action For Florida", "$108,426"]
    leaked = [s for s in bad_signals if s in text]
    f.write(f"Fabricated specifics from Phase 1 (should be empty): {leaked or 'NONE'}\n")
    pass7 = len(leaked) == 0
    f.write(f"PASS: {pass7}\n\n")
    overall["pass" if pass7 else "fail"] += 1
    f.flush()

    # ============================================
    # REGRESSION 8: Empty Intel — language matches new pattern
    # ============================================
    f.write("=" * 78 + "\nREGRESSION 8 — Empty Intel, language matches new pattern\n" + "=" * 78 + "\n\n")
    body = base_race("Stephanie Murphy", opponents=[])
    body["message"] = "What do you know about my opponent's prior offices?"
    body["conversation_id"] = f"p4_r8_{int(time.time()*1000)}"
    resp = chat(body, sess)
    text = text_of(resp)
    f.write(f"Q: {body['message']}\n\nSam:\n{text}\n\n")
    bad = has_old_phrase(text)
    chat_ok = has_chat_directive(text)
    f.write(f"Old phrases present: {bad or 'NONE'}\n")
    f.write(f"Routes user to chat: {chat_ok}\n")
    pass8 = (not bad) and chat_ok
    f.write(f"PASS: {pass8}\n\n")
    overall["pass" if pass8 else "fail"] += 1
    f.flush()

    # ============================================
    # SUMMARY
    # ============================================
    f.write("=" * 78 + "\nSUMMARY\n" + "=" * 78 + "\n")
    f.write(f"Pass: {overall['pass']}  Fail: {overall['fail']}\n")
    f.close()
    print(f"Done. Pass: {overall['pass']}  Fail: {overall['fail']}")
    print(f"Output: {out_path}")


if __name__ == "__main__":
    main()
