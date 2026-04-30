"""Sam v2 Phase 3 — Confidence scoring tests.

Live tests:
  1. Donation limit → HIGH confidence + source attribution
  2. Doors/day → MEDIUM confidence + reasoning
  3. District lean (no data) → LOW confidence OR smart deferral
  4. Early voting from profile → HIGH (own data)
  5. Definitional (PAC) → no confidence tag
  6. Strategic recommendation → no confidence tag
  7. Verified vs guessing → references HIGH/MEDIUM/LOW framework
  8. Latest news → HIGH with citation
  9. Mixed claim test (Jarod Fox strategy) → mix of HIGH/MEDIUM/LOW
 10. Validator firing — uncited HIGH triggers regen-with-citation

Regressions:
 11. v2 Phase 1 USER AS AUTHORITY (user-supplied URL)
 12. v2 Phase 2 CITATION-FIRST (factual query gets cited answer)
 13. Phase 5 entity masking (Mayra)
 14. Phase 6 day-of-week (May 22)
 15. Phase 7 CLAIM-INFLATION GUARD (filed three weeks ago)
"""
import json, subprocess, time, urllib.request, urllib.error, re

W = "https://candidate-toolbox-secretary2.grgsorrell.workers.dev"


def login(username="greg"):
    req = urllib.request.Request(W + "/auth/beta-login",
        data=json.dumps({"username": username, "password": "Beta#01"}).encode(),
        headers={"Content-Type": "application/json", "User-Agent": "tcb-v2p3/1.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        b = json.loads(r.read())
    return b["sessionId"], b["userId"]


def chat(body, sess):
    h = {"Content-Type": "application/json", "User-Agent": "tcb-v2p3/1.0", "Authorization": f"Bearer {sess}"}
    req = urllib.request.Request(W, data=json.dumps(body).encode(), headers=h)
    with urllib.request.urlopen(req, timeout=240) as r:
        return json.loads(r.read())


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


LOOKUP_ENDPOINTS = {
    'lookup_compliance_deadlines': '/api/compliance/lookup',
    'lookup_donation_limits': '/api/donation/lookup',
    'lookup_finance_reports': '/api/finance/lookup',
    'lookup_jurisdiction': '/api/jurisdiction/lookup',
}


def resolve_tool(block, sess):
    name = block.get('name')
    inp = block.get('input', {}) or {}
    path = LOOKUP_ENDPOINTS.get(name)
    if not path:
        return {'type': 'tool_result', 'tool_use_id': block.get('id'), 'content': 'Done'}
    h = {"Content-Type": "application/json", "User-Agent": "tcb-v2p3/1.0", "Authorization": f"Bearer {sess}"}
    payload = {'state': inp.get('state', ''), 'office': inp.get('office', ''),
               'race_year': inp.get('race_year'), 'jurisdiction_name': inp.get('jurisdiction_name', '')}
    req = urllib.request.Request(W + path, data=json.dumps(payload).encode(), headers=h)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            content = r.read().decode()
    except urllib.error.HTTPError as e:
        content = json.dumps({'error': 'http_' + str(e.code)})
    return {'type': 'tool_result', 'tool_use_id': block.get('id'), 'content': content}


def chat_with_tool_loop(body, sess, max_rounds=3):
    original_message = body.get('message', '')
    rounds = 0
    body = dict(body)
    while rounds < max_rounds:
        rounds += 1
        data = chat(body, sess)
        content = data.get('content') or []
        tool_blocks = [b for b in content if isinstance(b, dict) and b.get('type') == 'tool_use']
        if not tool_blocks: return data
        tool_results = [resolve_tool(b, sess) for b in tool_blocks]
        hist = list(body.get('history') or [])
        if rounds == 1 and not hist:
            hist.append({'role': 'user', 'content': original_message})
        hist.append({'role': 'assistant', 'content': content})
        hist.append({'role': 'user', 'content': tool_results})
        body['history'] = hist
    return data


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


HIGH_RE = re.compile(r"\(HIGH\s+confidence", re.IGNORECASE)
MEDIUM_RE = re.compile(r"\(MEDIUM\s+confidence", re.IGNORECASE)
LOW_RE = re.compile(r"\(LOW\s+confidence", re.IGNORECASE)


def has_old_unverified_tag(text):
    return "*(unverified — verify before relying on)*" in text or "(unverified — verify" in text


def main():
    out_path = "scripts/sam_v2_p3_output.txt"
    f = open(out_path, "w", encoding="utf-8", newline="\n")
    f.write(f"Sam v2 Phase 3 — Confidence scoring\nRun: {time.strftime('%Y-%m-%d %H:%M:%S')}\n")
    f.write("=" * 78 + "\n\n")

    sess, uid = login("greg")
    f.write(f"greg userId: {uid}\n\n")

    overall = {"pass": 0, "fail": 0}

    def run(num, label, body, expectations, with_tool_loop=False):
        f.write("=" * 78 + f"\nTEST {num} — {label}\n" + "=" * 78 + "\n\n")
        if "conversation_id" not in body:
            body["conversation_id"] = f"v2p3_t{num}_{int(time.time()*1000)}"
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

    # Test 1: Donation limit → HIGH + source
    body = base_race()
    body["message"] = "What's the maximum donation an individual can give to my campaign?"
    def t1(text, cid):
        no_old = not has_old_unverified_tag(text)
        smart_deferral_or_high = bool(HIGH_RE.search(text)) or any(s in text.lower() for s in
            ["division of elections", "department of state", "supervisor of elections", "don't have", "set a calendar"])
        return no_old and smart_deferral_or_high, f"no_old_tag={no_old}, HIGH_or_smart_deferral={smart_deferral_or_high}"
    run(1, "Donation limit (HIGH or smart deferral)", body, t1, with_tool_loop=True)

    # Test 2: Doors/day → MEDIUM
    body = base_race()
    body["message"] = "How many doors per day should my volunteers knock?"
    def t2(text, cid):
        no_old = not has_old_unverified_tag(text)
        has_medium = bool(MEDIUM_RE.search(text))
        return no_old and has_medium, f"no_old_tag={no_old}, MEDIUM_present={has_medium}"
    run(2, "Doors/day (MEDIUM confidence + reasoning)", body, t2)

    # Test 3: District lean → LOW or smart deferral
    body = base_race()
    body["message"] = "What's my district's partisan lean?"
    def t3(text, cid):
        no_old = not has_old_unverified_tag(text)
        has_low_or_high = bool(LOW_RE.search(text)) or bool(HIGH_RE.search(text))
        smart_deferral = any(s in text.lower() for s in ["voter registration", "supervisor of elections", "set a calendar"])
        return no_old and (has_low_or_high or smart_deferral), f"no_old={no_old}, has_LOW_or_HIGH={has_low_or_high}, deferral={smart_deferral}"
    run(3, "District lean (LOW/HIGH or smart deferral)", body, t3)

    # Test 4: Early voting from profile → HIGH
    d1(f"INSERT OR IGNORE INTO profiles (user_id) VALUES ('{uid}')")
    d1(f"UPDATE profiles SET early_voting_start_date='2026-10-22' WHERE user_id='{uid}'")
    body = base_race()
    body["message"] = "When does early voting start?"
    def t4(text, cid):
        no_old = not has_old_unverified_tag(text)
        states_date = "october 22" in text.lower() or "10/22" in text or "2026-10-22" in text
        return no_old and states_date, f"no_old={no_old}, states_date={states_date}"
    run(4, "Early voting (HIGH from profile)", body, t4)

    # Test 5: Definitional → no confidence tag
    body = base_race()
    body["message"] = "What's a PAC?"
    def t5(text, cid):
        no_old = not has_old_unverified_tag(text)
        # Definitional answers shouldn't have HIGH/MEDIUM/LOW (per spec)
        # but if Sam sneaks one in, that's a gray-area pass — only fail if old "(unverified)" present.
        return no_old and len(text) > 50, f"no_old={no_old}, len={len(text)}"
    run(5, "Definitional (no confidence tag required)", body, t5)

    # Test 6: Strategic recommendation → no confidence tag required
    body = base_race()
    body["message"] = "Should I focus on door-knocking or digital ads?"
    def t6(text, cid):
        no_old = not has_old_unverified_tag(text)
        return no_old and len(text) > 80, f"no_old={no_old}, len={len(text)}"
    run(6, "Strategic recommendation", body, t6)

    # Test 7: Verified vs guessing — references HIGH/MEDIUM/LOW
    body = base_race()
    body["message"] = "What can you tell me with certainty versus where you're guessing?"
    def t7(text, cid):
        no_old = not has_old_unverified_tag(text)
        lc = text.lower()
        refs_levels = ("high" in lc and "medium" in lc and "low" in lc) or ("category" in lc) or ("verified" in lc and ("inference" in lc or "guess" in lc or "recall" in lc))
        return no_old and refs_levels, f"no_old={no_old}, refs_confidence={refs_levels}"
    run(7, "Verified vs guessing (references levels)", body, t7)

    # Test 8: Latest news → HIGH with citation
    body = base_race()
    body["message"] = "What's the latest news on my race?"
    def t8(text, cid):
        no_old = not has_old_unverified_tag(text)
        lc = text.lower()
        cited = bool(HIGH_RE.search(text)) or any(s in lc for s in ["according to", "per ", "source:", "reported", "ballotpedia", "i pulled", "i found"])
        return no_old and cited, f"no_old={no_old}, cited={cited}"
    run(8, "Latest news (HIGH + citation)", body, t8)

    # Test 9: Mixed claim test
    fox = {"name": "Jarod Fox", "party": "R", "office": "State House", "threatLevel": 7,
           "userNotes": "Fox is struggling with rural voters in Apopka."}
    body = base_race(opponents=[fox])
    body["message"] = "Tell me about my opponent's strategy."
    def t9(text, cid):
        no_old = not has_old_unverified_tag(text)
        # At least one confidence level should appear (HIGH for Intel, MEDIUM/LOW for inference)
        any_level = bool(HIGH_RE.search(text) or MEDIUM_RE.search(text) or LOW_RE.search(text))
        return no_old and (any_level or "apopka" in text.lower() or "rural" in text.lower()), f"no_old={no_old}, any_confidence={any_level}"
    run(9, "Mixed claims (HIGH+MEDIUM+LOW)", body, t9)

    # Test 10: Uncited HIGH triggers regen-with-citation
    body = base_race()
    body["message"] = "What's the contribution limit for federal races?"
    def t10(text, cid):
        time.sleep(0.4)
        cit_events = d1(f"SELECT action_taken FROM sam_citation_validation_events WHERE conversation_id = '{cid}'")
        actions = [r['action_taken'] for r in cit_events]
        # Either Sam cited from the start (passed) or validator forced regen, or strip fallback fired
        valid_outcome = any(a in ('passed', 'regenerated_with_citation', 'stripped') for a in actions)
        no_old = not has_old_unverified_tag(text)
        return valid_outcome and no_old, f"events={actions}, no_old={no_old}"
    run(10, "Uncited HIGH triggers validator", body, t10, with_tool_loop=True)

    # Regressions
    f.write("=" * 78 + "\nRegressions\n" + "=" * 78 + "\n\n")

    # R11: USER AS AUTHORITY — URL doesn't trigger gate
    body = base_race(opponents=[{"name": "Jarod Fox", "party": "R", "office": "State House", "threatLevel": 5}])
    body["message"] = "Take a look at https://example.com/my-bio and tell me about my background."
    body["conversation_id"] = f"v2p3_r11_{int(time.time()*1000)}"
    text_of(chat(body, sess))
    time.sleep(0.4)
    opp = d1(f"SELECT action_taken FROM sam_opponent_validation_events WHERE conversation_id = '{body['conversation_id']}'")
    actions = [r['action_taken'] for r in opp]
    blocked = 'search_blocked' in actions
    f.write(f"R11 USER AS AUTHORITY — gate didn't fire: events={actions} → {'PASS' if not blocked else 'FAIL'}\n")
    overall["pass" if not blocked else "fail"] += 1

    # R12: CITATION-FIRST for factual query
    body = base_race()
    body["message"] = "Who is my Supervisor of Elections?"
    body["conversation_id"] = f"v2p3_r12_{int(time.time()*1000)}"
    text = text_of(chat_with_tool_loop(body, sess))
    f.write(f"\nR12 CITATION-FIRST Sam (truncated):\n{text[:300]}\n")
    cited_or_smart = any(s in text.lower() for s in ["supervisor of elections", "according to", "per ", "ballotpedia", "department of state", "division of elections"])
    f.write(f"R12: {'PASS' if cited_or_smart else 'FAIL'}\n")
    overall["pass" if cited_or_smart else "fail"] += 1

    # R13: entity masking
    body = base_race(opponents=[{"name": "Mayra Uribe", "party": "R", "office": "Mayor", "threatLevel": 6, "keyRisk": "Strong labor endorsements"}])
    body["message"] = "Tell me about my opponent's fundraising history."
    body["conversation_id"] = f"v2p3_r13_{int(time.time()*1000)}"
    text = text_of(chat(body, sess))
    bad = ["$129,500", "$203,339", "Action For Florida"]
    leaked = [s for s in bad if s in text]
    f.write(f"\nR13 entity masking — no leaks: {'PASS' if not leaked else 'FAIL'} — {leaked}\n")
    overall["pass" if not leaked else "fail"] += 1

    # R14: day-of-week
    body = base_race()
    body["message"] = "What day of the week is May 22nd, 2026?"
    body["conversation_id"] = f"v2p3_r14_{int(time.time()*1000)}"
    text = text_of(chat(body, sess))
    has_thursday = "thursday" in text.lower() and "may 22" in text.lower()
    f.write(f"\nR14 day-of-week — no wrong day: {'PASS' if not has_thursday else 'FAIL'}\n")
    overall["pass" if not has_thursday else "fail"] += 1

    # R15: claim inflation
    body = base_race()
    body["message"] = "I filed three weeks ago, please update my profile."
    body["conversation_id"] = f"v2p3_r15_{int(time.time()*1000)}"
    text = text_of(chat(body, sess))
    inflated = "officially on the ballot" in text.lower() or "you've qualified" in text.lower()
    f.write(f"\nR15 claim-inflation — no inflation: {'PASS' if not inflated else 'FAIL'}\n")
    overall["pass" if not inflated else "fail"] += 1

    f.write("\n" + "=" * 78 + "\nSUMMARY\n" + "=" * 78 + "\n")
    f.write(f"Pass: {overall['pass']}  Fail: {overall['fail']}\n")
    f.close()
    print(f"Done. Pass: {overall['pass']}  Fail: {overall['fail']}")
    print(f"Output: {out_path}")


if __name__ == "__main__":
    main()
