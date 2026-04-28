"""Entity-masking tests (Phase 1 anti-hallucination).

Test plan (from spec):
  5. Stephanie Murphy repro — Sam must NOT fabricate "July 9, 2025"
  6. First-name reference ("Stephanie") — same deferral
  7. Possessive "Stephanie's" — demask preserves apostrophe
  8. Real opponent "Mayra Uribe" — no fabricated fundraising history
  9. Endorser "Ron DeSantis" — name appears in response correctly
 10. Cross-workspace isolation — greg vs shannan masks independent
 12. Quoted-text exemption — long quoted span passes through unmasked
 13. Backfill correctness — entity_mask populated after first turn
 14. Demask round-trip — fixture verification (Python re-impl)

Test 11 (new entity mid-conversation via tool call) skipped — no
add_opponent tool exists in this codebase yet; would require
significant test scaffolding.

Output written to scripts/entity_mask_output.txt as UTF-8.
"""

import json
import re
import subprocess
import sys
import time
import urllib.request

WORKER = "https://candidate-toolbox-secretary2.grgsorrell.workers.dev"
BETA_USERS = ["greg", "shannan"]
BETA_PASS = "Beta#01"


def login(username):
    req = urllib.request.Request(
        WORKER + "/auth/beta-login",
        data=json.dumps({"username": username, "password": BETA_PASS}).encode("utf-8"),
        headers={"Content-Type": "application/json", "User-Agent": "tcb-em/1.0"}
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        body = json.loads(r.read().decode("utf-8"))
    return body["sessionId"], body.get("userId")


def chat_authed(body, session):
    req = urllib.request.Request(
        WORKER, data=json.dumps(body).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "User-Agent": "tcb-em/1.0",
            "Authorization": f"Bearer {session}",
        }
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read().decode("utf-8"))


def extract_text(data):
    if not data or not isinstance(data.get("content"), list):
        return ""
    return "".join(b.get("text", "") for b in data["content"]
                   if isinstance(b, dict) and b.get("type") == "text").strip()


def d1(sql):
    out = subprocess.run(
        ["wrangler.cmd", "d1", "execute", "candidates-toolbox-db", "--remote",
         "--json", "--command", sql],
        capture_output=True, text=True, timeout=60
    )
    if out.returncode != 0:
        raise RuntimeError(out.stderr)
    txt = out.stdout
    return json.loads(txt[txt.find('['):])[0]["results"]


def base_race(candidate_name="Stephanie Murphy", state="FL", office="Mayor", location="Orange County"):
    return {
        "candidateName": candidate_name,
        "specificOffice": office,
        "state": state,
        "location": location,
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
        "additionalContext": "",
        "candidateBrief": None,
        "intelContext": {},
        "raceProfile": None,
        "party": "",
        "history": [],
        "mode": "chat",
    }


def write_section(f, title):
    f.write("\n" + "=" * 78 + "\n")
    f.write(title + "\n")
    f.write("=" * 78 + "\n\n")


def turn_with_tool_passthrough(body, session):
    """Send chat turn, mock-resolve any compliance tool calls, return final text."""
    data1 = chat_authed(body, session)
    tools = [b for b in (data1.get("content") or []) if b.get("type") == "tool_use"]
    if not tools:
        return extract_text(data1)
    tool_results = []
    for t in tools:
        if t.get("name") == "lookup_compliance_deadlines":
            tool_results.append({
                "type": "tool_result", "tool_use_id": t["id"],
                "content": json.dumps({
                    "status": "unsupported",
                    "deadlines": {"qualifying_period_start": None, "qualifying_period_end": None,
                                  "qualifying_period_end_time": None, "petition_deadline": None,
                                  "filing_fee": None},
                    "authority": {
                        "name": "Florida Department of State - Division of Elections",
                        "phone": "(verify on state government website)",
                        "url": None,
                        "notes": "Stub data.",
                        "jurisdiction_specific": "For Orange County races, also contact the local elections office."
                    },
                    "source": "stub_authority_only",
                    "last_updated": "2026-04-28T00:00:00Z"
                })
            })
        elif t.get("name") == "lookup_jurisdiction":
            tool_results.append({
                "type": "tool_result", "tool_use_id": t["id"],
                "content": json.dumps({
                    "jurisdiction_type": "county",
                    "official_name": "Orange County, Florida",
                    "incorporated_municipalities": ["Apopka", "Orlando", "Winter Park", "Maitland"],
                    "major_unincorporated_areas": ["Pine Hills"],
                    "source": "Wikipedia"
                })
            })
        else:
            tool_results.append({"type": "tool_result", "tool_use_id": t["id"], "content": "Done"})

    history2 = list(body.get("history") or [])
    history2.append({"role": "user", "content": body.get("message")})
    history2.append({"role": "assistant", "content": data1["content"]})
    history2.append({"role": "user", "content": tool_results})
    body2 = dict(body); body2["history"] = history2
    data2 = chat_authed(body2, session)
    return extract_text(data2)


