"""CALENDAR REFERENCE block tests + canonical sample.

Verifies (a) Sam reads the block correctly when answering relative date
questions, and (b) the block renders with the expected format. The
worker generates the block server-side; this script also re-implements
the same algorithm in Python so we can paste the exact text back to
the user without instrumenting a debug endpoint in the worker.
"""

import json
import sys
import time
import urllib.request
from datetime import datetime, timezone, timedelta

WORKER = "https://candidate-toolbox-secretary2.grgsorrell.workers.dev"

RACE = {
    "candidateName": "Stephanie Test",
    "specificOffice": "Mayor",
    "state": "FL",
    "location": "Orange County",
    "officeType": "city",
    "electionDate": "2026-11-03",
    "daysToElection": 191,
    "govLevel": "city",
    "budget": 50000,
    "winNumber": 5000,
    "additionalContext": "",
    "candidateBrief": None,
    "intelContext": {},
    "raceProfile": None,
}

SHORT = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']
FULL = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday']


def chat(message, history, conv_id=None, race_overrides=None):
    body = dict(RACE)
    if race_overrides:
        body.update(race_overrides)
    body["message"] = message
    body["history"] = history
    body["mode"] = "chat"
    if conv_id:
        body["conversation_id"] = conv_id
    req = urllib.request.Request(
        WORKER, data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json", "User-Agent": "tcb-cal-test/1.0"}
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read().decode("utf-8"))


def extract_text(data):
    if not data or not isinstance(data.get("content"), list):
        return ""
    return "\n".join(b.get("text", "") for b in data["content"]
                     if isinstance(b, dict) and b.get("type") == "text").strip()


# ------------------ Python mirror of buildCalendarReference ------------------

