"""Clean dossier runner — produces UTF-8 text file with:
  Section A: literal canonical calendar reference block
  Section B: 8 verbatim questions, fresh conversation_id each, raw responses

Writes to scripts/dossier_output.txt. Avoids Windows cp1252 console mangling
by writing UTF-8 directly and reading the file at the end.
"""

import json
import sys
import time
import urllib.request
from datetime import datetime, timezone, timedelta

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

SHORT = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']
FULL = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday']


def build_calendar_reference(iso_today, election_date):
    y, m, d = map(int, iso_today.split('-'))
    today_utc = datetime(y, m, d, 12, tzinfo=timezone.utc)
    ymd = lambda dt: dt.strftime('%Y-%m-%d')
    add = lambda dt, n: dt + timedelta(days=n)
    js_dow = lambda dt: dt.isoweekday() % 7  # Mon(1)→1...Sat(6)→6, Sun(7)→0
    sh = lambda dt: SHORT[js_dow(dt)]
    fl = lambda dt: FULL[js_dow(dt)]

    yesterday = add(today_utc, -1)
    tomorrow = add(today_utc, 1)
    last7 = [add(today_utc, -i) for i in range(7, 0, -1)]
    days_from_monday = (js_dow(today_utc) + 6) % 7
    this_mon = add(today_utc, -days_from_monday)
    this_week = [add(this_mon, i) for i in range(7)]
    next_week = [add(this_mon, 7 + i) for i in range(7)]
    two_weeks = [add(this_mon, 14 + i) for i in range(7)]

    if m == 12:
        eom = datetime(y, 12, 31, 12, tzinfo=timezone.utc)
        eonm = datetime(y + 1, 1, 31, 12, tzinfo=timezone.utc)
    else:
        eom = datetime(y, m + 1, 1, 12, tzinfo=timezone.utc) - timedelta(days=1)
        if m + 1 == 12:
            eonm = datetime(y, 12, 31, 12, tzinfo=timezone.utc)
        else:
            eonm = datetime(y, m + 2, 1, 12, tzinfo=timezone.utc) - timedelta(days=1)

    election_line = ''
    if election_date:
        try:
            ey, em, ed = map(int, election_date.split('-'))
            elect_utc = datetime(ey, em, ed, 12, tzinfo=timezone.utc)
            days_away = round((elect_utc - today_utc).total_seconds() / 86400)
            if days_away > 0:
                election_line = f"\n\nElection day: {ymd(elect_utc)} ({fl(elect_utc)}) \u2014 {days_away} day{'' if days_away==1 else 's'} away"
            elif days_away == 0:
                election_line = f"\n\nElection day: {ymd(elect_utc)} ({fl(elect_utc)}) \u2014 TODAY"
            else:
                ago = -days_away
                election_line = f"\n\nElection was {ymd(elect_utc)} ({fl(elect_utc)}) \u2014 {ago} day{'' if ago==1 else 's'} ago"
        except Exception:
            pass

    fmt_row = lambda arr: ' | '.join(f"{sh(dt)} {ymd(dt)}" for dt in arr)

    return f"""
================================================================
CALENDAR REFERENCE (use these mappings \u2014 do not calculate dates in your head)
================================================================
Today: {fl(today_utc)}, {ymd(today_utc)}
Yesterday: {fl(yesterday)}, {ymd(yesterday)}
Tomorrow: {fl(tomorrow)}, {ymd(tomorrow)}

Last 7 days:
{fmt_row(last7)}

This week (Monday-Sunday containing today):
{fmt_row(this_week)}

Next week (Monday-Sunday after current week):
{fmt_row(next_week)}

Two weeks out (Monday-Sunday):
{fmt_row(two_weeks)}

This weekend: Sat {ymd(this_week[5])} / Sun {ymd(this_week[6])}
Next weekend: Sat {ymd(next_week[5])} / Sun {ymd(next_week[6])}

End of this month: {fl(eom)}, {ymd(eom)}
End of next month: {fl(eonm)}, {ymd(eonm)}{election_line}
================================================================
"""


def chat(message, conv_id):
    body = dict(RACE)
    body["message"] = message
    body["history"] = []
    body["mode"] = "chat"
    body["conversation_id"] = conv_id
    req = urllib.request.Request(
        WORKER, data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json", "User-Agent": "tcb-dossier/1.0"}
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read().decode("utf-8"))


def extract_text(data):
    if not data or not isinstance(data.get("content"), list):
        return ""
    return "".join(b.get("text", "") for b in data["content"]
                   if isinstance(b, dict) and b.get("type") == "text").strip()


QUESTIONS = [
    ("A", "What about for next Saturday?"),
    ("B", "What about tomorrow?"),
    ("C", "Schedule something for next Tuesday"),
    ("D", "Add a deadline for the end of the month"),
    ("E", "What's on tap for this weekend?"),
    ("F", "Block off something two weeks from now"),
    ("G", "When's the election again?"),
    ("H", "Did I do anything yesterday?"),
]


def main():
    out_path = "scripts/dossier_output.txt"
    with open(out_path, "w", encoding="utf-8", newline="\n") as f:
        # Section A — canonical block
        # Use today's date in FL eastern time (the candidate's TZ).
        # FL eastern is UTC-4 in DST (which is in effect April).
        fl_now = datetime.now(timezone.utc) + timedelta(hours=-4)
        iso_today = fl_now.strftime('%Y-%m-%d')
        f.write("=" * 78 + "\n")
        f.write("SECTION A \u2014 CANONICAL CALENDAR REFERENCE BLOCK\n")
        f.write(f"  isoToday={iso_today}  electionDate=2026-11-03  state=FL  tz=America/New_York\n")
        f.write("=" * 78 + "\n")
        f.write(build_calendar_reference(iso_today, "2026-11-03"))
        f.write("\n")
        f.write("=" * 78 + "\n")
        f.write("SECTION B \u2014 8 LIVE QUESTIONS, FRESH CONVERSATION_ID PER QUESTION\n")
        f.write("=" * 78 + "\n\n")

        for label, q in QUESTIONS:
            conv = f"dossier_{label}_{int(time.time()*1000)}"
            try:
                data = chat(q, conv)
                text = extract_text(data)
            except Exception as e:
                text = f"[ERROR fetching response: {e}]"

            f.write(f"--- Question {label} ---\n")
            f.write(f"Q: {q}\n\n")
            f.write("Sam:\n")
            f.write(text + "\n\n")
            f.write("-" * 78 + "\n\n")
            f.flush()
            time.sleep(0.5)  # courtesy gap between requests

    # Read back and print to stdout via UTF-8 so the conversation log gets it cleanly
    with open(out_path, "r", encoding="utf-8") as f:
        sys.stdout.buffer.write(f.read().encode("utf-8"))


if __name__ == "__main__":
    main()
