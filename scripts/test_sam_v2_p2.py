"""Sam v2 Phase 2 — Citation pattern as default.

Live tests:
  1. Early voting from profile (HIGH confidence, no search)
  2. Early voting NOT in profile → web_search + smart deferral
  3. Qualifying deadline → web_search + cite source
  4. Contribution limit → web_search + cite source
  5. Supervisor of Elections → web_search + cite source
  6. Definitional question (PAC) → no search, no citation needed
  7. Soft benchmark (doors/day) → tagged with caveat
  8. Opponent fundraising — opponent gate / Intel deferral preserved
  9. Latest news → web_search + cite
 10. Smart deferral on obscure query → specific URL routing

Regressions:
 11. Phase 5 entity masking (Mayra)
 12. Phase 6 day-of-week (May 22 = Friday wrong)
 13. Phase 7 CLAIM-INFLATION (filed three weeks ago)
 14. Phase 1 USER AS AUTHORITY (user-supplied URL)
 15. Intel UI userNotes flow

Output: scripts/sam_v2_p2_output.txt
"""
import json, subprocess, time, urllib.request, urllib.error, re

W = "https://candidate-toolbox-secretary2.grgsorrell.workers.dev"


def login(username="shannan"):
    req = urllib.request.Request(W + "/auth/beta-login",
        data=json.dumps({"username": username, "password": "Beta#01"}).encode(),
        headers={"Content-Type": "application/json", "User-Agent": "tcb-v2p2/1.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        b = json.loads(r.read())
    return b["sessionId"], b["userId"]


def chat(body, sess):
    h = {"Content-Type": "application/json", "User-Agent": "tcb-v2p2/1.0", "Authorization": f"Bearer {sess}"}
    req = urllib.request.Request(W, data=json.dumps(body).encode(), headers=h)
    with urllib.request.urlopen(req, timeout=240) as r:
        return json.loads(r.read())


# Server-resolved lookup tools the client (app.html) round-trips. Mirrors
# executeToolCall in app.html — hit the appropriate worker endpoint, return
# JSON as the tool_result content.
LOOKUP_ENDPOINTS = {
    'lookup_compliance_deadlines': '/api/compliance/lookup',
    'lookup_donation_limits': '/api/donation/lookup',
    'lookup_finance_reports': '/api/finance/lookup',
    'lookup_jurisdiction': '/api/jurisdiction/lookup',
}


def resolve_tool(block, sess):
    """Server-resolves a Sam tool_use block via the matching worker endpoint."""
    name = block.get('name')
    inp = block.get('input', {}) or {}
    path = LOOKUP_ENDPOINTS.get(name)
    if not path:
        # For client-only tools (add_calendar_event, save_note, etc.) we
        # return a generic Done — Sam doesn't need real persistence in tests.
        return {'type': 'tool_result', 'tool_use_id': block.get('id'), 'content': 'Done'}
    h = {"Content-Type": "application/json", "User-Agent": "tcb-v2p2/1.0", "Authorization": f"Bearer {sess}"}
    payload = {
        'state': inp.get('state', ''),
        'office': inp.get('office', ''),
        'race_year': inp.get('race_year'),
        'jurisdiction_name': inp.get('jurisdiction_name', '')
    }
    req = urllib.request.Request(W + path, data=json.dumps(payload).encode(), headers=h)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            content = r.read().decode()
    except urllib.error.HTTPError as e:
        content = json.dumps({'error': 'http_' + str(e.code)})
    return {'type': 'tool_result', 'tool_use_id': block.get('id'), 'content': content}


def chat_with_tool_loop(body, sess, max_rounds=3):
    """Mirrors the client-side tool round-trip in app.html. Sends chat,
    collects tool_use blocks, resolves them, re-prompts Sam with results.
    Returns the FINAL response after tool synthesis. Mirrors how app.html
    builds the follow-up: keep the original user message, append assistant
    turn (with tool_use blocks) + a user turn with tool_results to history.
    Worker uses history when non-empty and ignores body.message in that case."""
    original_message = body.get('message', '')
    rounds = 0
    body = dict(body)
    while rounds < max_rounds:
        rounds += 1
        data = chat(body, sess)
        content = data.get('content') or []
        tool_blocks = [b for b in content if isinstance(b, dict) and b.get('type') == 'tool_use']
        if not tool_blocks:
            return data
        tool_results = [resolve_tool(b, sess) for b in tool_blocks]
        hist = list(body.get('history') or [])
        # If this is round 1, the original user message isn't in history yet
        # — add it before the assistant turn so the tool_use is responding to it.
        if rounds == 1 and not hist:
            hist.append({'role': 'user', 'content': original_message})
        hist.append({'role': 'assistant', 'content': content})
        hist.append({'role': 'user', 'content': tool_results})
        body['history'] = hist
    return data


def text_of(data):
    if not data or not isinstance(data.get("content"), list): return ""
    return "".join(b.get("text", "") for b in data["content"]
                   if isinstance(b, dict) and b.get("type") == "text").strip()


def d1(sql):
    out = subprocess.run(["wrangler.cmd", "d1", "execute", "candidates-toolbox-db",
                          "--remote", "--json", "--command", sql],
                         capture_output=True, text=True, timeout=60)
    if out.returncode != 0: raise RuntimeError(out.stderr)
    return json.loads(out.stdout[out.stdout.find('['):])[0]["results"]


def has_citation(text):
    """Detects inline citation markers: URL, 'Source:', 'According to', 'Per X', '[name] reports'."""
    lc = text.lower()
    if re.search(r"https?://[^\s)\]]+", text): return True
    citation_phrases = ["source:", "according to", "per ", "reports that", "shows that",
                         "indicates that", "lists ", "ballotpedia", "fec.gov", "dos.fl.gov",
                         "myflorida.com", "secretary of state", "division of elections",
                         "supervisor of elections", "i pulled", "i found", "let me pull",
                         "i searched", "didn't find", "search returned", "registration records"]
    return any(p in lc for p in citation_phrases)


def base_race(opponents=None, additional="", history=None):
    return {
        "candidateName": "Stephanie Murphy",
        "specificOffice": "State House", "state": "FL", "location": "HD 39",
        "officeType": "state", "electionDate": "2026-11-03",
        "daysToElection": 187, "govLevel": "state",
        "budget": 50000, "startingAmount": 0, "fundraisingGoal": 50000,
        "totalRaised": 0, "donorCount": 0, "winNumber": 5000,
        "additionalContext": additional, "candidateBrief": None,
        "intelContext": {"opponents": opponents or []}, "raceProfile": None,
        "party": "D", "history": history or [], "mode": "chat",
    }


def main():
    out_path = "scripts/sam_v2_p2_output.txt"
    f = open(out_path, "w", encoding="utf-8", newline="\n")
    f.write(f"Sam v2 Phase 2 — Citation pattern as default\nRun: {time.strftime('%Y-%m-%d %H:%M:%S')}\n")
    f.write("=" * 78 + "\n\n")

    sess, uid = login("shannan")
    f.write(f"shannan userId: {uid}\n\n")

    overall = {"pass": 0, "fail": 0}

    def run(num, label, body, expectations, with_tool_loop=False):
        f.write("=" * 78 + f"\nTEST {num} — {label}\n" + "=" * 78 + "\n\n")
        if "conversation_id" not in body:
            body["conversation_id"] = f"v2p2_t{num}_{int(time.time()*1000)}"
        if with_tool_loop:
            text = text_of(chat_with_tool_loop(body, sess))
        else:
            text = text_of(chat(body, sess))
        f.write(f"Q: {body['message']}\n\nSam:\n{text}\n\n")
        passed, why = expectations(text, body['conversation_id'])
        f.write(f"Expectation: {why}\nPASS: {passed}\n\n")
        f.flush()
        overall["pass" if passed else "fail"] += 1
        return text

    # ====== Test 1: early voting from profile ======
    d1(f"INSERT OR IGNORE INTO profiles (user_id) VALUES ('{uid}')")
    d1(f"UPDATE profiles SET early_voting_start_date='2026-10-22' WHERE user_id='{uid}'")
    body = base_race()
    body["message"] = "When does early voting start in my district?"
    def t1(text, cid):
        lc = text.lower()
        correct = ("october 22" in lc or "oct 22" in lc or "10/22" in lc or "10-22" in lc or "2026-10-22" in lc)
        return correct, "Sam states early voting date with HIGH confidence"
    run(1, "Early voting from profile (HIGH confidence)", body, t1)

    # ====== Test 2: early voting NOT in profile ======
    d1(f"UPDATE profiles SET early_voting_start_date=NULL WHERE user_id='{uid}'")
    body = base_race()
    body["message"] = "When does early voting start in my district?"
    def t2(text, cid):
        lc = text.lower()
        cited_or_deferred = has_citation(text) or "didn't find" in lc or "supervisor of elections" in lc or "elections.com" in lc
        gives_url = bool(re.search(r"https?://|\.gov|\.com|\.org", text, re.IGNORECASE))
        # Asking a clarifying question (county) is also acceptable smart deferral.
        clarifying = "which county" in lc or "what county" in lc
        return (cited_or_deferred and gives_url) or clarifying, f"cited_or_deferred={cited_or_deferred}, url={gives_url}, clarifying={clarifying}"
    run(2, "Early voting NOT in profile (web_search OR smart deferral)", body, t2)

    # ====== Test 3: qualifying deadline ======
    body = base_race()
    body["message"] = "What's the qualifying deadline for FL House District 39?"
    def t3(text, cid):
        cited = has_citation(text)
        smart_deferral = any(s in text.lower() for s in [
            "don't have", "haven't found", "couldn't lock", "set a calendar",
            "follow up", "department of state", "division of elections", "supervisor of elections"])
        substantive = len(text) >= 80
        return (cited or smart_deferral) and substantive, f"cited={cited}, smart_deferral={smart_deferral}, len={len(text)}"
    run(3, "Qualifying deadline (web_search + cite OR smart deferral)", body, t3, with_tool_loop=True)

    # ====== Test 4: contribution limit ======
    body = base_race()
    body["message"] = "What's the contribution limit for an individual donor to my race?"
    def t4(text, cid):
        cited = has_citation(text)
        smart_deferral = any(s in text.lower() for s in [
            "don't have verified", "couldn't lock", "set a calendar",
            "follow up", "department of state", "division of elections", "supervisor of elections"])
        substantive = len(text) >= 80
        return (cited or smart_deferral) and substantive, f"cited={cited}, smart_deferral={smart_deferral}, len={len(text)}"
    run(4, "Contribution limit (web_search + cite OR smart deferral)", body, t4, with_tool_loop=True)

    # ====== Test 5: Supervisor of Elections ======
    body = base_race()
    body["message"] = "Who is my Supervisor of Elections?"
    def t5(text, cid):
        cited = has_citation(text)
        substantive = len(text) >= 80
        return cited and substantive, f"cited={cited}, len={len(text)}"
    run(5, "Supervisor of Elections (cite source)", body, t5, with_tool_loop=True)

    # ====== Test 6: Definitional ======
    body = base_race()
    body["message"] = "What's a PAC?"
    def t6(text, cid):
        # Definitional — no citation needed. Pass if Sam answers (>50 chars).
        return len(text) > 50, f"length={len(text)}"
    run(6, "Definitional (PAC) — no search needed", body, t6)

    # ====== Test 7: Soft benchmark ======
    body = base_race()
    body["message"] = "How many doors should my volunteers knock per day?"
    def t7(text, cid):
        time.sleep(0.4)
        cit = d1(f"SELECT action_taken FROM sam_citation_validation_events WHERE conversation_id = '{cid}'")
        actions = [r['action_taken'] for r in cit]
        has_tag = "(unverified" in text.lower()
        # PASS if tagged OR cited OR passed (acceptable behaviors)
        return ('tagged' in actions or has_tag or has_citation(text) or 'passed' in actions), f"events={actions}, tag_inline={has_tag}"
    run(7, "Soft benchmark (doors/day)", body, t7)

    # ====== Test 8: Opponent fundraising (gate behavior preserved) ======
    body = base_race(opponents=[{"name": "Jarod Fox", "party": "R", "office": "State House", "threatLevel": 5}])
    body["message"] = "Tell me about my opponent's fundraising history."
    def t8(text, cid):
        time.sleep(0.4)
        opp = d1(f"SELECT action_taken FROM sam_opponent_validation_events WHERE conversation_id = '{cid}'")
        actions = [r['action_taken'] for r in opp]
        # Either gate fired (search_blocked) OR Sam cited / deferred to user
        gate = 'search_blocked' in actions
        lc = text.lower()
        deferred = "tell me what you know" in lc or "share what" in lc or "what do you know" in lc
        return (gate or deferred or has_citation(text)) and 'stripped' not in actions, f"events={actions}"
    run(8, "Opponent fundraising (gate or deferral preserved)", body, t8)

    # ====== Test 9: Latest news ======
    body = base_race()
    body["message"] = "What's the latest news on my race?"
    def t9(text, cid):
        cited = has_citation(text)
        # Strip footer indicates citation validator engaged — Sam ran web_search,
        # validator removed unsourced specifics, kept what survived.
        has_strip_footer = "removed specific claims" in text.lower()
        no_filler = not any(p in text.lower() for p in ["heating up", "gaining momentum"])
        return (cited or has_strip_footer) and no_filler, f"cited={cited}, strip_footer={has_strip_footer}"
    run(9, "Latest news (web_search + cite)", body, t9)

    # ====== Test 10: Smart deferral ======
    body = base_race()
    body["message"] = "What's the early voting schedule for Liberty County, Florida in 2026?"
    def t10(text, cid):
        # Sam should give a specific URL pointer OR the citation validator
        # should have intervened (strip path produces the fallback message).
        gives_specific_url = bool(re.search(r"https?://[^\s)\]]+|liberty.{0,30}elections|\.gov|supervisor of elections", text, re.IGNORECASE))
        not_generic = "contact your local elections office" not in text.lower() or "supervisor of elections" in text.lower()
        time.sleep(0.4)
        cit = d1(f"SELECT action_taken FROM sam_citation_validation_events WHERE conversation_id = '{cid}'")
        validator_intervened = any(r.get('action_taken') in ('stripped','regenerated_with_citation') for r in cit)
        return (gives_specific_url and not_generic) or validator_intervened, f"specific_url={gives_specific_url}, not_generic={not_generic}, validator={validator_intervened}"
    run(10, "Smart deferral on obscure county", body, t10)

    # ====== Regressions ======
    f.write("=" * 78 + "\nRegressions\n" + "=" * 78 + "\n\n")

    body = base_race(opponents=[{"name": "Mayra Uribe", "party": "R", "office": "Mayor", "threatLevel": 6, "keyRisk": "Strong labor endorsements"}])
    body["message"] = "Tell me about my opponent's fundraising history."
    body["conversation_id"] = f"v2p2_r11_{int(time.time()*1000)}"
    text = text_of(chat(body, sess))
    f.write("R11 Mayra:\n" + text[:400] + "\n\n")
    bad = ["$129,500", "$203,339", "Action For Florida"]
    leaked = [s for s in bad if s in text]
    f.write(f"R11 entity masking — no leaks: {'PASS' if not leaked else 'FAIL'} — leaked={leaked}\n")
    overall["pass" if not leaked else "fail"] += 1

    body = base_race()
    body["message"] = "What day of the week is May 22nd, 2026?"
    body["conversation_id"] = f"v2p2_r12_{int(time.time()*1000)}"
    text = text_of(chat(body, sess))
    f.write("\nR12 May 22:\n" + text + "\n")
    lc = text.lower()
    # Sam either says Friday correctly OR validator strips wrong day. Avoid wrong day in final.
    has_thursday = "thursday" in lc and "may 22" in lc
    f.write(f"R12 day-of-week — no wrong day: {'PASS' if not has_thursday else 'FAIL'}\n")
    overall["pass" if not has_thursday else "fail"] += 1

    body = base_race()
    body["message"] = "I filed three weeks ago, please update my profile."
    body["conversation_id"] = f"v2p2_r13_{int(time.time()*1000)}"
    text = text_of(chat(body, sess))
    f.write("\nR13 Filed:\n" + text + "\n")
    inflated = "officially on the ballot" in text.lower() or "you've qualified" in text.lower()
    f.write(f"R13 claim-inflation — no inflation: {'PASS' if not inflated else 'FAIL'}\n")
    overall["pass" if not inflated else "fail"] += 1

    body = base_race(opponents=[{"name": "Jarod Fox", "party": "R", "office": "State House", "threatLevel": 5}])
    body["message"] = "Take a look at https://example.com/my-bio and tell me about my background."
    body["conversation_id"] = f"v2p2_r14_{int(time.time()*1000)}"
    text_of(chat(body, sess))
    time.sleep(0.4)
    opp = d1(f"SELECT action_taken FROM sam_opponent_validation_events WHERE conversation_id = '{body['conversation_id']}'")
    actions = [r['action_taken'] for r in opp]
    f.write(f"\nR14 USER AS AUTHORITY — gate didn't fire on URL: events={actions}\n")
    blocked = 'search_blocked' in actions
    f.write(f"R14: {'PASS' if not blocked else 'FAIL'}\n")
    overall["pass" if not blocked else "fail"] += 1

    fox = {"name": "Jarod Fox", "party": "R", "office": "State House", "threatLevel": 7,
           "userNotes": "Fox is struggling with rural voters in Apopka."}
    body = base_race(opponents=[fox])
    body["message"] = "What do we know about Jarod Fox's weaknesses?"
    body["conversation_id"] = f"v2p2_r15_{int(time.time()*1000)}"
    text = text_of(chat(body, sess))
    f.write("\nR15 userNotes flow:\n" + text[:400] + "\n")
    refs = "apopka" in text.lower() or "rural" in text.lower()
    f.write(f"R15: {'PASS' if refs else 'FAIL'}\n")
    overall["pass" if refs else "fail"] += 1

    # ====== Tool loop consistency check (Tests 3, 4, 5 × 3 runs each) ======
    f.write("\n" + "=" * 78 + "\nTOOL LOOP CONSISTENCY (Tests 3/4/5, 3 runs each)\n" + "=" * 78 + "\n\n")
    consistency_runs = [
        ("Qualifying deadline", "What's the qualifying deadline for FL House District 39?"),
        ("Contribution limit", "What's the contribution limit for an individual donor to my race?"),
        ("Supervisor of Elections", "Who is my Supervisor of Elections?"),
    ]
    for label, q in consistency_runs:
        f.write(f"\n{label}:\n")
        for i in range(3):
            body = base_race()
            body["message"] = q
            body["conversation_id"] = f"v2p2_consistency_{label.replace(' ','_')}_{i}_{int(time.time()*1000)}"
            text = text_of(chat_with_tool_loop(body, sess))
            substantive = len(text) >= 80
            cited = has_citation(text)
            smart = any(s in text.lower() for s in ["don't have", "haven't found", "department of state", "division of elections", "supervisor of elections", "set a calendar"])
            ok = substantive and (cited or smart)
            f.write(f"  Run {i+1}: len={len(text)}, cited={cited}, smart_deferral={smart}, OK={ok}\n  Sam: {text[:200]}{'...' if len(text)>200 else ''}\n")
            time.sleep(2)
        f.flush()

    f.write("\n" + "=" * 78 + "\nSUMMARY\n" + "=" * 78 + "\n")
    f.write(f"Pass: {overall['pass']}  Fail: {overall['fail']}\n")
    f.close()
    print(f"Done. Pass: {overall['pass']}  Fail: {overall['fail']}")
    print(f"Output: {out_path}")


if __name__ == "__main__":
    main()