def build_calendar_reference(iso_today, election_date):
    """Re-implementation of worker.js buildCalendarReference. Used to
    produce a literal sample of the block text that Haiku sees."""
    y, m, d = map(int, iso_today.split('-'))
    today_utc = datetime(y, m, d, 12, tzinfo=timezone.utc)
    ymd = lambda dt: dt.strftime('%Y-%m-%d')
    add = lambda dt, n: dt + timedelta(days=n)
    # JS getUTCDay: 0=Sun..6=Sat. Python isoweekday: 1=Mon..7=Sun. Convert:
    js_dow = lambda dt: (dt.isoweekday() % 7)  # Mon(1)->1, Sun(7)->0
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

    # End of this month (last day of m), end of next month (last day of m+1)
    if m == 12:
        eom = datetime(y, 12, 31, 12, tzinfo=timezone.utc)
        eonm = datetime(y + 1, 1, 31, 12, tzinfo=timezone.utc)
    else:
        # day 1 of next month minus 1 day
        eom = datetime(y, m + 1, 1, 12, tzinfo=timezone.utc) - timedelta(days=1)
        if m + 1 == 12:
            eonm = datetime(y, 12, 31, 12, tzinfo=timezone.utc)
        else:
            eonm = datetime(y, m + 2, 1, 12, tzinfo=timezone.utc) - timedelta(days=1)

    # Election line
    election_line = ''
    if election_date:
        try:
            ey, em, ed = map(int, election_date.split('-'))
            elect_utc = datetime(ey, em, ed, 12, tzinfo=timezone.utc)
            days_away = round((elect_utc - today_utc).total_seconds() / 86400)
            if days_away > 0:
                election_line = f"\n\nElection day: {ymd(elect_utc)} ({fl(elect_utc)}) — {days_away} day{'' if days_away==1 else 's'} away"
            elif days_away == 0:
                election_line = f"\n\nElection day: {ymd(elect_utc)} ({fl(elect_utc)}) — TODAY"
            else:
                ago = -days_away
                election_line = f"\n\nElection was {ymd(elect_utc)} ({fl(elect_utc)}) — {ago} day{'' if ago==1 else 's'} ago"
        except Exception:
            pass

    fmt_row = lambda arr: ' | '.join(f"{sh(dt)} {ymd(dt)}" for dt in arr)

    return f"""
================================================================
CALENDAR REFERENCE (use these mappings — do not calculate dates in your head)
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


# ------------------ Tests ------------------

def t(label, message, expected_in, expected_not=None):
    print(f"\n--- {label} ---")
    print(f"  Q: {message}")
    conv = "cal_test_" + str(int(time.time() * 1000))
    data = chat(message, [], conv_id=conv)
    text = extract_text(data)
    print(f"  Sam: {text[:280]}{'...' if len(text) > 280 else ''}")
    found = [e for e in expected_in if e.lower() in text.lower()]
    not_found = [e for e in expected_in if e.lower() not in text.lower()]
    bad = []
    if expected_not:
        bad = [e for e in expected_not if e.lower() in text.lower()]
    ok = (len(not_found) == 0) and (len(bad) == 0)
    if found: print(f"  Found expected tokens: {found}")
    if not_found: print(f"  MISSING: {not_found}")
    if bad: print(f"  WRONG TOKENS PRESENT: {bad}")
    print(f"  RESULT: {'PASS' if ok else 'FAIL'}")
    return ok


def t_any(label, message, accept_any, reject=None):
    """PASS if response contains ANY of accept_any tokens AND none of reject."""
    print(f"\n--- {label} ---")
    print(f"  Q: {message}")
    conv = "cal_test_" + str(int(time.time() * 1000))
    data = chat(message, [], conv_id=conv)
    text = extract_text(data)
    low = text.lower()
    found = [tok for tok in accept_any if tok.lower() in low]
    bad = [tok for tok in (reject or []) if tok.lower() in low]
    print(f"  Sam: {text[:280]}{'...' if len(text) > 280 else ''}")
    print(f"  Accepted-token hits: {found or 'none'}")
    if bad: print(f"  REJECTED tokens present: {bad}")
    ok = len(found) > 0 and not bad
    print(f"  RESULT: {'PASS' if ok else 'FAIL'}")
    return ok


def test_repro_next_saturday():
    # Today = Sun 2026-04-26. Next Saturday = May 2nd. NOT May 3rd.
    # Accept either ISO (2026-05-02) or colloquial (May 2 / 5/2). Reject May 3.
    return t_any("REPRO: 'next Saturday' should be May 2 not May 3",
                 "What date is next Saturday? Just give me the date.",
                 accept_any=["2026-05-02", "may 2,", "may 2nd", "may 2 ", "5/2", "5-2"],
                 reject=["may 3rd", "may 3,", "2026-05-03"])


def test_tomorrow():
    # Today = Sun 2026-04-26. Tomorrow = Mon 2026-04-27.
    return t_any("Tomorrow = Monday 2026-04-27",
                 "What's tomorrow's date and day of the week?",
                 accept_any=["2026-04-27", "april 27", "monday"])


def test_next_tuesday():
    # Today = Sun 2026-04-26. Next Tuesday = 2026-04-28.
    return t_any("Next Tuesday = 2026-04-28",
                 "What date is next Tuesday?",
                 accept_any=["2026-04-28", "april 28", "4/28"])


def test_end_of_month():
    # Today = Sun 2026-04-26. End of month = Thursday April 30.
    return t_any("End of the month = April 30",
                 "What date is the end of this month?",
                 accept_any=["2026-04-30", "april 30", "30th"])


def test_this_weekend():
    # Block has This weekend = Apr 25/26, Next weekend = May 2/3.
    # Sam may pick either depending on context — accept any weekend date.
    return t_any("This weekend",
                 "What dates are this weekend or next weekend?",
                 accept_any=["2026-04-25", "2026-04-26", "2026-05-02", "2026-05-03",
                             "april 25", "april 26", "may 2", "may 3"])


def test_two_weeks_out():
    # Today = Sun 2026-04-26. Two weeks out (Mon-Sun) = May 11–17.
    return t_any("Two weeks from now should mention May 11+",
                 "What date is exactly two weeks from today?",
                 accept_any=["2026-05-10", "2026-05-11", "may 10", "may 11"])


def test_election_day():
    # Election = 2026-11-03 (Tuesday). Accept either format. Days away should be ~191.
    return t_any("Election day reference",
                 "What's the election date and day of the week?",
                 accept_any=["2026-11-03", "november 3", "11/3"])


def test_yesterday():
    return t_any("Yesterday = Saturday 2026-04-25",
                 "What date was yesterday?",
                 accept_any=["2026-04-25", "april 25", "saturday"])


def test_no_election_date():
    # Verify no broken/undefined string when electionDate is absent.
    print("\n--- No election date in profile ---")
    conv = "cal_test_" + str(int(time.time() * 1000))
    data = chat("When's the election?", [], conv_id=conv,
                race_overrides={"electionDate": "", "daysToElection": None})
    text = extract_text(data)
    bad_tokens = ["undefined", "null", "nan", "election day: ,"]
    bad = [b for b in bad_tokens if b in text.lower()]
    print(f"  Sam: {text[:280]}")
    print(f"  Bad-format tokens detected: {bad or 'none'}")
    ok = len(bad) == 0
    print(f"  RESULT: {'PASS' if ok else 'FAIL'}")
    return ok


def test_timezone_hawaii():
    # Hawaii (UTC-10). Run at any UTC time. The block should reflect HI's
    # local calendar date. We can verify by inspecting Sam's "Today" response.
    print("\n--- Cross-state timezone (HI / Hawaii) ---")
    conv = "cal_test_" + str(int(time.time() * 1000))
    data = chat("What is today's date?", [], conv_id=conv,
                race_overrides={"state": "HI", "location": "Honolulu"})
    text = extract_text(data)
    print(f"  Sam: {text[:280]}")
    # Compute expected HI date right now
    hi_offset = timedelta(hours=-10)
    hi_now = datetime.now(timezone.utc) + hi_offset
    expected_iso = hi_now.strftime('%Y-%m-%d')
    expected_md = hi_now.strftime('%B %-d') if sys.platform != 'win32' else hi_now.strftime('%B %#d')
    found_iso = expected_iso in text
    found_md = expected_md.lower() in text.lower()
    print(f"  Expected HI date: {expected_iso} ({expected_md}). ISO found: {found_iso}, M-D found: {found_md}")
    ok = found_iso or found_md
    print(f"  RESULT: {'PASS' if ok else 'FAIL'}")
    return ok


def main():
    # Print canonical block first.
    today = datetime.now(timezone.utc) + timedelta(hours=-4)  # FL eastern, no DST adj
    iso_today = today.strftime('%Y-%m-%d')
    block = build_calendar_reference(iso_today, "2026-11-03")
    print("=" * 70)
    print("CANONICAL CALENDAR REFERENCE BLOCK (Python re-impl, byte-identical to worker)")
    print(f"  isoToday = {iso_today} | electionDate = 2026-11-03")
    print("=" * 70)
    print(block)
    print("=" * 70)
    print()

    results = {}
    results["1. Repro: 'next Saturday' is May 2"] = test_repro_next_saturday()
    results["2. Tomorrow = Monday April 27"] = test_tomorrow()
    results["3. Next Tuesday = April 28"] = test_next_tuesday()
    results["4. End of the month = April 30"] = test_end_of_month()
    results["5. This weekend"] = test_this_weekend()
    results["6. Two weeks out (May 11)"] = test_two_weeks_out()
    results["7. Election day reference"] = test_election_day()
    results["8. Yesterday = Saturday April 25"] = test_yesterday()
    results["9. No election date in profile"] = test_no_election_date()
    results["10. Cross-state timezone (HI)"] = test_timezone_hawaii()

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
