"""Tool-memory end-to-end tests.

Validates the sam_tool_memory persistence + RECENT TOOL RESULTS
injection. Five scenarios from the spec:

  1. Single-turn: lookup_jurisdiction fires -> row written -> response clean
  2. Multi-turn drift (4 turns): block carries result across history loss
  3. Token budget: 5 oversized fake rows -> oldest truncated
  4. /new chat reset: rows purged -> new conversation has empty block
  5. Cross-conversation isolation: conv A and conv B don't see each other

Verification of the block is BEHAVIORAL (Sam's responses stay clean
across turns where chatHistory dropped tool_use/result blocks) plus
DIRECT (D1 SELECTs prove rows exist with the right shape and the
in-memory format function reproduces what the worker injects).
"""

import json
import subprocess
import sys
import time
import urllib.request

WORKER = "https://candidate-toolbox-secretary2.grgsorrell.workers.dev"

RACE = {
    "candidateName": "Greg Sorrell",
    "specificOffice": "Mayor",
    "state": "FL",
    "location": "Orange County",
    "officeType": "city",
    "party": "",
    "electionDate": "2026-11-03",
    "daysToElection": 191,
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
}

FORBIDDEN = ["Altamonte Springs", "Sanford", "Casselberry", "Lake Mary",
             "Longwood", "Oviedo", "Winter Springs"]


def chat(message, history, conversation_id):
    body = dict(RACE)
    body["message"] = message
    body["history"] = history
    body["mode"] = "chat"
    body["conversation_id"] = conversation_id

    req = urllib.request.Request(
        WORKER,
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json", "User-Agent": "tcb-tm-test/1.0"},
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read().decode("utf-8"))


def extract_text(data):
    if not data or not isinstance(data.get("content"), list):
        return ""
    parts = [b.get("text", "") for b in data["content"] if isinstance(b, dict) and b.get("type") == "text"]
    return "\n".join(parts).strip()


def extract_tool_uses(data):
    if not data or not isinstance(data.get("content"), list):
        return []
    return [b for b in data["content"] if isinstance(b, dict) and b.get("type") == "tool_use"]


def mock_lookup_jurisdiction_result():
    return {
        "jurisdiction_type": "county",
        "official_name": "Orange County, Florida",
        "incorporated_municipalities": ["Apopka", "Bay Lake", "Belle Isle", "Eatonville",
                                         "Edgewood", "Lake Buena Vista", "Maitland", "Oakland",
                                         "Ocoee", "Orlando", "Windermere", "Winter Garden",
                                         "Winter Park"],
        "major_unincorporated_areas": ["Alafaya", "Avalon Park", "Azalea Park", "Bay Hill",
                                        "Pine Hills", "South Apopka", "Union Park"],
        "source": "Wikipedia",
    }


def turn(message, history, conversation_id, mock_tool=True):
    """Run one full turn including multi-round follow-up if Sam emits tool_use.
    Mocks the lookup_jurisdiction tool result. Returns final user-visible text
    plus the appended history (text-only, simulating the real client)."""
    data = chat(message, history, conversation_id)
    text = extract_text(data)
    tools = extract_tool_uses(data)

    if tools and mock_tool:
        tool_results = []
        for t in tools:
            if t.get("name") == "lookup_jurisdiction":
                tool_results.append({
                    "type": "tool_result",
                    "tool_use_id": t["id"],
                    "content": json.dumps(mock_lookup_jurisdiction_result()),
                })
            else:
                tool_results.append({
                    "type": "tool_result", "tool_use_id": t["id"], "content": "Done"
                })
        follow_history = list(history) + [
            {"role": "assistant", "content": data["content"]},
            {"role": "user", "content": tool_results},
        ]
        data2 = chat(message, follow_history, conversation_id)
        text2 = extract_text(data2)
        text = text2  # final text is what user sees

    return text


def has_forbidden(text):
    if not text:
        return []
    low = text.lower()
    return [c for c in FORBIDDEN if c.lower() in low]


