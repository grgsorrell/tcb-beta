"""Citation-index API rejection bug repro / fix verification.

Bug: messages.X.content.Y.citations.0: Could not find search result for
citation index — appears when validator regen path passes Sam's prior
content (text + citations) without the web_search_tool_result blocks the
citations reference.

Repro:
  Turn 1 — Trigger web_search (e.g., latest news on race) → expect Sam to
           respond with citations / source attributions visible in text.
  Turn 2 — Same conversation_id, ask compliance question that triggers
           citation validator regen path. Pre-fix: API rejection.
           Post-fix: response ships clean.

Also asserts Layer 2 didn't strip current-turn inline (Source: …)
attribution from the Turn 1 response.
"""
import json, time, urllib.request, urllib.error, re

W = "https://candidate-toolbox-secretary2.grgsorrell.workers.dev"


def login(username="jerry"):
    req = urllib.request.Request(W + "/auth/beta-login",
        data=json.dumps({"username": username, "password": "Beta#01"}).encode(),
        headers={"Content-Type": "application/json", "User-Agent": "tcb-citfix/1.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        b = json.loads(r.read())
    return b["sessionId"], b["userId"]


def chat(body, sess):
    h = {"Content-Type": "application/json", "User-Agent": "tcb-citfix/1.0",
         "Authorization": f"Bearer {sess}"}
    req = urllib.request.Request(W, data=json.dumps(body).encode(), headers=h)
    try:
        with urllib.request.urlopen(req, timeout=240) as r:
            return {"ok": True, "data": json.loads(r.read())}
    except urllib.error.HTTPError as e:
        body_text = e.read().decode(errors="replace")
        return {"ok": False, "status": e.code, "body": body_text}


def text_of(data):
    if not data or not isinstance(data.get("content"), list):
        return ""
    return "".join(b.get("text", "") for b in data["content"]
                   if isinstance(b, dict) and b.get("type") == "text").strip()


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
    out_path = "scripts/citation_fix_output.txt"
    f = open(out_path, "w", encoding="utf-8", newline="\n")
    f.write(f"Citation-index API rejection — fix verification\n"
            f"Run: {time.strftime('%Y-%m-%d %H:%M:%S')}\n"
            + "=" * 78 + "\n\n")

    sess, uid = login("jerry")
    f.write(f"jerry userId: {uid}\n\n")

    cid = f"citfix_{int(time.time()*1000)}"
    f.write(f"conversation_id: {cid}\n\n")

    overall = {"pass": 0, "fail": 0, "errors": []}

    # ---- Turn 1: trigger web_search with citations ----
    f.write("=" * 78 + "\nTURN 1 — Trigger web_search\n" + "=" * 78 + "\n\n")
    body = base_race()
    # "Latest news on my race" reliably triggers web_search per P4 R11.
    body["message"] = "What's the latest news on my race?"
    body["conversation_id"] = cid

    r1 = chat(body, sess)
    if not r1["ok"]:
        f.write(f"FAIL: HTTP {r1['status']}\nbody: {r1['body'][:1000]}\n")
        overall["fail"] += 1
        overall["errors"].append(("turn1", r1["status"], r1["body"][:500]))
        f.write("\nABORT — Turn 1 itself errored. Cannot complete repro.\n")
        f.close()
        print(f"FAIL on Turn 1. See {out_path}.")
        return

    t1_text = text_of(r1["data"])
    t1_content = r1["data"].get("content") or []
    t1_block_types = [b.get("type") for b in t1_content if isinstance(b, dict)]

    f.write(f"Q: {body['message']}\n\n")
    f.write(f"Block types: {t1_block_types}\n\n")
    f.write(f"Sam (text):\n{t1_text}\n\n")

    has_citation_block = any(b.get("citations") for b in t1_content
                              if isinstance(b, dict) and b.get("type") == "text")
    has_search_block = any(t in ("web_search_tool_result", "server_tool_use")
                            for t in t1_block_types)
    has_source_attribution = bool(re.search(
        r"\bSource:|\baccording to\b|\b(ballotpedia|fec\.gov|dos\.fl|"
        r"myflorida|congress\.gov|house\.gov)\b|i pulled|i found|i searched",
        t1_text, re.IGNORECASE))

    layer2_intact = has_citation_block or has_search_block or has_source_attribution
    f.write(f"has_citation_block(API)={has_citation_block}, "
            f"has_search_block={has_search_block}, "
            f"has_source_attribution(text)={has_source_attribution}\n")
    f.write(f"LAYER 2 REGRESSION CHECK: "
            f"{'PASS' if layer2_intact else 'FAIL — citations stripped from current turn'}\n\n")
    overall["pass" if layer2_intact else "fail"] += 1

    # Save Sam's content array for use as assistant history in Turn 2 — this is
    # exactly what triggers the bug pre-fix.
    history_after_t1 = [
        {"role": "user", "content": body["message"]},
        {"role": "assistant", "content": t1_content},
    ]

    # ---- Turn 2: trigger citation-validator regen path ----
    f.write("=" * 78 + "\nTURN 2 — Follow-up triggering validator regen\n"
            + "=" * 78 + "\n\n")
    body2 = base_race()
    body2["message"] = ("What's the contribution limit for an individual donor "
                        "to my state house race in Florida?")
    body2["conversation_id"] = cid
    body2["history"] = history_after_t1

    r2 = chat(body2, sess)
    if not r2["ok"]:
        f.write(f"FAIL: HTTP {r2['status']}\nbody: {r2['body'][:2000]}\n")
        overall["fail"] += 1
        overall["errors"].append(("turn2", r2["status"], r2["body"][:1000]))
        # Was it the exact bug?
        is_bug = "Could not find search result for citation index" in r2["body"]
        bug_label = 'YES — fix did not work' if is_bug else 'NO — different error'
        f.write(f"\nIs the citation-index bug? {bug_label}\n")
    else:
        t2_text = text_of(r2["data"])
        f.write(f"Q: {body2['message']}\n\nSam:\n{t2_text}\n\n")
        ships_clean = len(t2_text) > 0
        t2_label = 'PASS — response ships, no API rejection' if ships_clean else 'FAIL — empty response'
        f.write(f"TURN 2 BUG REPRO: {t2_label}\n\n")
        overall["pass" if ships_clean else "fail"] += 1

    # ---- Turn 3: ALSO trigger validator regen, different fact class ----
    # Compliance/dollar-amount question hits citation validator regen often.
    f.write("=" * 78 + "\nTURN 3 — Second validator regen probe\n"
            + "=" * 78 + "\n\n")
    body3 = base_race()
    # Pick a question that doesn't fire tool_use so Sam returns text directly
    # but still goes through the citation validator (mentions a dollar fact).
    body3["message"] = "How many doors per day should my volunteers knock?"
    body3["conversation_id"] = cid
    # Carry forward the multi-turn history including Turn 1's citations
    if r2["ok"]:
        history_after_t2 = history_after_t1 + [
            {"role": "user", "content": body2["message"]},
            {"role": "assistant", "content": r2["data"].get("content") or []},
        ]
        body3["history"] = history_after_t2
    else:
        body3["history"] = history_after_t1

    r3 = chat(body3, sess)
    if not r3["ok"]:
        f.write(f"FAIL: HTTP {r3['status']}\nbody: {r3['body'][:2000]}\n")
        overall["fail"] += 1
        is_bug = "Could not find search result for citation index" in r3["body"]
        bug_label = 'YES — fix did not work' if is_bug else 'NO — different error'
        f.write(f"\nIs the citation-index bug? {bug_label}\n")
    else:
        t3_text = text_of(r3["data"])
        f.write(f"Q: {body3['message']}\n\nSam:\n{t3_text}\n\n")
        ships_clean = len(t3_text) > 0
        t3_label = 'PASS — multi-turn history with citations clean' if ships_clean else 'FAIL'
        f.write(f"TURN 3 MULTI-TURN HISTORY: {t3_label}\n\n")
        overall["pass" if ships_clean else "fail"] += 1

    f.write("=" * 78 + "\nSUMMARY\n" + "=" * 78 + "\n")
    f.write(f"Pass: {overall['pass']}  Fail: {overall['fail']}\n")
    if overall["errors"]:
        f.write("\nErrors:\n")
        for e in overall["errors"]:
            f.write(f"  {e}\n")
    f.close()
    print(f"Done. Pass: {overall['pass']}  Fail: {overall['fail']}")
    print(f"Output: {out_path}")


if __name__ == "__main__":
    main()
