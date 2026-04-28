"""Date battery — today is Tuesday 2026-04-28. Run 4 questions, paste full
unmodified Sam responses. Check correctness vs. spec expectations."""
import json, urllib.request, sys, time

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


def chat(message, conv_id):
    body = dict(RACE)
    body["message"] = message
    body["conversation_id"] = conv_id
    req = urllib.request.Request(W, data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "User-Agent": "tcb-date-test/1.0"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read().decode())


def text_of(data):
    if not data or not isinstance(data.get("content"), list):
        return ""
    return "".join(b.get("text", "") for b in data["content"]
                   if isinstance(b, dict) and b.get("type") == "text").strip()


QUESTIONS = [
    ("D1", "What about for next Saturday?",
        "spec expects Saturday May 2; per Mon-Sun convention with today=Tue Apr 28, preprocessor will resolve 'next Saturday' to next-week's Sat = May 9"),
    ("D2", "What's two weeks from now?",
        "spec expects Tuesday May 12 (today + 14 days)"),
    ("D3", "When is the election?",
        "spec expects Tuesday November 3, 2026 — 189 days away"),
    ("D4", "What's the date next Tuesday?",
        "spec expects Tuesday May 5"),
]


def main():
    f = open("scripts/date_battery_output.txt", "w", encoding="utf-8", newline="\n")
    f.write(f"Date battery — running on {time.strftime('%Y-%m-%d %H:%M:%S')}\n")
    f.write("Today (FL eastern): Tuesday 2026-04-28\n\n")
    for label, q, note in QUESTIONS:
        conv = f"date_{label}_{int(time.time()*1000)}"
        try:
            data = chat(q, conv)
            response = text_of(data)
        except Exception as e:
            response = f"[ERROR: {e}]"
        f.write("=" * 70 + "\n")
        f.write(f"{label} — Q: {q}\n")
        f.write(f"Spec expectation: {note}\n")
        f.write("-" * 70 + "\n")
        f.write(response + "\n\n")
        f.flush()
    f.close()
    with open("scripts/date_battery_output.txt", "r", encoding="utf-8") as fh:
        sys.stdout.buffer.write(fh.read().encode("utf-8"))


if __name__ == "__main__":
    main()
