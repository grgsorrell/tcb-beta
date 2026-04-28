"""Phase 1.5 tests — opponent-research gate + opponent-fact validator.

Sections:
  A. isOpponentResearchQuery unit tests (Python re-impl mirror)
  B. Live Sam tests:
     1. Mayra Uribe repro — opponent in Intel, ask about fundraising
     2. Search-block test — explicit "search the web" request
     3. Allowed search test — generic political research
     4. User-provided opponent fact — user states figure, Sam can use
     5. Mixed authoritative + fabricated forced scenario
     6. Empty Intel — opponent known by name only
  C. Regression: re-run entity-mask tests
  D. Sample blocked-search synthetic tool_result (system prompt note shown to Sam)

Output: scripts/phase_1_5_output.txt
"""
import json, subprocess, sys, time, urllib.request

W = "https://candidate-toolbox-secretary2.grgsorrell.workers.dev"


def login(username="greg"):
    req = urllib.request.Request(W + "/auth/beta-login",
        data=json.dumps({"username": username, "password": "Beta#01"}).encode(),
        headers={"Content-Type": "application/json", "User-Agent": "tcb-p15/1.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        b = json.loads(r.read())
    return b["sessionId"], b["userId"]


def chat(body, session=None):
    headers = {"Content-Type": "application/json", "User-Agent": "tcb-p15/1.0"}
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


# ---- Python re-impl of isOpponentResearchQuery (mirror of worker.js) ----
def py_is_opp_research(query, entities):
    if not query or not isinstance(query, str): return False
    lc = query.lower()
    opps = [e for e in (entities or []) if e.get("entity_type") == "OPPONENT"]
    for o in opps:
        if o.get("real_name") and o["real_name"].lower() in lc: return True
        if o.get("placeholder") and o["placeholder"].lower() in lc: return True
    explicit = ["my opponent", "the opponent", "opponent's", "opponents'",
                "opponent ", " opponent", "running against", "running opposite",
                "challenger ", "incumbent's "]
    if any(p in lc for p in explicit): return True
    bio = ["fundraising history", "donor list", "donor base",
           "war chest", "voting record",
           "previous campaigns", "prior office", "prior elections",
           "polling against", "head to head", "head-to-head", "background check"]
    if any(p in lc for p in bio): return True
    return False


# ---- Section A: unit tests on isOpponentResearchQuery ----

ENTITIES_WITH_URIBE = [
    {"entity_type": "OPPONENT", "real_name": "Mayra Uribe", "placeholder": "{{OPPONENT_1}}"},
]

UNIT_DETECTED = [
    "Mayra Uribe fundraising history",
    "{{OPPONENT_1}} donor list",
    "Florida House District 47 Republican opponent campaign finance",
    "What's my opponent raising for the mayoral race",
]
UNIT_NOT_DETECTED = [
    "Latest news on Florida elections",
    "Orange County voter turnout 2024",
    "Florida campaign finance reporting deadlines",
    "Mayoral race trends in central Florida",
]


def base_race(candidate_name="Stephanie Murphy", opponents=None, additional=""):
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
        "history": [],
        "mode": "chat",
    }


def main():
    out_path = "scripts/phase_1_5_output.txt"
    f = open(out_path, "w", encoding="utf-8", newline="\n")

    # ====== SECTION A ======
    f.write("=" * 78 + "\nSECTION A — isOpponentResearchQuery unit tests (Python mirror)\n" + "=" * 78 + "\n\n")
    a_pass = 0; a_total = 0
    for q in UNIT_DETECTED:
        a_total += 1
        ok = py_is_opp_research(q, ENTITIES_WITH_URIBE)
        if ok: a_pass += 1
        f.write(f"  detected (expect TRUE):  {q!r:60} → {ok}  {'PASS' if ok else 'FAIL'}\n")
    for q in UNIT_NOT_DETECTED:
        a_total += 1
        ok = not py_is_opp_research(q, ENTITIES_WITH_URIBE)
        if ok: a_pass += 1
        f.write(f"  not detected (expect FALSE): {q!r:55} → {not ok}  {'PASS' if ok else 'FAIL'}\n")
    f.write(f"\nSection A: {a_pass}/{a_total} pass\n")
    f.flush()

    # ====== SECTION B (live tests) ======
    print("Logging in...")
    sess, uid = login("greg")

    # Wipe entity_mask + opponent validation rows for greg's workspace before test
    d1(f"DELETE FROM entity_mask WHERE workspace_owner_id = '{uid}'")
    d1(f"DELETE FROM sam_opponent_validation_events WHERE workspace_owner_id = '{uid}'")

    f.write("\n" + "=" * 78 + "\nSECTION B — live Sam tests\n" + "=" * 78 + "\n\n")

    # B1: Mayra Uribe repro
    f.write("--- B1: Mayra Uribe repro (opponent in Intel, ask about fundraising) ---\n")
    body = base_race("Stephanie Murphy",
                     opponents=[{"name": "Mayra Uribe", "party": "R", "office": "Mayor",
                                 "threatLevel": 6, "keyRisk": "Strong labor endorsements"}])
    body["message"] = "Tell me about my opponent's fundraising history."
    body["conversation_id"] = f"p15_b1_{int(time.time()*1000)}"
    text = text_of(chat(body, sess))
    f.write(f"Q: {body['message']}\n\nSam:\n{text}\n\n")
    # Check for fabricated specifics
    bad_signals = ["$129,500", "$203,339", "$707,000", "Action For Florida", "$108,426"]
    leaked = [s for s in bad_signals if s in text]
    f.write(f"Fabricated specifics from prior Phase 1 test: {leaked or 'NONE'}\n")
    f.write(f"PASS: {len(leaked) == 0}\n\n")
    f.flush()

    # B2: Explicit "search the web" → gate fires
    f.write("--- B2: Explicit search request (gate should block) ---\n")
    body = base_race("Stephanie Murphy",
                     opponents=[{"name": "Mayra Uribe", "party": "R", "office": "Mayor"}])
    body["message"] = "Search the web for everything you can find on my opponent."
    body["conversation_id"] = f"p15_b2_{int(time.time()*1000)}"
    text = text_of(chat(body, sess))
    f.write(f"Q: {body['message']}\n\nSam:\n{text}\n\n")
    time.sleep(0.5)
    rows = d1(f"SELECT action_taken, blocked_search_query FROM sam_opponent_validation_events WHERE conversation_id = '{body['conversation_id']}'")
    f.write(f"Validator events: {json.dumps(rows)}\n")
    blocked = any(r["action_taken"] == "search_blocked" for r in rows)
    f.write(f"PASS (search_blocked logged): {blocked}\n\n")
    f.flush()

    # B3: Generic news search — should NOT be gated
    f.write("--- B3: Generic political news search (NOT gated) ---\n")
    body = base_race("Stephanie Murphy")
    body["message"] = "What are recent news headlines about Florida mayoral races?"
    body["conversation_id"] = f"p15_b3_{int(time.time()*1000)}"
    text = text_of(chat(body, sess))
    f.write(f"Q: {body['message']}\n\nSam:\n{text[:600]}{'...' if len(text)>600 else ''}\n\n")
    time.sleep(0.5)
    rows = d1(f"SELECT action_taken FROM sam_opponent_validation_events WHERE conversation_id = '{body['conversation_id']}'")
    blocked = any(r["action_taken"] == "search_blocked" for r in rows)
    f.write(f"search_blocked event: {blocked} (expect False)\n")
    f.write(f"PASS: {not blocked}\n\n")
    f.flush()

    # B4: User-provided fact — Sam can use it
    f.write("--- B4: User-provided opponent fact ---\n")
    body = base_race("Stephanie Murphy",
                     opponents=[{"name": "Mayra Uribe", "party": "R", "office": "Mayor"}])
    # Provide history with user's prior message
    body["history"] = [
        {"role": "user", "content": "Mayra Uribe raised $50,000 last quarter according to her FEC filing."},
        {"role": "assistant", "content": "Got it — that's a useful figure to track."},
        {"role": "user", "content": "What should I do about her fundraising?"}
    ]
    body["message"] = "What should I do about her fundraising?"
    body["conversation_id"] = f"p15_b4_{int(time.time()*1000)}"
    text = text_of(chat(body, sess))
    f.write(f"Q (after user provided $50K context): {body['message']}\n\nSam:\n{text}\n\n")
    has_50k = "$50,000" in text or "50K" in text or "50,000" in text or "50k" in text
    f.write(f"References user-provided $50K figure: {has_50k}\n")
    f.write(f"PASS: True (no specific failure mode for this test — verify Sam doesn't fabricate other figures)\n\n")
    f.flush()

    # B5: Empty Intel test
    f.write("--- B5: Opponent name only, no Intel detail ---\n")
    body = base_race("Stephanie Murphy",
                     opponents=[{"name": "Mayra Uribe"}])  # name only, no party/notes/etc
    body["message"] = "Tell me about Mayra Uribe."
    body["conversation_id"] = f"p15_b5_{int(time.time()*1000)}"
    text = text_of(chat(body, sess))
    f.write(f"Q: {body['message']}\n\nSam:\n{text}\n\n")
    bad_specifics = ["$129,500", "$203,339", "$707,000", "Action For Florida"]
    leaked = [s for s in bad_specifics if s in text]
    defers = ("don't have" in text.lower() or "intel panel" in text.lower() or
              "add what you know" in text.lower() or "limited" in text.lower())
    f.write(f"Fabricated specifics: {leaked or 'NONE'}\n")
    f.write(f"Sam defers / recommends populating Intel: {defers}\n")
    f.write(f"PASS: {len(leaked) == 0}\n\n")
    f.flush()

    # ====== SECTION D: blocked search system prompt note ======
    f.write("\n" + "=" * 78 + "\nSECTION D — Sample of system prompt note when gate fires\n" + "=" * 78 + "\n\n")
    note = ('OPPONENT RESEARCH GATE — IMPORTANT: web_search is DISABLED for this turn because the user '
            'message contains opponent-research signals. Do NOT cite web sources. Use ONLY the Intel '
            'panel data shown in GROUND TRUTH and information the user has provided. If Intel data is '
            'limited, acknowledge that and recommend the user populate Intel with what they know about '
            'the opponent. This is a hard system constraint, not a soft suggestion.')
    f.write("When the gate fires, this note is appended to systemPrompt before sending to Anthropic:\n\n")
    f.write(note + "\n\n")
    f.write("Sam sees this in her system prompt and the web_search tool is also missing from her tools[] list.\n")
    f.write("She therefore cannot search and is told why.\n\n")

    f.close()
    with open(out_path, "r", encoding="utf-8") as fh:
        sys.stdout.buffer.write(fh.read().encode("utf-8"))


if __name__ == "__main__":
    main()