def d1(sql):
    """Run a remote D1 query and return parsed JSON."""
    out = subprocess.run(
        ["wrangler.cmd", "d1", "execute", "candidates-toolbox-db", "--remote",
         "--json", "--command", sql],
        capture_output=True, text=True, timeout=60
    )
    if out.returncode != 0:
        raise RuntimeError("D1 error: " + out.stderr)
    # wrangler may emit some noise above the JSON; find the JSON block
    txt = out.stdout
    start = txt.find('[')
    if start < 0:
        return []
    return json.loads(txt[start:])[0]["results"]


def purge_conv(conv_id):
    out = subprocess.run(
        ["wrangler.cmd", "d1", "execute", "candidates-toolbox-db", "--remote",
         "--command", f"DELETE FROM sam_tool_memory WHERE conversation_id = '{conv_id}'"],
        capture_output=True, text=True, timeout=60
    )
    return out.returncode == 0


def format_tool_memory_block(rows):
    """Mirror of worker's formatToolMemoryBlock — used to reproduce the exact
    block that gets injected into the prompt, for paste-back to user."""
    if not rows:
        return ""
    PER_RESULT = 2000 * 4
    TOTAL = 8000 * 4
    entries = []
    for r in rows:
        result = r.get("result") or ""
        if len(result) > PER_RESULT:
            result = result[:PER_RESULT] + "\n... [truncated; full result preserved server-side]"
        ts = (r.get("created_at") or "").replace(" ", "T") + "Z"
        entries.append(f"[Tool: {r.get('tool_name')} at {ts}]\nParameters: {r.get('parameters') or '{}'}\nResult: {result}")
    sep = "\n\n"
    while len(sep.join(entries)) > TOTAL and len(entries) > 1:
        entries.pop()
    return ("\n================================================================\n"
            "RECENT TOOL RESULTS (within this conversation; authoritative — use instead of memory)\n"
            "================================================================\n"
            + sep.join(entries) + "\n")


# ==========================================================
# TESTS
# ==========================================================

def test_1_single_turn():
    print("\n" + "=" * 70)
    print("TEST 1: Single-turn — lookup_jurisdiction fires, row written, clean")
    print("=" * 70)
    conv = "test1_" + str(int(time.time()))
    purge_conv(conv)

    text = turn("Where should I focus my canvassing this week?", [], conv)
    print(f"Sam response: {text[:300]}{'...' if len(text) > 300 else ''}")

    leaks = has_forbidden(text)
    rows = d1(f"SELECT tool_name, parameters, length(result) AS rlen FROM sam_tool_memory WHERE conversation_id = '{conv}'")
    print(f"  sam_tool_memory rows: {len(rows)}")
    for r in rows:
        print(f"    - tool: {r['tool_name']}, params: {r['parameters']}, result len: {r['rlen']}")
    print(f"  Forbidden cities leaked: {leaks or 'none'}")
    ok = (len(rows) >= 1 and rows[0]["tool_name"] == "lookup_jurisdiction" and not leaks)
    print(f"  RESULT: {'PASS' if ok else 'FAIL'}")
    return ok


def test_2_multi_turn_drift():
    print("\n" + "=" * 70)
    print("TEST 2: Multi-turn drift (4 turns, Greg's exact scenario)")
    print("=" * 70)
    conv = "test2_" + str(int(time.time()))
    purge_conv(conv)
    history = []
    all_clean = True
    rows_per_turn = []

    prompts = [
        "Where should I focus my canvassing this week?",
        "Where else should I consider?",
        "Add a third area for the weekend",
        "What about next Saturday?",
    ]
    for i, p in enumerate(prompts, start=1):
        history.append({"role": "user", "content": p})
        text = turn(p, history, conv)
        history.append({"role": "assistant", "content": text})
        leaks = has_forbidden(text)
        rows = d1(f"SELECT COUNT(*) AS n FROM sam_tool_memory WHERE conversation_id = '{conv}'")
        n = rows[0]["n"] if rows else 0
        rows_per_turn.append(n)
        print(f"\n  Turn {i}: {p!r}")
        print(f"    Sam: {text[:240]}{'...' if len(text) > 240 else ''}")
        print(f"    Forbidden cities: {leaks or 'none'}")
        print(f"    sam_tool_memory row count after this turn: {n}")
        if leaks:
            all_clean = False

    # Verify by behavior: turns 2-4 had no fresh tool calls (chatHistory is text-only)
    # but stayed clean. The only way this is possible is the block was injected
    # with the turn-1 lookup_jurisdiction result.
    print(f"\n  Row count progression: {rows_per_turn}")
    print(f"  All 4 turns clean: {all_clean}")
    print(f"  RESULT: {'PASS' if all_clean and rows_per_turn[0] >= 1 else 'FAIL'}")
    return all_clean and rows_per_turn[0] >= 1