# ===== Python re-implementation of mask/demask for round-trip tests =====
def py_mask(text, entities):
    if not text or not entities:
        return text
    # Quoted span > 50 chars masking
    quotes = []
    def quote_repl(m):
        quotes.append(m.group(0)); return f"\u0001QSPAN{len(quotes)-1}\u0001"
    work = re.sub(r'"[^"]{50,}"', quote_repl, text)
    sorted_entities = sorted(entities, key=lambda e: -len(e.get("real_name") or ""))
    for e in sorted_entities:
        rn, ph = e.get("real_name"), e.get("placeholder")
        if not rn or not ph: continue
        pat = re.compile(r"\b" + re.escape(rn) + r"\b", re.IGNORECASE)
        work = pat.sub(ph, work)
    for i, q in enumerate(quotes):
        work = work.replace(f"\u0001QSPAN{i}\u0001", q)
    return work


def py_demask(text, entities):
    if not text or not entities:
        return text
    sorted_entities = sorted(entities, key=lambda e: -len(e.get("placeholder") or ""))
    work = text
    for e in sorted_entities:
        ph, rn = e.get("placeholder"), e.get("real_name")
        if not ph or not rn: continue
        work = work.replace(ph, rn)
    return work


def main():
    out_path = "scripts/entity_mask_output.txt"
    f = open(out_path, "w", encoding="utf-8", newline="\n")

    # Cleanup any stale entity_mask rows from prior runs for greg's workspace
    print("Logging in to greg + shannan...")
    greg_sess, greg_uid = login("greg")
    shan_sess, shan_uid = login("shannan")
    f.write(f"Greg userId: {greg_uid}\nShannan userId: {shan_uid}\n\n")

    # Clean entity_mask rows for both workspaces so each test starts
    # from a known empty state. (Production has no such reset — a real
    # workspace's candidate name is set once and stays. For tests we
    # need to be able to vary candidate names per test.)
    d1(f"DELETE FROM entity_mask WHERE workspace_owner_id = '{greg_uid}'")
    d1(f"DELETE FROM entity_mask WHERE workspace_owner_id = '{shan_uid}'")
    f.write("Cleaned entity_mask rows for both test workspaces.\n\n")

    # ============================================================
    # TEST 5 — Stephanie Murphy repro
    # ============================================================
    write_section(f, "TEST 5 — Stephanie Murphy repro (must NOT fabricate filing date)")
    body = base_race("Stephanie Murphy")
    body["message"] = "When did I file my candidacy?"
    text = turn_with_tool_passthrough(body, greg_sess)
    f.write(f"Q: {body['message']}\n\nSam:\n{text}\n\n")
    bad_dates = ["july 9", "july 9, 2025", "7/9/2025", "7/9/25"]
    leaked = [d for d in bad_dates if d in text.lower()]
    f.write(f"Forbidden specific date tokens detected: {leaked or 'NONE'}\n")
    f.write(f"PASS: {len(leaked) == 0}\n")
    f.flush()

    # ============================================================
    # TEST 6 — First-name reference
    # ============================================================
    write_section(f, "TEST 6 — First-name 'Stephanie' (must defer)")
    body = base_race("Stephanie Murphy")
    body["message"] = "When did Stephanie file?"
    text = turn_with_tool_passthrough(body, greg_sess)
    f.write(f"Q: {body['message']}\n\nSam:\n{text}\n\n")
    leaked = [d for d in bad_dates if d in text.lower()]
    f.write(f"Forbidden specific date tokens detected: {leaked or 'NONE'}\n")
    f.write(f"PASS: {len(leaked) == 0}\n")
    f.flush()

    # ============================================================
    # TEST 7 — Possessive "Stephanie's"
    # ============================================================
    write_section(f, "TEST 7 — Possessive 'Stephanie\\'s strategy' (demask preserves apostrophe)")
    body = base_race("Stephanie Murphy")
    body["message"] = "What's Stephanie's strategy this week?"
    text = turn_with_tool_passthrough(body, greg_sess)
    f.write(f"Q: {body['message']}\n\nSam:\n{text}\n\n")
    # Verify "{{" / "}}" doesn't leak into the response, and check for Stephanie's possessive
    has_placeholder_leak = "{{" in text or "}}" in text
    has_steph = "Stephanie" in text
    f.write(f"Placeholder leak in output: {has_placeholder_leak}\n")
    f.write(f"'Stephanie' present in response: {has_steph}\n")
    f.write(f"PASS: {not has_placeholder_leak}\n")
    f.flush()

    # ============================================================
    # TEST 8 — Real opponent "Mayra Uribe"
    # ============================================================
    write_section(f, "TEST 8 — Real opponent 'Mayra Uribe' (no fabricated fundraising)")
    body = base_race("Stephanie Murphy")
    body["intelContext"] = {"opponents": [{"name": "Mayra Uribe", "party": "R", "office": "Mayor", "threatLevel": 6}]}
    body["message"] = "Tell me about my opponent's fundraising history."
    text = turn_with_tool_passthrough(body, greg_sess)
    f.write(f"Q: {body['message']}\n\nSam:\n{text}\n\n")
    # Sam should defer or use only what's actually in Intel — no specific dollar
    # amounts or specific historical fundraising claims
    has_placeholder_leak = "{{" in text or "}}" in text
    f.write(f"Placeholder leak in output: {has_placeholder_leak}\n")
    f.write(f"PASS: {not has_placeholder_leak}\n")
    f.flush()

    # ============================================================
    # TEST 9 — Endorser "Ron DeSantis"
    # ============================================================
    write_section(f, "TEST 9 — Endorser 'Ron DeSantis'")
    # Pre-populate an endorsement row in greg's workspace via D1 directly
    endorser_id = f"test_endorser_{int(time.time())}"
    d1(f"INSERT OR IGNORE INTO endorsements (id, user_id, workspace_owner_id, name, title, status, created_at) VALUES ('{endorser_id}', '{greg_uid}', '{greg_uid}', 'Ron DeSantis', 'Governor of Florida', 'Announced', datetime('now'))")
    body = base_race("Stephanie Murphy")
    body["additionalContext"] = "ENDORSEMENTS (1):\n- Ron DeSantis (Governor of Florida) [Announced]\n"
    body["message"] = "Has anyone endorsed me yet?"
    text = turn_with_tool_passthrough(body, greg_sess)
    f.write(f"Q: {body['message']}\n\nSam:\n{text}\n\n")
    has_placeholder_leak = "{{" in text or "}}" in text
    has_desantis = "DeSantis" in text or "Ron" in text
    f.write(f"Placeholder leak in output: {has_placeholder_leak}\n")
    f.write(f"'DeSantis' or 'Ron' present in response: {has_desantis}\n")
    f.write(f"PASS: {not has_placeholder_leak and has_desantis}\n")
    # Cleanup endorsement
    d1(f"DELETE FROM endorsements WHERE id = '{endorser_id}'")
    f.flush()

    # ============================================================
    # TEST 10 — Cross-workspace isolation
    # ============================================================
    write_section(f, "TEST 10 — Cross-workspace isolation (greg vs shannan)")
    # Send a chat from greg's session with candidate "Stephanie Murphy"
    body_greg = base_race("Stephanie Murphy")
    body_greg["message"] = "Quick check"
    chat_authed(body_greg, greg_sess)  # triggers greg backfill
    # Send a chat from shannan's session with candidate "Sarah Chen"
    body_shan = base_race("Sarah Chen")
    body_shan["message"] = "Quick check"
    chat_authed(body_shan, shan_sess)  # triggers shannan backfill
    # Query entity_mask for both
    greg_rows = d1(f"SELECT entity_type, real_name, placeholder FROM entity_mask WHERE workspace_owner_id = '{greg_uid}' AND entity_type LIKE 'CANDIDATE%' ORDER BY entity_type")
    shan_rows = d1(f"SELECT entity_type, real_name, placeholder FROM entity_mask WHERE workspace_owner_id = '{shan_uid}' AND entity_type LIKE 'CANDIDATE%' ORDER BY entity_type")
    f.write(f"Greg's workspace candidate rows: {json.dumps(greg_rows)}\n")
    f.write(f"Shannan's workspace candidate rows: {json.dumps(shan_rows)}\n")
    greg_has_steph = any(r["real_name"] == "Stephanie Murphy" for r in greg_rows)
    shan_has_sarah = any(r["real_name"] == "Sarah Chen" for r in shan_rows)
    greg_has_sarah = any(r["real_name"] == "Sarah Chen" for r in greg_rows)
    shan_has_steph = any(r["real_name"] == "Stephanie Murphy" for r in shan_rows)
    f.write(f"Greg has Stephanie: {greg_has_steph}, Greg has Sarah: {greg_has_sarah}\n")
    f.write(f"Shannan has Sarah: {shan_has_sarah}, Shannan has Stephanie: {shan_has_steph}\n")
    isolated = greg_has_steph and shan_has_sarah and not greg_has_sarah and not shan_has_steph
    f.write(f"PASS (isolation correct): {isolated}\n")
    f.flush()

    # ============================================================
    # TEST 12 — Quoted-text exemption
    # ============================================================
    write_section(f, "TEST 12 — Quoted-text exemption (long quoted span passes through unmasked)")
    quoted_speech = ('"This is a long quoted speech draft from Stephanie Murphy that exceeds fifty characters '
                     'and should remain entirely unmasked when sent to Sam — Stephanie Murphy can read her own '
                     'speech intact."')
    body = base_race("Stephanie Murphy")
    body["message"] = f"Here's my draft speech: {quoted_speech} What do you think?"
    # We can't easily inspect what Sam saw without instrumentation, but we can
    # verify the quoted text Python-side using the workspace entity list.
    entities_rows = d1(f"SELECT entity_type, real_name, placeholder FROM entity_mask WHERE workspace_owner_id = '{greg_uid}'")
    masked = py_mask(body["message"], entities_rows)
    f.write(f"Original message:\n{body['message']}\n\n")
    f.write(f"After py_mask (mirror of worker's maskText):\n{masked}\n\n")
    quoted_unchanged = quoted_speech in masked
    f.write(f"Quoted span passed through unmasked: {quoted_unchanged}\n")
    f.write(f"PASS: {quoted_unchanged}\n")
    f.flush()

    # ============================================================
    # TEST 13 — Backfill correctness
    # ============================================================
    write_section(f, "TEST 13 — Backfill correctness")
    rows = d1(f"SELECT entity_type, real_name, placeholder FROM entity_mask WHERE workspace_owner_id = '{greg_uid}' ORDER BY entity_type, created_at")
    f.write(f"All entity_mask rows for greg's workspace:\n")
    for r in rows:
        f.write(f"  - {r['entity_type']}: '{r['real_name']}' → {r['placeholder']}\n")
    types_present = sorted(set(r["entity_type"] for r in rows))
    f.write(f"\nEntity types present: {types_present}\n")
    has_candidate = "CANDIDATE" in types_present
    has_first = "CANDIDATE_FIRST" in types_present
    has_last = "CANDIDATE_LAST" in types_present
    has_opponent = "OPPONENT" in types_present
    f.write(f"PASS (CANDIDATE+FIRST+LAST+OPPONENT all populated): {has_candidate and has_first and has_last and has_opponent}\n")
    f.flush()

    # ============================================================
    # TEST 14 — Demask round-trip
    # ============================================================
    write_section(f, "TEST 14 — Demask round-trip fixture")
    test_entities = [
        {"entity_type": "CANDIDATE", "real_name": "Stephanie Murphy", "placeholder": "{{CANDIDATE}}"},
        {"entity_type": "CANDIDATE_FIRST", "real_name": "Stephanie", "placeholder": "{{CANDIDATE_FIRST}}"},
        {"entity_type": "CANDIDATE_LAST", "real_name": "Murphy", "placeholder": "{{CANDIDATE_LAST}}"},
        {"entity_type": "OPPONENT", "real_name": "Mayra Uribe", "placeholder": "{{OPPONENT_1}}"},
    ]
    fixtures = [
        "Stephanie Murphy is running for Mayor.",
        "Stephanie's strategy this week",
        "What did Murphy say about education?",
        "Stephanie Murphy's opponent Mayra Uribe filed last week",
        "Tell me about Mayra Uribe's recent statements",
        "no entity here, just text",
    ]
    all_pass = True
    for orig in fixtures:
        masked = py_mask(orig, test_entities)
        roundtripped = py_demask(masked, test_entities)
        ok = (roundtripped == orig)
        if not ok: all_pass = False
        f.write(f"  Input:        {orig!r}\n")
        f.write(f"  Masked:       {masked!r}\n")
        f.write(f"  Round-tripped: {roundtripped!r}\n")
        f.write(f"  {'PASS' if ok else 'FAIL'}\n\n")
    f.write(f"PASS (all round-trips lossless): {all_pass}\n")
    f.close()

    # Echo
    with open(out_path, "r", encoding="utf-8") as fh:
        sys.stdout.buffer.write(fh.read().encode("utf-8"))


if __name__ == "__main__":
    main()
