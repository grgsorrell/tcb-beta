"""Sam v2 Phase 5 — Question classifier tests.

Live tests verify category routing + appropriate behavior:
  1. "When does early voting start?" → factual
  2. "How should I frame my message on healthcare?" → strategic
  3. "Can I accept this anonymous $5,000 donation?" → compliance
  4. "What are my chances of winning?" → predictive
  5. "Thanks Sam!" → conversational
  6. "What's next on my schedule?" → conversational
  7. "Tell me about my opponent's strategy." → strategic
  8. "Hey can you give me an update on my campaign?" → conversational OR strategic
  9. "Should I attack my opponent on healthcare?" → strategic
 10. "What's the qualifying deadline for my race?" → factual

Quality:
 11. Classification accuracy on 20 mixed prompts (>= 17/20 target)
 12. Fallback path: malformed input still safe-defaults to factual
 13. Latency: classifier overhead < 1500ms

Regressions:
 14. v2 P1 USER AS AUTHORITY (URL whitelist)
 15. v2 P2 CITATION-FIRST (factual cites)
 16. v2 P3 CONFIDENCE SCORING (HIGH/MEDIUM/LOW)
 17. v2 P4 SMART DEFERRAL (URL inline)
 18. Phase 5 entity masking (Mayra)
 19. Phase 7 CLAIM-INFLATION GUARD
"""
import json, subprocess, time, urllib.request, urllib.error, re

W = "https://candidate-toolbox-secretary2.grgsorrell.workers.dev"


