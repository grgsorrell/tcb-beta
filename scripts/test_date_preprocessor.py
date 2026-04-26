"""Date preprocessor tests.

Tests 1-10 — verify the rewrite logic by sending a chat with a known
conversation_id, then reading the sam_date_rewrites D1 row that the
handler wrote fire-and-forget. We don't care about Sam's response for
these — the row's rewritten_message is the source of truth.

Tests 11-14 — live Sam calls. Capture the unmodified response.

Output is written to scripts/preprocessor_output.txt as UTF-8 to dodge
Windows console cp1252 mangling.
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
    "party": "",
}


def chat(message, conv_id):
    body = dict(RACE)
    body["message"] = message
    body["history"] = []
    body["mode"] = "chat"
    body["conversation_id"] = conv_id
    req = urllib.request.Request(
        WORKER, data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json", "User-Agent": "tcb-pp-test/1.0"}
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read().decode("utf-8"))


def extract_text(data):
    if not data or not isinstance(data.get("content"), list):
        return ""
    return "".join(b.get("text", "") for b in data["content"]
                   if isinstance(b, dict) and b.get("type") == "text").strip()


def d1_query(sql):
    out = subprocess.run(
        ["wrangler.cmd", "d1", "execute", "candidates-toolbox-db", "--remote",
         "--json", "--command", sql],
        capture_output=True, text=True, timeout=60
    )
    if out.returncode != 0:
        raise RuntimeError(out.stderr)
    txt = out.stdout
    return json.loads(txt[txt.find('['):])[0]["results"]


UNIT_TESTS = [
    # (label, input, expected_rewritten OR None for "no rewrite")
    # Day-of-week now included in single-date and week-of parentheticals
    # (weekend / month-only stay unchanged because they're already explicit).
    ("1",  "What about for next Saturday?",
           "What about for next Saturday (Saturday, 2026-05-02)?"),
    ("2",  "Schedule a town hall next Tuesday",
           "Schedule a town hall next Tuesday (Tuesday, 2026-04-28)"),
    ("3",  "Add a deadline for the end of the month",
           "Add a deadline for the end of the month (Thursday, 2026-04-30, last day)"),
    ("4",  "What's on tap for this weekend?",
           "What's on tap for this weekend (Sat 2026-05-02 / Sun 2026-05-03)?"),
    ("5",  "Block off something two weeks from now",
           "Block off something two weeks from now (Sunday, 2026-05-10)"),
    ("6",  "Did I do anything yesterday?",
           "Did I do anything yesterday (Saturday, 2026-04-25)?"),
    ("7",  "tomorrow",
           "tomorrow (Monday, 2026-04-27)"),
    ("8",  "What about Saturdays plans?",
           None),  # word boundary — no rewrite
    ("9",  "I said next Saturday (2026-05-02) earlier",
           None),  # already annotated — no double-rewrite
    ("10", "Schedule for next Tuesday and add tasks for the week after",
           "Schedule for next Tuesday (Tuesday, 2026-04-28) and add tasks for the week after (week of Monday, 2026-05-04)"),
]

LIVE_TESTS = [
    ("11", "What about for next Saturday?"),
    ("12", "What's on tap for this weekend?"),
    ("13", "Schedule a town hall next Tuesday and a fundraiser two weeks later"),
    ("14", "Block off something two weeks from now"),
]


def main():
    out_path = "scripts/preprocessor_output.txt"
    f = open(out_path, "w", encoding="utf-8", newline="\n")

    f.write("=" * 78 + "\n")
    f.write("UNIT TESTS 1-10 (rewrite logic verified via D1 sam_date_rewrites row)\n")
    f.write("=" * 78 + "\n\n")

    unit_results = []
    for label, inp, expected in UNIT_TESTS:
        conv = f"pp_unit_{label}_{int(time.time()*1000)}"
        try:
            chat(inp, conv)  # response ignored — we only need the side-effect log
        except Exception as e:
            f.write(f"--- Test {label} --- FETCH ERROR: {e}\n\n")
            unit_results.append((label, False, "fetch error"))
            continue

        # Tiny wait so the fire-and-forget log lands
        time.sleep(0.5)
        rows = d1_query(
            f"SELECT original_message, rewritten_message, patterns_matched "
            f"FROM sam_date_rewrites WHERE conversation_id = '{conv}'"
        )
        f.write(f"--- Test {label} ---\n")
        f.write(f"  Input:    {inp!r}\n")
        f.write(f"  Expected: {expected!r}\n")
        if expected is None:
            ok = (len(rows) == 0)
            f.write(f"  D1 rows:  {len(rows)} (expected 0 — no rewrite)\n")
        else:
            actual = rows[0]["rewritten_message"] if rows else None
            patterns = rows[0]["patterns_matched"] if rows else None
            f.write(f"  Actual:   {actual!r}\n")
            f.write(f"  Patterns matched: {patterns}\n")
            ok = (actual == expected)
        f.write(f"  RESULT: {'PASS' if ok else 'FAIL'}\n\n")
        unit_results.append((label, ok, expected))
        f.flush()

    f.write("\n" + "=" * 78 + "\n")
    f.write("LIVE SAM TESTS 11-14 (full unmodified responses)\n")
    f.write("=" * 78 + "\n\n")

    for label, q in LIVE_TESTS:
        conv = f"pp_live_{label}_{int(time.time()*1000)}"
        try:
            data = chat(q, conv)
            text = extract_text(data)
        except Exception as e:
            text = f"[ERROR: {e}]"

        # Capture the rewrite that was logged for this conv (if any)
        time.sleep(0.5)
        rows = d1_query(
            f"SELECT rewritten_message, patterns_matched FROM sam_date_rewrites "
            f"WHERE conversation_id = '{conv}'"
        )
        f.write(f"--- Test {label} ---\n")
        f.write(f"Q: {q}\n\n")
        if rows:
            f.write(f"Rewrite Sam saw: {rows[0]['rewritten_message']}\n")
            f.write(f"Patterns matched: {rows[0]['patterns_matched']}\n\n")
        else:
            f.write("(No rewrite logged — preprocessor did not match.)\n\n")
        f.write("Sam:\n")
        f.write(text + "\n\n")
        f.write("-" * 78 + "\n\n")
        f.flush()

    # Unit test summary
    f.write("\n" + "=" * 78 + "\n")
    f.write("UNIT TEST SUMMARY\n")
    f.write("=" * 78 + "\n")
    passed = sum(1 for _, ok, _ in unit_results if ok)
    for label, ok, exp in unit_results:
        f.write(f"  Test {label}: {'PASS' if ok else 'FAIL'}\n")
    f.write(f"\n  {passed}/{len(unit_results)} unit tests passed\n")
    f.close()

    # Echo file to stdout via UTF-8
    with open(out_path, "r", encoding="utf-8") as fh:
        sys.stdout.buffer.write(fh.read().encode("utf-8"))


if __name__ == "__main__":
    main()