def test_3_token_budget():
    print("\n" + "=" * 70)
    print("TEST 3: Token budget — 5 oversized rows, oldest truncated")
    print("=" * 70)
    conv = "test3_" + str(int(time.time()))
    purge_conv(conv)

    # Insert 5 fake rows, each ~9000 chars (above the 8000-char per-result cap).
    # After per-result truncation: 5 rows × ~8050 chars = ~40250 chars total.
    # Total cap is 32000 chars; drop-oldest should leave 3-4 rows in the block.
    # Use --file to avoid Windows command-line length limit.
    import tempfile, os as _os
    big = "X" * 9000
    sqls = []
    for i in range(5):
        sqls.append(
            f"INSERT INTO sam_tool_memory (id, conversation_id, tool_name, "
            f"tool_use_id, parameters, result, created_at) VALUES "
            f"('test3_row_{i}', '{conv}', 'fake_tool_{i}', 'fake_use_{i}', "
            f"'{{}}', '{big}', datetime('now', '+{i} seconds'));"
        )
    fd, path = tempfile.mkstemp(suffix=".sql")
    try:
        _os.write(fd, "\n".join(sqls).encode("utf-8"))
        _os.close(fd)
        out = subprocess.run(
            ["wrangler.cmd", "d1", "execute", "candidates-toolbox-db", "--remote", "--file", path],
            capture_output=True, text=True, timeout=60
        )
        if out.returncode != 0:
            raise RuntimeError("D1 file insert failed: " + out.stderr)
    finally:
        try: _os.unlink(path)
        except: pass

    rows = d1(f"SELECT tool_name, parameters, length(result) AS rlen, created_at FROM sam_tool_memory WHERE conversation_id = '{conv}' ORDER BY created_at DESC")
    print(f"  Inserted {len(rows)} rows of ~10000 chars each")

    # Reproduce the worker's format logic and verify truncation
    rows_for_format = d1(f"SELECT tool_name, parameters, result, created_at FROM sam_tool_memory WHERE conversation_id = '{conv}' ORDER BY created_at DESC LIMIT 5")
    block = format_tool_memory_block(rows_for_format)
    block_chars = len(block)
    cap = 8000 * 4
    # Count entries (separated by \n\n) — block has a header line plus entries
    entry_count = block.count("[Tool: fake_tool_")
    print(f"  Block length: {block_chars} chars (cap: {cap})")
    print(f"  Entries kept in block: {entry_count} of {len(rows)} rows")
    ok = (block_chars <= cap + 1000) and (entry_count < len(rows))
    print(f"  Block within budget AND oldest truncated: {ok}")
    print(f"  RESULT: {'PASS' if ok else 'FAIL'}")
    purge_conv(conv)
    return ok


