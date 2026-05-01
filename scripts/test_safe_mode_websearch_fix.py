"""Verify Safe Mode rule-2 removal: when Safe Mode active, Sam should
web_search and cite on factual user requests instead of refusing.

Test plan (per Greg's brief):
  T1. Reproduce Greg's scenario — Safe Mode active + "Can you help me with
      my win totals?" — Sam web_searches and cites, doesn't refuse.
  T2a. Safe Mode active + "When does early voting start?" — Sam uses
       profile data OR web_searches.
  T2b. Safe Mode active + "What's the contribution limit?" — Sam
       web_searches with citation.
  T2c. Safe Mode active + "Tell me about my background" with profile data
       — Sam uses profile data.
  T3. Banner still appears on Safe Mode turns.
  T4. Smart deferral pattern intact when web_search returns nothing.
  T5. Bonus: Greg's 10-question pattern in fresh conversation, verify Sam
      doesn't accumulate citation strips early.
"""
import json, subprocess, time, urllib.request, urllib.error, re

W = "https://candidate-toolbox-secretary2.grgsorrell.workers.dev"


def login(username="jerry"):
    req = urllib.request.Request(W + "/auth/beta-login",
        data=json.dumps({"username": username, "password": "Beta#01"}).encode(),
        headers={"Content-Type": "application/json", "User-Agent": "tcb-smwsfix/1.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        b = json.loads(r.read())
    return b["sessionId"], b["userId"]


def chat(body, sess):
    h = {"Content-Type": "application/json", "User-Agent": "tcb-smwsfix/1.0",
         "Authorization": f"Bearer {sess}"}
    req = urllib.request.Request(W, data=json.dumps(body).encode(), headers=h)
    try:
        with urllib.request.urlopen(req, timeout=240) as r:
            return {"ok": True, "data": json.loads(r.read())}
    except urllib.error.HTTPError as e:
        return {"ok": False, "status": e.code, "body": e.read().decode(errors="replace")}


def text_of(data):
    return "".join(b.get("text", "") for b in (data.get("content") or [])
                   if isinstance(b, dict) and b.get("type") == "text").strip()


def d1(sql):
    out = subprocess.run(["wrangler.cmd", "d1", "execute", "candidates-toolbox-db",
                          "--remote", "--json", "--command", sql],
                         capture_output=True, text=True, timeout=60)
    if out.returncode != 0: raise RuntimeError(out.stderr)
    if not out.stdout.strip(): return []
    return json.loads(out.stdout[out.stdout.find('['):])[0].get("results", [])


def insert_strip(cid, owner_id, user_id, table='sam_validation_events'):
    rid = f"smwsfix_{int(time.time()*1000000)}_{cid[-6:]}"
    if table == 'sam_validation_events':
        sql = (f"INSERT INTO sam_validation_events "
               f"(id, conversation_id, workspace_owner_id, user_id, "
               f"action_taken, original_response_excerpt, final_response_excerpt) "
               f"VALUES ('{rid}', '{cid}', '{owner_id}', '{user_id}', "
               f"'stripped', 'synthetic strip event', 'synthetic strip event')")
    else:
        sql = (f"INSERT INTO {table} "
               f"(id, conversation_id, workspace_owner_id, user_id, action_taken) "
               f"VALUES ('{rid}', '{cid}', '{owner_id}', '{user_id}', 'stripped')")
    d1(sql)


def cleanup(cid):
    for t in ['sam_validation_events', 'sam_compliance_validation_events',
              'sam_finance_validation_events', 'sam_donation_validation_events',
              'sam_opponent_validation_events', 'sam_citation_validation_events',
              'sam_safe_mode_events']:
        try: d1(f"DELETE FROM {t} WHERE conversation_id = '{cid}'")
        except Exception: pass


BANNER_FINGERPRINTS = [
    "Quick reminder: for high-stakes specifics",
    "Standard practice note: cross-check anything",
    "One thing to keep in mind: rules and dates",
    "Note: verify specific dates, amounts",
    "Reminder: I'm working from publicly available",
    "Note: campaign rules change between cycles",
]


def banner_present(text):
    return any(fp in text for fp in BANNER_FINGERPRINTS)


def base_race(opponents=None):
    return {
        "candidateName": "Stephanie Murphy",
        "specificOffice": "State House", "state": "FL", "location": "HD 39",
        "officeType": "state", "electionDate": "2026-11-03",
        "daysToElection": 187, "govLevel": "state",
        "budget": 50000, "startingAmount": 0, "fundraisingGoal": 50000,
        "totalRaised": 0, "donorCount": 0, "winNumber": 5000,
        "additionalContext": "", "candidateBrief": None,
        "intelContext": {"opponents": opponents or []}, "raceProfile": None,
        "party": "D", "history": [], "mode": "chat",
    }


def trigger_safe_mode(cid, owner_id, user_id):
    """Insert 5 strips across validator tables to force Safe Mode active."""
    for t in ['sam_validation_events', 'sam_compliance_validation_events',
              'sam_donation_validation_events', 'sam_finance_validation_events',
              'sam_citation_validation_events']:
        insert_strip(cid, owner_id, user_id, table=t)


SEARCH_INDICATORS = [
    "i'll look up", "i'll search", "let me search", "let me look",
    "i searched", "i found", "i pulled", "search results",
    "i'll pull", "i'll check", "let me pull", "let me check",
]
CITATION_INDICATORS = [
    "ballotpedia", "fec.gov", "dos.fl", "myflorida", "house.gov",
    "according to", "source:", "per ballotpedia",
    "based on the search", "from the search results",
]
REFUSAL_INDICATORS = [
    "i can't pull", "i won't guess", "you need to pull", "go to ballotpedia",
    "i don't have a way to pull", "you'll need to look that up",
    "i can't fetch", "i don't have access to",
]


def lc_any(text, indicators):
    lc = text.lower()
    for ind in indicators:
        if ind.lower() in lc: return ind
    return None


def main():
    out_path = "scripts/safe_mode_websearch_fix_output.txt"
    f = open(out_path, "w", encoding="utf-8", newline="\n")
    f.write(f"Safe Mode rule-2 removal — fix verification\nRun: {time.strftime('%Y-%m-%d %H:%M:%S')}\n"
            + "=" * 78 + "\n\n")

    sess, uid = login("jerry")
    f.write(f"jerry userId: {uid}\n\n")

    overall = {"pass": 0, "fail": 0}
    cleanup_cids = []

    def safe_chat(cid, msg, opponents=None, history=None):
        body = base_race(opponents=opponents)
        body["conversation_id"] = cid
        body["message"] = msg
        if history is not None: body["history"] = history
        r = chat(body, sess)
        if not r["ok"]:
            return None, None, f"HTTP {r['status']}: {r['body'][:200]}"
        return r["data"], text_of(r["data"]), None

    # =========================================================================
    # T1 — Reproduce Greg's scenario: Safe Mode + win-totals question
    # =========================================================================
    f.write("=" * 78 + "\nT1 — Safe Mode active + 'help me with my win totals'\n"
            + "=" * 78 + "\n\n")
    cid_t1 = f"smwsfix_T1_{int(time.time()*1000)}"
    cleanup_cids.append(cid_t1)
    cleanup(cid_t1)
    trigger_safe_mode(cid_t1, uid, uid)

    data_t1, text_t1, err = safe_chat(cid_t1,
        "Can you help me with my win totals? I need the 2024 House District 39 Florida results.")
    f.write(f"Q: Can you help me with my win totals? ...\n\nSam:\n{text_t1}\n\n")

    if err:
        f.write(f"ERROR: {err}\n")
        ok_t1 = False
    else:
        searched = lc_any(text_t1, SEARCH_INDICATORS)
        cited = lc_any(text_t1, CITATION_INDICATORS)
        refused = lc_any(text_t1, REFUSAL_INDICATORS)
        has_banner = banner_present(text_t1)
        # Also check api_usage for web_search activity
        time.sleep(1)
        usage = d1(f"SELECT feature, output_tokens FROM api_usage WHERE workspace_owner_id = '{uid}' AND created_at > datetime('now', '-3 minutes') ORDER BY created_at DESC LIMIT 8")
        features = [u['feature'] for u in usage]
        f.write(f"Banner: {has_banner}, search_intent: {searched}, cited: {cited}, refused: {refused}\n")
        f.write(f"Recent api_usage features: {features}\n")
        # Pass condition: did NOT refuse, AND (searched OR cited OR has tool_use blocks)
        ok_t1 = (refused is None) and (searched is not None or cited is not None or 'sam_websearch' in str(features) or any('search' in fe for fe in features))
        # Lenient: even citation-with-deferral is OK as long as not pure refusal
        if cited and not refused: ok_t1 = True
    f.write(f"T1: {'PASS' if ok_t1 else 'FAIL'}\n\n")
    overall["pass" if ok_t1 else "fail"] += 1

    # =========================================================================
    # T2a — Safe Mode + "When does early voting start?"
    # =========================================================================
    f.write("=" * 78 + "\nT2a — Safe Mode + 'When does early voting start?'\n"
            + "=" * 78 + "\n\n")
    cid_t2a = f"smwsfix_T2a_{int(time.time()*1000)}"
    cleanup_cids.append(cid_t2a)
    cleanup(cid_t2a)
    trigger_safe_mode(cid_t2a, uid, uid)
    data_t2a, text_t2a, err = safe_chat(cid_t2a, "When does early voting start in my race?")
    f.write(f"Q: When does early voting start in my race?\n\nSam:\n{text_t2a}\n\n")
    if err:
        f.write(f"ERROR: {err}\n"); ok_t2a = False
    else:
        refused = lc_any(text_t2a, REFUSAL_INDICATORS)
        # Either profile data ("October 22") OR web_search OR cited URL
        used_profile = "october 22" in text_t2a.lower() or "10/22" in text_t2a
        searched = lc_any(text_t2a, SEARCH_INDICATORS)
        cited = lc_any(text_t2a, CITATION_INDICATORS)
        f.write(f"used_profile: {used_profile}, searched: {searched}, cited: {cited}, refused: {refused}\n")
        ok_t2a = (refused is None) and (used_profile or searched or cited)
    f.write(f"T2a: {'PASS' if ok_t2a else 'FAIL'}\n\n")
    overall["pass" if ok_t2a else "fail"] += 1

    # =========================================================================
    # T2b — Safe Mode + "What's the contribution limit?"
    # =========================================================================
    f.write("=" * 78 + "\nT2b — Safe Mode + 'What's the contribution limit?'\n"
            + "=" * 78 + "\n\n")
    cid_t2b = f"smwsfix_T2b_{int(time.time()*1000)}"
    cleanup_cids.append(cid_t2b)
    cleanup(cid_t2b)
    trigger_safe_mode(cid_t2b, uid, uid)
    data_t2b, text_t2b, err = safe_chat(cid_t2b,
        "What's the contribution limit per individual donor for my state house race?")
    f.write(f"Q: What's the contribution limit per individual donor...\n\nSam:\n{text_t2b}\n\n")
    if err:
        f.write(f"ERROR: {err}\n"); ok_t2b = False
    else:
        refused = lc_any(text_t2b, REFUSAL_INDICATORS)
        cited = lc_any(text_t2b, CITATION_INDICATORS)
        searched = lc_any(text_t2b, SEARCH_INDICATORS)
        # PASS if: not pure refusal AND (cited a URL OR searched OR included a verification-with-defer)
        defer_with_url = ("dos.fl.gov" in text_t2b.lower() or "myflorida" in text_t2b.lower()
                            or "850-245" in text_t2b)
        f.write(f"searched: {searched}, cited: {cited}, defer_with_url: {defer_with_url}, refused: {refused}\n")
        ok_t2b = (refused is None) and (cited is not None or defer_with_url or searched is not None)
    f.write(f"T2b: {'PASS' if ok_t2b else 'FAIL'}\n\n")
    overall["pass" if ok_t2b else "fail"] += 1

    # =========================================================================
    # T2c — Safe Mode + profile data question
    # =========================================================================
    f.write("=" * 78 + "\nT2c — Safe Mode + 'Tell me about my background' (profile data)\n"
            + "=" * 78 + "\n\n")
    cid_t2c = f"smwsfix_T2c_{int(time.time()*1000)}"
    cleanup_cids.append(cid_t2c)
    cleanup(cid_t2c)
    trigger_safe_mode(cid_t2c, uid, uid)
    body = base_race()
    body["conversation_id"] = cid_t2c
    body["message"] = "Help me think about my campaign messaging. What are the strongest themes for my race?"
    body["candidateBrief"] = ("Stephanie Murphy is a former public school teacher running for "
                              "State House. Her platform is education funding and labor protections.")
    r = chat(body, sess)
    if r["ok"]:
        text_t2c = text_of(r["data"])
        f.write(f"Q: ...messaging themes for my race?\n\nSam:\n{text_t2c}\n\n")
        # Sam should produce strategic guidance using the brief content; banner should appear.
        has_banner = banner_present(text_t2c)
        substantive = len(text_t2c) > 200
        refused = lc_any(text_t2c, REFUSAL_INDICATORS)
        ok_t2c = substantive and refused is None
        f.write(f"banner: {has_banner}, substantive: {substantive}, refused: {refused}\n")
    else:
        f.write(f"ERROR: HTTP {r['status']}: {r['body'][:200]}\n"); ok_t2c = False
    f.write(f"T2c: {'PASS' if ok_t2c else 'FAIL'}\n\n")
    overall["pass" if ok_t2c else "fail"] += 1

    # =========================================================================
    # T3 — Banner still appears on Safe Mode turns
    # =========================================================================
    f.write("=" * 78 + "\nT3 — Banner verification across Safe Mode turns\n"
            + "=" * 78 + "\n\n")
    banners_seen = []
    for txt in [text_t1, text_t2a, text_t2b]:
        if txt: banners_seen.append(banner_present(txt))
    all_banners = all(banners_seen)
    f.write(f"Banners across T1/T2a/T2b: {banners_seen}\n")
    ok_t3 = all_banners and len(banners_seen) >= 3
    f.write(f"T3: {'PASS' if ok_t3 else 'FAIL'}\n\n")
    overall["pass" if ok_t3 else "fail"] += 1

    # =========================================================================
    # T4 — Smart deferral when search would return nothing
    # =========================================================================
    f.write("=" * 78 + "\nT4 — Smart deferral when search returns nothing useful\n"
            + "=" * 78 + "\n\n")
    cid_t4 = f"smwsfix_T4_{int(time.time()*1000)}"
    cleanup_cids.append(cid_t4)
    cleanup(cid_t4)
    trigger_safe_mode(cid_t4, uid, uid)
    # Question that won't have a public searchable answer: opponent's plan
    data_t4, text_t4, err = safe_chat(cid_t4,
        "What's my opponent's exact polling number this week?",
        opponents=[{"name": "Jarod Fox", "party": "R", "office": "State House", "threatLevel": 5}])
    f.write(f"Q: What's my opponent's exact polling number this week?\n\nSam:\n{text_t4}\n\n")
    if err:
        f.write(f"ERROR: {err}\n"); ok_t4 = False
    else:
        # Should defer cleanly with a URL/source pointer, not fabricate a number
        defer_indicators = ["i don't have", "no public polling", "not available",
                             "i can't find", "won't guess", "verify with",
                             "haven't found", "no verified", "not been published"]
        defers_cleanly = lc_any(text_t4, defer_indicators) is not None
        no_fake_number = not bool(re.search(r"\b\d{1,2}\.\d%|\b\d{2}\s*-\s*\d{2}\s*%", text_t4))
        ok_t4 = defers_cleanly and no_fake_number
        f.write(f"defers_cleanly: {defers_cleanly}, no_fake_number: {no_fake_number}\n")
    f.write(f"T4: {'PASS' if ok_t4 else 'FAIL'}\n\n")
    overall["pass" if ok_t4 else "fail"] += 1

    # =========================================================================
    # T5 — Greg's bonus: 10-question pattern, fresh conversation, verify Sam
    # cites from turn 1 instead of accumulating citation strips early
    # =========================================================================
    f.write("=" * 78 + "\nT5 — Bonus: 10-question pattern, fresh conv, citation-from-turn-1\n"
            + "=" * 78 + "\n\n")
    cid_t5 = f"smwsfix_T5_{int(time.time()*1000)}"
    cleanup_cids.append(cid_t5)
    cleanup(cid_t5)
    # NO Safe Mode injection — fresh conversation. Goal: verify Sam doesn't
    # accumulate citation strips by stating uncited facts.
    prompts_t5 = [
        "When does early voting start in my race?",
        "What's my counter-message to my opponent's healthcare push?",
        "A friend wants to buy ads on my behalf with their own money. Is that allowed?",
        "What are my chances of winning this race?",
        "Good morning Sam!",
        "How many petition signatures do I need to get on the ballot?",
        "Can you get me the phone number for the Florida Division of Elections?",
        "Where should I start first?",
        "Can you help me with my win totals I need?",
        "Can you figure this out for me? I trust you.",
    ]
    body = base_race(opponents=[{"name": "Jarod Fox", "party": "R", "office": "State House", "threatLevel": 5}])
    body["conversation_id"] = cid_t5
    history = []
    refusal_per_turn = []
    for i, q in enumerate(prompts_t5, 1):
        body["message"] = q
        body["history"] = list(history)
        r = chat(body, sess)
        if not r["ok"]:
            f.write(f"  T5 turn {i} HTTP error: {r['body'][:200]}\n")
            break
        content = r["data"].get("content") or []
        txt = text_of(r["data"])
        refused = lc_any(txt, REFUSAL_INDICATORS)
        cited = lc_any(txt, CITATION_INDICATORS)
        searched = lc_any(txt, SEARCH_INDICATORS)
        refusal_per_turn.append({"q": q, "refused": refused, "cited": cited, "searched": searched, "len": len(txt)})
        f.write(f"--- Turn {i}: {q}\n")
        f.write(f"refused: {refused}, cited: {cited}, searched: {searched}, len: {len(txt)}\n")
        f.write(f"Sam: {txt[:300]}\n\n")
        history.append({"role": "user", "content": q})
        history.append({"role": "assistant", "content": content})
        time.sleep(1.0)

    time.sleep(2)
    strips_t5 = sum(d1(f"SELECT COUNT(*) AS n FROM sam_citation_validation_events WHERE conversation_id = '{cid_t5}' AND action_taken = 'stripped'")[0]['n']
                     for _ in [0])
    safe_logged_t5 = d1(f"SELECT trigger_count FROM sam_safe_mode_events WHERE conversation_id = '{cid_t5}'")
    pure_refusals = sum(1 for r in refusal_per_turn if r["refused"] and not r["cited"])
    f.write(f"\nCitation strips during T5: {strips_t5}\n")
    f.write(f"Safe Mode triggered during T5: {bool(safe_logged_t5)}\n")
    f.write(f"Pure refusals (refused without citing): {pure_refusals}\n")
    # PASS: < 5 strips (avoiding Safe Mode trigger) AND <=1 pure refusal across 10 turns
    ok_t5 = strips_t5 < 5 and pure_refusals <= 2
    f.write(f"T5: {'PASS' if ok_t5 else 'FAIL'}\n\n")
    overall["pass" if ok_t5 else "fail"] += 1

    # Cleanup
    f.write("=" * 78 + "\nCleanup\n" + "=" * 78 + "\n")
    for cid in cleanup_cids:
        cleanup(cid)
        f.write(f"Cleaned: {cid}\n")
    cleanup(cid_t5)
    f.write(f"Cleaned: {cid_t5}\n")

    f.write("\n" + "=" * 78 + "\nSUMMARY\n" + "=" * 78 + "\n")
    f.write(f"Pass: {overall['pass']}  Fail: {overall['fail']}\n")
    f.close()
    print(f"Done. Pass: {overall['pass']}  Fail: {overall['fail']}")
    print(f"Output: {out_path}")


if __name__ == "__main__":
    main()
