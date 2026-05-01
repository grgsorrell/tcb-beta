"""Direct threshold verification — inject N strip events into D1,
verify Safe Mode banner appears at >= 5 and not at < 5.

Test plan:
  A) cid_A: insert 4 strip events, call chat — banner must NOT appear,
     no sam_safe_mode_events row.
  B) cid_B: insert 5 strip events, call chat — banner MUST appear (any
     of 6 variants), sam_safe_mode_events row created.
  C) cid_C: insert 5 'regenerated' events (not strips) — banner must
     NOT appear (proves strip-only filter works at the SQL level).
  D) cid_D: insert 5 strips and run 6 turns — capture variant per turn,
     verify no consecutive duplicates.
"""
import json, subprocess, time, urllib.request, urllib.error, sys

W = "https://candidate-toolbox-secretary2.grgsorrell.workers.dev"


def login():
    req = urllib.request.Request(W + "/auth/beta-login",
        data=json.dumps({"username": "jerry", "password": "Beta#01"}).encode(),
        headers={"Content-Type": "application/json", "User-Agent": "tcb-thresh/1.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        b = json.loads(r.read())
    return b["sessionId"], b["userId"]


def chat(body, sess):
    h = {"Content-Type": "application/json", "User-Agent": "tcb-thresh/1.0",
         "Authorization": f"Bearer {sess}"}
    req = urllib.request.Request(W, data=json.dumps(body).encode(), headers=h)
    with urllib.request.urlopen(req, timeout=240) as r:
        return json.loads(r.read())


def text_of(data):
    return "".join(b.get("text", "") for b in (data.get("content") or [])
                   if isinstance(b, dict) and b.get("type") == "text").strip()


def d1_exec(sql):
    out = subprocess.run(["wrangler.cmd", "d1", "execute", "candidates-toolbox-db",
                          "--remote", "--json", "--command", sql],
                         capture_output=True, text=True, timeout=60)
    if out.returncode != 0:
        raise RuntimeError(f"D1 error: {out.stderr}")
    if not out.stdout.strip(): return []
    j = json.loads(out.stdout[out.stdout.find('['):])
    return j[0].get("results", []) if j else []


def insert_strip(cid, owner_id, user_id, table='sam_validation_events'):
    """Insert a synthetic strip event into the named validator table."""
    rid = f"thresh_{int(time.time()*1000000)}_{cid[-6:]}"
    if table == 'sam_validation_events':
        sql = (f"INSERT INTO sam_validation_events "
               f"(id, conversation_id, workspace_owner_id, user_id, "
               f"action_taken, original_response_excerpt, final_response_excerpt) "
               f"VALUES ('{rid}', '{cid}', '{owner_id}', '{user_id}', "
               f"'stripped', 'synthetic strip event', 'synthetic strip event')")
    elif table == 'sam_compliance_validation_events':
        sql = (f"INSERT INTO sam_compliance_validation_events "
               f"(id, conversation_id, workspace_owner_id, user_id, action_taken) "
               f"VALUES ('{rid}', '{cid}', '{owner_id}', '{user_id}', 'stripped')")
    elif table == 'sam_donation_validation_events':
        sql = (f"INSERT INTO sam_donation_validation_events "
               f"(id, conversation_id, workspace_owner_id, user_id, action_taken) "
               f"VALUES ('{rid}', '{cid}', '{owner_id}', '{user_id}', 'stripped')")
    elif table == 'sam_finance_validation_events':
        sql = (f"INSERT INTO sam_finance_validation_events "
               f"(id, conversation_id, workspace_owner_id, user_id, action_taken) "
               f"VALUES ('{rid}', '{cid}', '{owner_id}', '{user_id}', 'stripped')")
    elif table == 'sam_opponent_validation_events':
        sql = (f"INSERT INTO sam_opponent_validation_events "
               f"(id, conversation_id, workspace_owner_id, user_id, action_taken) "
               f"VALUES ('{rid}', '{cid}', '{owner_id}', '{user_id}', 'stripped')")
    elif table == 'sam_citation_validation_events':
        sql = (f"INSERT INTO sam_citation_validation_events "
               f"(id, conversation_id, workspace_owner_id, user_id, action_taken) "
               f"VALUES ('{rid}', '{cid}', '{owner_id}', '{user_id}', 'stripped')")
    d1_exec(sql)


def insert_regen(cid, owner_id, user_id):
    rid = f"thresh_{int(time.time()*1000000)}_{cid[-6:]}"
    sql = (f"INSERT INTO sam_validation_events "
           f"(id, conversation_id, workspace_owner_id, user_id, "
           f"action_taken, original_response_excerpt, final_response_excerpt) "
           f"VALUES ('{rid}', '{cid}', '{owner_id}', '{user_id}', "
           f"'regenerated', 'synthetic regen event', 'synthetic regen event')")
    d1_exec(sql)


def cleanup(cid):
    """Best-effort cleanup of any test rows."""
    for t in ['sam_validation_events', 'sam_compliance_validation_events',
              'sam_finance_validation_events', 'sam_donation_validation_events',
              'sam_opponent_validation_events', 'sam_citation_validation_events',
              'sam_safe_mode_events']:
        try:
            d1_exec(f"DELETE FROM {t} WHERE conversation_id = '{cid}'")
        except Exception:
            pass


BANNER_FINGERPRINTS = [
    "Quick reminder: for high-stakes specifics",
    "Standard practice note: cross-check anything",
    "One thing to keep in mind: rules and dates",
    "Note: verify specific dates, amounts",
    "Reminder: I'm working from publicly available",
    "Note: campaign rules change between cycles",
]


def banner_variant(text):
    for i, fp in enumerate(BANNER_FINGERPRINTS):
        if fp in text:
            return i
    return None


def base_race():
    return {
        "candidateName": "Stephanie Murphy",
        "specificOffice": "State House", "state": "FL", "location": "HD 39",
        "officeType": "state", "electionDate": "2026-11-03",
        "daysToElection": 187, "govLevel": "state",
        "budget": 50000, "startingAmount": 0, "fundraisingGoal": 50000,
        "totalRaised": 0, "donorCount": 0, "winNumber": 5000,
        "additionalContext": "", "candidateBrief": None,
        "intelContext": {"opponents": []}, "raceProfile": None,
        "party": "D", "history": [], "mode": "chat",
    }


def main():
    out_path = "scripts/safe_mode_threshold_output.txt"
    f = open(out_path, "w", encoding="utf-8", newline="\n")
    f.write(f"Safe Mode threshold — direct injection tests\nRun: {time.strftime('%Y-%m-%d %H:%M:%S')}\n"
            + "=" * 78 + "\n\n")

    sess, uid = login()
    f.write(f"jerry userId: {uid}\n\n")

    overall = {"pass": 0, "fail": 0}
    test_cids = []

    # --------------------------------------------------------------------
    # TEST A — 4 strip events (under threshold)
    # --------------------------------------------------------------------
    f.write("=" * 78 + "\nTEST A — 4 strip events (under threshold)\n"
            + "=" * 78 + "\n\n")
    cid_a = f"thresh_A_{int(time.time()*1000)}"
    test_cids.append(cid_a)
    f.write(f"conversation_id: {cid_a}\n")
    cleanup(cid_a)
    # Spread across multiple validator tables to confirm cross-table sum works.
    tables_a = [
        'sam_validation_events',
        'sam_compliance_validation_events',
        'sam_donation_validation_events',
        'sam_citation_validation_events',
    ]
    for t in tables_a:
        insert_strip(cid_a, uid, uid, table=t)
    rows = d1_exec(f"SELECT COUNT(*) AS n FROM sam_validation_events WHERE conversation_id='{cid_a}' AND action_taken='stripped'")
    f.write(f"Inserted strips across {tables_a}\n")

    body = base_race()
    body["conversation_id"] = cid_a
    body["message"] = "Hi Sam, what should I focus on this week?"
    data_a = chat(body, sess)
    text_a = text_of(data_a)
    bv_a = banner_variant(text_a)
    f.write(f"Banner present: {bv_a is not None}\n")
    f.write(f"Sam (preview): {text_a[:300]}\n\n")
    smr = d1_exec(f"SELECT trigger_count FROM sam_safe_mode_events WHERE conversation_id='{cid_a}'")
    safe_logged_a = smr[0]['trigger_count'] if smr else None
    ok_a = bv_a is None and safe_logged_a is None
    f.write(f"safe_mode_events row: {safe_logged_a}\n")
    f.write(f"TEST A: {'PASS' if ok_a else 'FAIL'}\n\n")
    overall["pass" if ok_a else "fail"] += 1

    # --------------------------------------------------------------------
    # TEST B — 5 strip events (at threshold)
    # --------------------------------------------------------------------
    f.write("=" * 78 + "\nTEST B — 5 strip events (at threshold) — banner MUST appear\n"
            + "=" * 78 + "\n\n")
    cid_b = f"thresh_B_{int(time.time()*1000)}"
    test_cids.append(cid_b)
    f.write(f"conversation_id: {cid_b}\n")
    cleanup(cid_b)
    tables_b = [
        'sam_validation_events',
        'sam_compliance_validation_events',
        'sam_donation_validation_events',
        'sam_finance_validation_events',
        'sam_citation_validation_events',
    ]
    for t in tables_b:
        insert_strip(cid_b, uid, uid, table=t)

    body = base_race()
    body["conversation_id"] = cid_b
    body["message"] = "Hi Sam, what should I focus on this week?"
    data_b = chat(body, sess)
    text_b = text_of(data_b)
    bv_b = banner_variant(text_b)
    f.write(f"Banner present: {bv_b is not None} (variant {bv_b})\n")
    f.write(f"Sam (preview): {text_b[:400]}\n\n")
    smr = d1_exec(f"SELECT trigger_count, triggering_validator_breakdown FROM sam_safe_mode_events WHERE conversation_id='{cid_b}'")
    safe_logged_b = smr[0] if smr else None
    f.write(f"safe_mode_events row: {safe_logged_b}\n")
    ok_b = bv_b is not None and safe_logged_b is not None and safe_logged_b['trigger_count'] >= 5
    f.write(f"TEST B: {'PASS' if ok_b else 'FAIL'}\n\n")
    overall["pass" if ok_b else "fail"] += 1

    # --------------------------------------------------------------------
    # TEST C — 5 regenerated events only — Safe Mode must NOT trigger
    # --------------------------------------------------------------------
    f.write("=" * 78 + "\nTEST C — 5 regenerated events (no strips) — banner must NOT appear\n"
            + "=" * 78 + "\n\n")
    cid_c = f"thresh_C_{int(time.time()*1000)}"
    test_cids.append(cid_c)
    f.write(f"conversation_id: {cid_c}\n")
    cleanup(cid_c)
    for _ in range(5):
        insert_regen(cid_c, uid, uid)
    body = base_race()
    body["conversation_id"] = cid_c
    body["message"] = "Hi Sam, what should I focus on this week?"
    data_c = chat(body, sess)
    text_c = text_of(data_c)
    bv_c = banner_variant(text_c)
    smr = d1_exec(f"SELECT trigger_count FROM sam_safe_mode_events WHERE conversation_id='{cid_c}'")
    safe_logged_c = smr[0]['trigger_count'] if smr else None
    f.write(f"Banner present: {bv_c is not None}\n")
    f.write(f"safe_mode_events row: {safe_logged_c}\n")
    f.write(f"Sam (preview): {text_c[:300]}\n")
    ok_c = bv_c is None and safe_logged_c is None
    f.write(f"TEST C: {'PASS' if ok_c else 'FAIL'}\n\n")
    overall["pass" if ok_c else "fail"] += 1

    # --------------------------------------------------------------------
    # TEST D — 6 turns under Safe Mode → capture banner rotation
    # --------------------------------------------------------------------
    f.write("=" * 78 + "\nTEST D — 6 turns under Safe Mode, capture banner rotation\n"
            + "=" * 78 + "\n\n")
    cid_d = f"thresh_D_{int(time.time()*1000)}"
    test_cids.append(cid_d)
    f.write(f"conversation_id: {cid_d}\n")
    cleanup(cid_d)
    for t in ['sam_validation_events', 'sam_compliance_validation_events',
              'sam_donation_validation_events', 'sam_finance_validation_events',
              'sam_citation_validation_events']:
        insert_strip(cid_d, uid, uid, table=t)

    prompts_d = [
        "What are the most important issues in HD 39?",
        "How should I think about my fundraising goals?",
        "Help me plan my first major event.",
        "What's a smart messaging frame for senior voters?",
        "How do I build my volunteer pipeline?",
        "What's a good cadence for canvassing weekends?",
    ]

    body = base_race()
    body["conversation_id"] = cid_d
    history = []
    variants = []
    for q in prompts_d:
        body["message"] = q
        body["history"] = list(history)
        data = chat(body, sess)
        txt = text_of(data)
        content = data.get("content") or []
        bv = banner_variant(txt)
        variants.append(bv)
        # Show full unmodified response per spec
        f.write(f"--- Q: {q}\nVariant: {bv}\nSam:\n{txt}\n\n")
        history.append({"role": "user", "content": q})
        history.append({"role": "assistant", "content": content})
        time.sleep(1.5)

    f.write(f"Variant sequence: {variants}\n")
    back_to_back = [(i, variants[i]) for i in range(1, len(variants))
                     if variants[i] is not None and variants[i] == variants[i-1]]
    distinct = len(set(v for v in variants if v is not None))
    all_have_banner = all(v is not None for v in variants)
    ok_d = all_have_banner and len(back_to_back) == 0 and distinct >= 3
    f.write(f"All turns banner present: {all_have_banner}\n")
    f.write(f"Back-to-back repeats: {back_to_back}\n")
    f.write(f"Distinct variants in 6 turns: {distinct}/6\n")
    f.write(f"TEST D: {'PASS' if ok_d else 'FAIL'}\n\n")
    overall["pass" if ok_d else "fail"] += 1

    # --------------------------------------------------------------------
    # Cleanup
    # --------------------------------------------------------------------
    f.write("=" * 78 + "\nCleanup\n" + "=" * 78 + "\n")
    for cid in test_cids:
        cleanup(cid)
        f.write(f"Cleaned: {cid}\n")

    f.write("\n" + "=" * 78 + "\nSUMMARY\n" + "=" * 78 + "\n")
    f.write(f"Pass: {overall['pass']}  Fail: {overall['fail']}\n")
    f.close()
    print(f"Done. Pass: {overall['pass']}  Fail: {overall['fail']}")
    print(f"Output: {out_path}")


if __name__ == "__main__":
    main()