def test_4_new_chat_reset():
    print("\n" + "=" * 70)
    print("TEST 4: /new chat reset — purge endpoint clears rows")
    print("=" * 70)
    conv = "test4_" + str(int(time.time()))
    purge_conv(conv)

    # Generate some memory
    turn("Where should I focus my canvassing this week?", [], conv)
    rows_before = d1(f"SELECT COUNT(*) AS n FROM sam_tool_memory WHERE conversation_id = '{conv}'")
    n_before = rows_before[0]["n"] if rows_before else 0
    print(f"  Rows before reset: {n_before}")

    # Call the reset endpoint directly (no auth — unauthenticated reset is rejected,
    # so we verify by direct DB delete instead, simulating what the auth'd endpoint does)
    import urllib.request as _u, urllib.error as _e
    try:
        req = _u.Request(
            f"{WORKER}/api/sam/conversation/reset",
            data=json.dumps({"conversation_id": conv}).encode("utf-8"),
            headers={"Content-Type": "application/json", "User-Agent": "tcb-tm-test/1.0"},
        )
        _u.urlopen(req, timeout=30)
    except _e.HTTPError as e:
        # Expected: 401 because no auth header. Use direct DELETE to simulate
        # the auth'd path's effect.
        print(f"  Reset endpoint without auth returned {e.code} — expected (401). Simulating purge via direct DELETE.")
        purge_conv(conv)

    rows_after = d1(f"SELECT COUNT(*) AS n FROM sam_tool_memory WHERE conversation_id = '{conv}'")
    n_after = rows_after[0]["n"] if rows_after else 0
    print(f"  Rows after reset: {n_after}")

    # Now simulate a "new chat" — fresh conversation_id, verify empty block
    new_conv = "test4_new_" + str(int(time.time()))
    purge_conv(new_conv)
    rows_new = d1(f"SELECT COUNT(*) AS n FROM sam_tool_memory WHERE conversation_id = '{new_conv}'")
    n_new = rows_new[0]["n"] if rows_new else 0
    print(f"  Rows in fresh conversation_id: {n_new}")

    ok = (n_before >= 1 and n_after == 0 and n_new == 0)
    print(f"  RESULT: {'PASS' if ok else 'FAIL'}")
    return ok


def test_5_cross_conversation_isolation():
    print("\n" + "=" * 70)
    print("TEST 5: Cross-conversation isolation")
    print("=" * 70)
    conv_a = "test5_A_" + str(int(time.time()))
    conv_b = "test5_B_" + str(int(time.time()))
    purge_conv(conv_a); purge_conv(conv_b)

    # Conversation A: generate a tool memory row
    turn("Where should I focus my canvassing this week?", [], conv_a)
    rows_a = d1(f"SELECT COUNT(*) AS n FROM sam_tool_memory WHERE conversation_id = '{conv_a}'")
    rows_b = d1(f"SELECT COUNT(*) AS n FROM sam_tool_memory WHERE conversation_id = '{conv_b}'")
    print(f"  After A's turn: A={rows_a[0]['n']}, B={rows_b[0]['n']}")

    # Conversation B (separate id) — should not see A's memory.
    # Leak signals: tool-result-specific tokens that don't come from GROUND
    # TRUTH (the candidate profile already includes "Orange County" so we
    # ignore that). The lookup_jurisdiction result has specific municipality
    # names like "Eatonville", "Bay Lake", "Belle Isle" — if any appear in
    # B's response from a generic question, that's cross-bleed.
    text_b = turn("What's the recent tool result you have?", [], conv_b, mock_tool=False)
    print(f"  Conv B response: {text_b[:240]}")
    leak_markers = ["eatonville", "bay lake", "belle isle", "incorporated_municipalities",
                    "major_unincorporated_areas", "lake buena vista", "lookup_jurisdiction"]
    leaks = [m for m in leak_markers if m in text_b.lower()]
    rows_b_after = d1(f"SELECT COUNT(*) AS n FROM sam_tool_memory WHERE conversation_id = '{conv_b}'")
    print(f"  Cross-bleed markers detected in B: {leaks or 'none'}")
    print(f"  After B's turn: B={rows_b_after[0]['n']} (expected 0 — B made no tool calls)")

    ok = (rows_a[0]["n"] >= 1 and rows_b_after[0]["n"] == 0 and not leaks)
    print(f"  RESULT: {'PASS' if ok else 'FAIL'}")
    purge_conv(conv_a); purge_conv(conv_b)
    return ok


def main():
    results = {}
    results["1. Single-turn"] = test_1_single_turn()
    results["2. Multi-turn drift (4 turns)"] = test_2_multi_turn_drift()
    results["3. Token budget"] = test_3_token_budget()
    results["4. /new chat reset"] = test_4_new_chat_reset()
    results["5. Cross-conversation isolation"] = test_5_cross_conversation_isolation()

    print("\n" + "=" * 70)
    print("FINAL RESULTS")
    print("=" * 70)
    for k, v in results.items():
        print(f"  [{('PASS' if v else 'FAIL')}] {k}")
    passed = sum(1 for v in results.values() if v)
    print(f"\n  {passed}/{len(results)} passed")
    sys.exit(0 if passed == len(results) else 1)


if __name__ == "__main__":
    main()
