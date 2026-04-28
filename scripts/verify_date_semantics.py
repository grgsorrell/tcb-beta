"""Date semantics verification — today is Tuesday 2026-04-28.

Two phases:
A. Preprocessor unit tests (verified via D1 sam_date_rewrites row)
B. Live Sam responses for the 4 spec questions.

Output: scripts/date_verify_output.txt
"""
import json, subprocess, sys, time, urllib.request

W = "https://candidate-toolbox-secretary2.grgsorrell.workers.dev"

RACE = {
    "candidateName": "Greg Sorrell",
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
    "additionalContext": "",
    "candidateBrief": None,
    "intelContext": {},
    "raceProfile": None,
    "party": "",
    "history": [],
    "mode": "chat",
}


def login():
    req = urllib.request.Request(W + "/auth/beta-login",
        data=json.dumps({"username": "greg", "password": "Beta#01"}).encode(),
        headers={"Content-Type": "application/json", "User-Agent": "tcb-dv/1.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())["sessionId"]


def chat(message, conv_id, session=None):
    body = dict(RACE); body["message"] = message; body["conversation_id"] = conv_id
    headers = {"Content-Type": "application/json", "User-Agent": "tcb-dv/1.0"}
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


# ------------------ Phase A: preprocessor unit tests ------------------

UNIT_TESTS = [
    ("U1", "What about for next Saturday?",
     "What about for next Saturday (Saturday, 2026-05-02)?"),
    ("U2", "What's planned for this Saturday?",
     "What's planned for this Saturday (Saturday, 2026-05-02)?"),
    ("U3", "Schedule for next Tuesday",
     "Schedule for next Tuesday (Tuesday, 2026-05-05)"),
    ("U4", "What's this Tuesday?",
     "What's this Tuesday (Tuesday, 2026-05-05)?"),
    ("U5", "What was last Saturday?",
     "What was last Saturday (Saturday, 2026-04-25)?"),
    ("U6", "What's next Friday?",
     "What's next Friday (Friday, 2026-05-01)?"),
    ("U7", "What's this Friday?",
     "What's this Friday (Friday, 2026-05-01)?"),
]


def phase_a(f):
    f.write("=" * 70 + "\nPhase A — preprocessor unit tests (byte-exact via D1 row)\n" + "=" * 70 + "\n\n")
    all_pass = True
    for label, inp, expected in UNIT_TESTS:
        conv = f"dv_{label}_{int(time.time()*1000)}"
        try:
            chat(inp, conv)  # response ignored, we read the rewrite from D1
        except Exception as e:
            f.write(f"--- {label} --- FETCH ERROR: {e}\n\n"); all_pass = False; continue
        time.sleep(0.5)
        rows = d1(f"SELECT rewritten_message, patterns_matched FROM sam_date_rewrites WHERE conversation_id = '{conv}'")
        actual = rows[0]["rewritten_message"] if rows else None
        ok = (actual == expected)
        if not ok: all_pass = False
        f.write(f"--- {label} ---\n  Input:    {inp!r}\n  Expected: {expected!r}\n  Actual:   {actual!r}\n  RESULT: {'PASS' if ok else 'FAIL'}\n\n")
        f.flush()
    return all_pass


# ------------------ Phase B: live Sam responses ------------------

LIVE_QUESTIONS = [
    ("L1", "What about for next Saturday?", "Sam should state May 2 with day-of-week"),
    ("L2", "What's planned for this Saturday?", "Sam should state May 2"),
    ("L3", "Schedule for next Tuesday", "Sam should state May 5 (a week from today, NOT today)"),
    ("L4", "What's next Friday?", "Sam should state May 1"),
]


def phase_b(f):
    f.write("\n" + "=" * 70 + "\nPhase B — live Sam responses (full unmodified)\n" + "=" * 70 + "\n\n")
    for label, q, expectation in LIVE_QUESTIONS:
        conv = f"dvl_{label}_{int(time.time()*1000)}"
        try:
            data = chat(q, conv)
            response = text_of(data)
        except Exception as e:
            response = f"[ERROR: {e}]"
        f.write(f"--- {label} — Q: {q} ---\nExpected: {expectation}\n\nSam:\n{response}\n\n")
        f.write("-" * 70 + "\n\n")
        f.flush()


def main():
    out = open("scripts/date_verify_output.txt", "w", encoding="utf-8", newline="\n")
    out.write(f"Date semantics verification — {time.strftime('%Y-%m-%d %H:%M:%S')}\nToday: Tuesday 2026-04-28\n\n")
    a_pass = phase_a(out)
    out.write(f"\nPhase A summary: {'ALL PASS' if a_pass else 'SOME FAILED'}\n")
    phase_b(out)
    out.close()
    with open("scripts/date_verify_output.txt", "r", encoding="utf-8") as fh:
        sys.stdout.buffer.write(fh.read().encode("utf-8"))


if __name__ == "__main__":
    main()