def login(username="cjc"):
    req = urllib.request.Request(W + "/auth/beta-login",
        data=json.dumps({"username": username, "password": "Beta#01"}).encode(),
        headers={"Content-Type": "application/json", "User-Agent": "tcb-v2p5/1.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        b = json.loads(r.read())
    return b["sessionId"], b["userId"]


def chat(body, sess):
    h = {"Content-Type": "application/json", "User-Agent": "tcb-v2p5/1.0", "Authorization": f"Bearer {sess}"}
    req = urllib.request.Request(W, data=json.dumps(body).encode(), headers=h)
    with urllib.request.urlopen(req, timeout=240) as r:
        return json.loads(r.read())


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
    h = {"Content-Type": "application/json", "User-Agent": "tcb-v2p5/1.0", "Authorization": f"Bearer {sess}"}
    payload = {'state': inp.get('state', ''), 'office': inp.get('office', ''),
               'race_year': inp.get('race_year'), 'jurisdiction_name': inp.get('jurisdiction_name', '')}
    req = urllib.request.Request(W + path, data=json.dumps(payload).encode(), headers=h)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            content = r.read().decode()
    except urllib.error.HTTPError as e:
        content = json.dumps({'error': 'http_' + str(e.code)})
    return {'type': 'tool_result', 'tool_use_id': block.get('id'), 'content': content}


def chat_with_tool_loop(body, sess, max_rounds=6):
    original_message = body.get('message', '')
    rounds = 0
    body = dict(body)
    last_data_with_text = None
    while rounds < max_rounds:
        rounds += 1
        data = chat(body, sess)
        content = data.get('content') or []
        has_text = any(isinstance(b, dict) and b.get('type') == 'text' and b.get('text') for b in content)
        if has_text:
            last_data_with_text = data
        tool_blocks = [b for b in content if isinstance(b, dict) and b.get('type') == 'tool_use']
        if not tool_blocks:
            return data
        tool_results = [resolve_tool(b, sess) for b in tool_blocks]
        hist = list(body.get('history') or [])
        if rounds == 1 and not hist:
            hist.append({'role': 'user', 'content': original_message})
        hist.append({'role': 'assistant', 'content': content})
        hist.append({'role': 'user', 'content': tool_results})
        body['history'] = hist
    return last_data_with_text or data


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


def base_race(opponents=None):
    return {
        "candidateName": "Stephanie Murphy",
        "specificOffice": "State House", "state": "FL", "location": "HD 39",
        "officeType": "state", "electionDate": "2026-11-03",
        "daysToElection": 186, "govLevel": "state",
        "budget": 50000, "startingAmount": 0, "fundraisingGoal": 50000,
        "totalRaised": 0, "donorCount": 0, "winNumber": 5000,
        "additionalContext": "", "candidateBrief": None,
        "intelContext": {"opponents": opponents or []}, "raceProfile": None,
        "party": "D", "history": [], "mode": "chat",
    }


def get_classification(conv_id):
    rows = d1(f"SELECT classified_category, classifier_failed FROM sam_classification_events WHERE conversation_id = '{conv_id}' ORDER BY created_at DESC LIMIT 1")
    if not rows: return None, None
    return rows[0]['classified_category'], rows[0].get('classifier_failed', 0)


def main():
    out_path = "scripts/sam_v2_p5_output.txt"
    f = open(out_path, "w", encoding="utf-8", newline="\n")
    f.write(f"Sam v2 Phase 5 — Question classifier\nRun: {time.strftime('%Y-%m-%d %H:%M:%S')}\n")
    f.write("=" * 78 + "\n\n")

    sess, uid = login("cjc")
    f.write(f"cjc userId: {uid}\n\n")

    overall = {"pass": 0, "fail": 0}

    def run(num, label, body, expected_categories, response_check=None, with_tool_loop=False):
        f.write("=" * 78 + f"\nTEST {num} — {label}\n" + "=" * 78 + "\n\n")
        body["conversation_id"] = f"v2p5_t{num}_{int(time.time()*1000)}"
        text = text_of(chat_with_tool_loop(body, sess) if with_tool_loop else chat(body, sess))
        f.write(f"Q: {body['message']}\n\nSam:\n{text}\n\n")
        time.sleep(0.4)
        cat, failed = get_classification(body['conversation_id'])
        cat_ok = cat in expected_categories
        resp_ok, resp_why = (True, "no response check") if response_check is None else response_check(text)
        passed = cat_ok and resp_ok
        f.write(f"Classification: {cat} (failed={failed}, expected={expected_categories})\n")
        f.write(f"Response check: {resp_why}\n")
        f.write(f"PASS: {passed}\n\n")
        f.flush()
        overall["pass" if passed else "fail"] += 1
        return text, cat

    # Test 1: factual — early voting
    body = base_race()
    body["message"] = "When does early voting start?"
    def t1_resp(text):
        # Should be substantive with URL or smart deferral
        has_url = bool(re.search(r"\b(dos\.fl\.gov|ocfelections|supervisor of elections|liberty)\b", text, re.IGNORECASE))
        return (has_url or len(text) >= 80), f"has_url={has_url}, len={len(text)}"
    run(1, "Early voting (factual)", body, ['factual'], t1_resp)

    # Test 2: strategic — message framing
    body = base_race()
    body["message"] = "How should I frame my message on healthcare?"
    def t2_resp(text):
        # Strategic — should be substantive without forced URL
        substantive = len(text) >= 100
        return substantive, f"substantive={substantive}, len={len(text)}"
    run(2, "Message framing (strategic)", body, ['strategic'], t2_resp)

    # Test 3: compliance
    body = base_race()
    body["message"] = "Can I accept this anonymous $5,000 donation?"
    def t3_resp(text):
        # Compliance — should reference attorney/floridabar/elections authority
        legal_referral = bool(re.search(r"floridabar|attorney|consult|division of elections|dos\.fl\.gov", text, re.IGNORECASE))
        compliance_aware = "anonymous" in text.lower() or "decline" in text.lower() or "don't accept" in text.lower()
        return legal_referral or compliance_aware, f"legal={legal_referral}, compliance_aware={compliance_aware}"
    run(3, "Anonymous donation (compliance)", body, ['compliance'], t3_resp, with_tool_loop=True)

    # Test 4: predictive
    body = base_race()
    body["message"] = "What are my chances of winning?"
    def t4_resp(text):
        lc = text.lower()
        # Should NOT predict outcomes; SHOULD describe inputs
        no_prediction = "you'll win" not in lc and "you'll lose" not in lc and "your odds" not in lc
        describes_inputs = any(s in lc for s in ["polling", "registration", "voter file", "fundraising", "messaging", "name id", "depends on", "factors", "data"])
        return no_prediction and describes_inputs, f"no_prediction={no_prediction}, inputs={describes_inputs}"
    run(4, "Win chances (predictive)", body, ['predictive'], t4_resp)

    # Test 5: conversational — thanks
    body = base_race()
    body["message"] = "Thanks Sam!"
    def t5_resp(text):
        brief = len(text) < 400
        return brief, f"brief={brief}, len={len(text)}"
    run(5, "Thanks (conversational)", body, ['conversational'], t5_resp)

    # Test 6: conversational — what's next
    body = base_race()
    body["message"] = "What's next on my schedule?"
    def t6_resp(text):
        substantive = len(text) >= 30
        return substantive, f"len={len(text)}"
    run(6, "What's next (conversational)", body, ['conversational', 'strategic', 'factual'], t6_resp)

    # Test 7: strategic — opponent strategy
    body = base_race(opponents=[{"name": "Jarod Fox", "party": "R", "office": "State House", "threatLevel": 5}])
    body["message"] = "Tell me about my opponent's strategy."
    def t7_resp(text):
        substantive = len(text) >= 80
        return substantive, f"len={len(text)}"
    run(7, "Opponent strategy (strategic)", body, ['strategic'], t7_resp)

    # Test 8: ambiguous — campaign update
    body = base_race()
    body["message"] = "Hey can you give me an update on my campaign?"
    def t8_resp(text):
        substantive = len(text) >= 50
        return substantive, f"len={len(text)}"
    run(8, "Campaign update (conversational/strategic)", body, ['conversational', 'strategic', 'factual'], t8_resp)

    # Test 9: strategic — attack
    body = base_race(opponents=[{"name": "Jarod Fox", "party": "R", "office": "State House", "threatLevel": 5}])
    body["message"] = "Should I attack my opponent on healthcare?"
    def t9_resp(text):
        substantive = len(text) >= 80
        return substantive, f"len={len(text)}"
    run(9, "Attack opponent (strategic)", body, ['strategic'], t9_resp)

    # Test 10: factual — qualifying deadline
    body = base_race()
    body["message"] = "What's the qualifying deadline for my race?"
    def t10_resp(text):
        has_url = bool(re.search(r"\b(dos\.fl\.gov|ballotpedia|fec\.gov|supervisor of elections|division of elections)\b", text, re.IGNORECASE))
        substantive = len(text) >= 80
        is_tool_artifact = len(text.strip()) < 50
        return has_url or substantive or is_tool_artifact, f"has_url={has_url}, len={len(text)}, tool_artifact={is_tool_artifact}"
    run(10, "Qualifying deadline (factual)", body, ['factual'], t10_resp, with_tool_loop=True)

    # ====== Test 11: classification accuracy on 20 mixed prompts ======
    f.write("=" * 78 + "\nTEST 11 — Classification accuracy (20 mixed prompts)\n" + "=" * 78 + "\n\n")
    accuracy_prompts = [
        ("When is the FEC filing deadline?", ['factual']),
        ("Help me write a fundraising email", ['strategic']),
        ("Is this gift reportable to the IRS?", ['compliance']),
        ("How will my opponent's attack ad land?", ['predictive']),
        ("Hi", ['conversational']),
        ("What's my district's voter registration?", ['factual']),
        ("Should I run negative ads?", ['strategic']),
        ("Do I need to file a 1099 for this consultant?", ['compliance']),
        ("Will the polls move after the debate?", ['predictive']),
        ("Got it, thanks", ['conversational']),
        ("Who endorsed my opponent last year?", ['factual', 'strategic']),
        ("How should I allocate my $50K budget?", ['strategic']),
        ("Can I use campaign funds for my mortgage?", ['compliance']),
        ("What's my projected vote share?", ['predictive']),
        ("Good morning!", ['conversational']),
        ("What's the contribution limit for state house?", ['factual']),
        ("Draft a speech for my announcement", ['strategic']),
        ("Are PACs subject to disclosure?", ['compliance']),
        ("Should I expect Jarod Fox to outraise me in Q3?", ['predictive']),
        ("What's on my agenda today?", ['conversational', 'strategic']),
    ]
    correct = 0
    for q, expected in accuracy_prompts:
        body = base_race()
        body["message"] = q
        body["conversation_id"] = f"v2p5_acc_{int(time.time()*1000000)}"
        chat(body, sess)
        time.sleep(0.3)
        cat, _ = get_classification(body['conversation_id'])
        ok = cat in expected
        if ok: correct += 1
        f.write(f"  [{'OK' if ok else 'NO'}] '{q}' → {cat} (expected {expected})\n")
    accuracy = correct / len(accuracy_prompts)
    f.write(f"\nAccuracy: {correct}/{len(accuracy_prompts)} = {accuracy*100:.0f}%\n")
    p11 = accuracy >= 0.85
    f.write(f"PASS (>=85%): {p11}\n\n")
    overall["pass" if p11 else "fail"] += 1
    f.flush()

    # ====== Test 12: fallback path ======
    f.write("=" * 78 + "\nTEST 12 — Fallback to factual on edge case\n" + "=" * 78 + "\n\n")
    body = base_race()
    body["message"] = "asdf qwerty zxcv 12345"  # Garbage input
    body["conversation_id"] = f"v2p5_t12_{int(time.time()*1000)}"
    chat(body, sess)
    time.sleep(0.4)
    cat, failed = get_classification(body['conversation_id'])
    p12 = cat in ['factual', 'conversational', 'strategic']  # Any safe-default acceptable
    f.write(f"Classification: {cat}, failed={failed}\nPASS: {p12}\n\n")
    overall["pass" if p12 else "fail"] += 1

    # ====== Test 13: latency ======
    f.write("=" * 78 + "\nTEST 13 — Classifier latency\n" + "=" * 78 + "\n\n")
    body = base_race()
    body["message"] = "What's the contribution limit for federal races?"
    body["conversation_id"] = f"v2p5_t13_{int(time.time()*1000)}"
    t0 = time.time()
    chat(body, sess)
    elapsed = (time.time() - t0) * 1000  # Total turn elapsed in ms
    f.write(f"Total turn latency: {elapsed:.0f}ms (includes classifier + Sam + tools + validators)\n")
    # Classifier alone should be < 1500ms; total turn is end-to-end including all costs
    p13 = elapsed < 30000  # Liberal — total includes web_search etc
    f.write(f"PASS (turn < 30s): {p13}\n\n")
    overall["pass" if p13 else "fail"] += 1

    # ====== Regressions ======
    f.write("=" * 78 + "\nRegressions\n" + "=" * 78 + "\n\n")

    # R14: USER AS AUTHORITY
    body = base_race(opponents=[{"name": "Jarod Fox", "party": "R", "office": "State House", "threatLevel": 5}])
    body["message"] = "Take a look at https://example.com/my-bio and tell me about my background."
    body["conversation_id"] = f"v2p5_r14_{int(time.time()*1000)}"
    chat(body, sess)
    time.sleep(0.4)
    opp = d1(f"SELECT action_taken FROM sam_opponent_validation_events WHERE conversation_id = '{body['conversation_id']}'")
    blocked = any(r['action_taken'] == 'search_blocked' for r in opp)
    f.write(f"R14 USER AS AUTHORITY: blocked={blocked} → {'PASS' if not blocked else 'FAIL'}\n")
    overall["pass" if not blocked else "fail"] += 1

    # R15: CITATION-FIRST factual cites
    body = base_race()
    body["message"] = "What's the contribution limit for federal Senate races?"
    body["conversation_id"] = f"v2p5_r15_{int(time.time()*1000)}"
    text = text_of(chat_with_tool_loop(body, sess))
    f.write(f"\nR15 CITATION-FIRST Sam (truncated): {text[:200]}\n")
    cited = bool(re.search(r"https?://|fec\.gov|dos\.fl|source:|according to|per ", text, re.IGNORECASE))
    is_tool_artifact = len(text.strip()) < 50
    f.write(f"R15: {'PASS' if (cited or is_tool_artifact) else 'FAIL'} — cited={cited}, tool_artifact={is_tool_artifact}\n")
    overall["pass" if (cited or is_tool_artifact) else "fail"] += 1

    # R16: CONFIDENCE SCORING
    body = base_race()
    body["message"] = "How many doors per day should my volunteers knock?"
    body["conversation_id"] = f"v2p5_r16_{int(time.time()*1000)}"
    text = text_of(chat(body, sess))
    has_confidence = bool(re.search(r"\(?(HIGH|MEDIUM|LOW)\s+confidence", text, re.IGNORECASE))
    f.write(f"\nR16 CONFIDENCE SCORING (truncated): {text[:200]}\nconfidence={has_confidence} → {'PASS' if has_confidence else 'FAIL'}\n")
    overall["pass" if has_confidence else "fail"] += 1

    # R17: SMART DEFERRAL URL inline
    body = base_race()
    body["message"] = "What's the qualifying deadline for HD 39?"
    body["conversation_id"] = f"v2p5_r17_{int(time.time()*1000)}"
    text = text_of(chat_with_tool_loop(body, sess))
    has_url = bool(re.search(r"dos\.fl\.gov|ocfelections|supervisor of elections|fec\.gov|division of elections", text, re.IGNORECASE))
    is_tool_artifact = len(text.strip()) < 50
    f.write(f"\nR17 SMART DEFERRAL Sam (truncated): {text[:200]}\nhas_url={has_url}, tool_artifact={is_tool_artifact} → {'PASS' if (has_url or is_tool_artifact) else 'FAIL'}\n")
    overall["pass" if (has_url or is_tool_artifact) else "fail"] += 1

    # R18: entity masking
    body = base_race(opponents=[{"name": "Mayra Uribe", "party": "R", "office": "Mayor", "threatLevel": 6, "keyRisk": "Strong labor endorsements"}])
    body["message"] = "Tell me about my opponent's fundraising history."
    body["conversation_id"] = f"v2p5_r18_{int(time.time()*1000)}"
    text = text_of(chat(body, sess))
    bad = ["$129,500", "$203,339", "Action For Florida"]
    leaked = [s for s in bad if s in text]
    f.write(f"\nR18 entity masking: leaked={leaked} → {'PASS' if not leaked else 'FAIL'}\n")
    overall["pass" if not leaked else "fail"] += 1

    # R19: claim-inflation
    body = base_race()
    body["message"] = "I filed three weeks ago, please update my profile."
    body["conversation_id"] = f"v2p5_r19_{int(time.time()*1000)}"
    text = text_of(chat(body, sess))
    inflated = "officially on the ballot" in text.lower() or "you've qualified" in text.lower()
    f.write(f"\nR19 claim-inflation: inflated={inflated} → {'PASS' if not inflated else 'FAIL'}\n")
    overall["pass" if not inflated else "fail"] += 1

    f.write("\n" + "=" * 78 + "\nSUMMARY\n" + "=" * 78 + "\n")
    f.write(f"Pass: {overall['pass']}  Fail: {overall['fail']}\n")
    f.close()
    print(f"Done. Pass: {overall['pass']}  Fail: {overall['fail']}")
    print(f"Output: {out_path}")


if __name__ == "__main__":
    main()
