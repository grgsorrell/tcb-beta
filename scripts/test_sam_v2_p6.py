"""Sam v2 Phase 6 — Settings UI wiring (backend integration + Sam propagation).

Backend integration:
  13. /api/profile/site/fetch with new URL → content_length > 0, fetched_at updates
  14. /api/profile/site/refresh → fetched_at updates without changing URL
  15. /api/profile/bio/save → bio stored in profile, capped at 1000 chars
  16. /api/profile/save with early_voting_start_date → field updated
  17. /api/profile/save with early_voting_start_date=null → field cleared

Sam propagation (changes from settings reach Sam's prompt):
  18. New bio text → Sam references new content
  19. New site URL → Sam references new content (or smart deferral with URL)
  20. New early voting date → Sam states the date with HIGH confidence

Regressions:
  21. v2 Phase 1 onboarding profile-save still works
  22. v2 Phase 5 question classifier still works (chat handler not broken)
"""
import json, subprocess, time, urllib.request, urllib.error, re

W = "https://candidate-toolbox-secretary2.grgsorrell.workers.dev"


def login(username="cjc"):
    req = urllib.request.Request(W + "/auth/beta-login",
        data=json.dumps({"username": username, "password": "Beta#01"}).encode(),
        headers={"Content-Type": "application/json", "User-Agent": "tcb-v2p6/1.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        b = json.loads(r.read())
    return b["sessionId"], b["userId"]


def api(method, path, body, sess):
    headers = {"User-Agent": "tcb-v2p6/1.0", "Authorization": f"Bearer {sess}"}
    if body is not None: headers["Content-Type"] = "application/json"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(W + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        try: return e.code, json.loads(e.read())
        except: return e.code, {}


def chat(body, sess):
    h = {"Content-Type": "application/json", "User-Agent": "tcb-v2p6/1.0", "Authorization": f"Bearer {sess}"}
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


def base_race():
    return {
        "candidateName": "Stephanie Murphy",
        "specificOffice": "State House", "state": "FL", "location": "HD 39",
        "officeType": "state", "electionDate": "2026-11-03",
        "daysToElection": 186, "govLevel": "state",
        "budget": 50000, "startingAmount": 0, "fundraisingGoal": 50000,
        "totalRaised": 0, "donorCount": 0, "winNumber": 5000,
        "additionalContext": "", "candidateBrief": None,
        "intelContext": {"opponents": []}, "raceProfile": None,
        "party": "D", "history": [], "mode": "chat",
    }


def main():
    out_path = "scripts/sam_v2_p6_output.txt"
    f = open(out_path, "w", encoding="utf-8", newline="\n")
    f.write(f"Sam v2 Phase 6 — Settings UI backend + Sam propagation\nRun: {time.strftime('%Y-%m-%d %H:%M:%S')}\n")
    f.write("=" * 78 + "\n\n")

    sess, uid = login("cjc")
    f.write(f"cjc userId: {uid}\n\n")

    overall = {"pass": 0, "fail": 0}
    def check(label, ok, why=""):
        f.write(f"  {label}: {'PASS' if ok else 'FAIL'}{' — ' + why if why else ''}\n")
        overall["pass" if ok else "fail"] += 1

    # Reset profile fields
    d1(f"UPDATE profiles SET candidate_site_url=NULL, candidate_site_content=NULL, candidate_site_fetched_at=NULL, candidate_bio_text=NULL, early_voting_start_date=NULL WHERE user_id='{uid}'")

    f.write("=" * 78 + "\nBackend integration\n" + "=" * 78 + "\n\n")

    # T13: site fetch
    code, body = api("POST", "/api/profile/site/fetch", {"url": "https://example.com"}, sess)
    rows = d1(f"SELECT candidate_site_url, length(candidate_site_content) AS slen, candidate_site_fetched_at FROM profiles WHERE user_id='{uid}'")
    t13 = code == 200 and body.get("success") and rows and rows[0].get('slen', 0) > 0 and rows[0].get('candidate_site_fetched_at')
    check("T13 site fetch (new URL stores content + fetched_at)", t13, f"len={rows[0].get('slen') if rows else None}, ts={rows[0].get('candidate_site_fetched_at') if rows else None}")

    # T14: site refresh
    time.sleep(1)
    prev_ts = rows[0].get('candidate_site_fetched_at') if rows else None
    code, body = api("POST", "/api/profile/site/refresh", {}, sess)
    rows = d1(f"SELECT candidate_site_url, candidate_site_fetched_at FROM profiles WHERE user_id='{uid}'")
    new_ts = rows[0].get('candidate_site_fetched_at') if rows else None
    t14 = code == 200 and body.get("success") and new_ts and new_ts != prev_ts
    check("T14 site refresh (timestamp updates without URL change)", t14, f"prev={prev_ts}, new={new_ts}")

    # T15: bio save
    code, body = api("POST", "/api/profile/bio/save", {"bio_text": "I am a former public school teacher running for State House to fight for education funding and labor protections."}, sess)
    rows = d1(f"SELECT candidate_bio_text FROM profiles WHERE user_id='{uid}'")
    t15 = code == 200 and body.get("success") and rows and "former public school teacher" in (rows[0].get('candidate_bio_text') or '')
    check("T15 bio save (text stored)", t15)

    # T15b: cap enforcement
    api("POST", "/api/profile/bio/save", {"bio_text": "x" * 1500}, sess)
    rows = d1(f"SELECT length(candidate_bio_text) AS n FROM profiles WHERE user_id='{uid}'")
    check("T15b bio cap 1000 chars", rows and rows[0].get('n') == 1000, f"len={rows[0].get('n') if rows else None}")
    # Restore real bio for test 18
    api("POST", "/api/profile/bio/save", {"bio_text": "I am a former public school teacher running for State House to fight for education funding and labor protections."}, sess)

    # T16: early voting save via /api/profile/save
    code, body = api("POST", "/api/profile/save", {
        "candidate_name": "Test", "specific_office": "State House", "office_level": "state",
        "party": "D", "location": "HD 39", "state": "FL", "election_date": "2026-11-03",
        "early_voting_start_date": "2026-10-22",
        "candidate_site_url": "https://example.com",  # preserve from T13
        "candidate_bio_text": "I am a former public school teacher running for State House to fight for education funding and labor protections.",
        "onboarding_complete": 1
    }, sess)
    rows = d1(f"SELECT early_voting_start_date FROM profiles WHERE user_id='{uid}'")
    t16 = code == 200 and rows and rows[0].get('early_voting_start_date') == '2026-10-22'
    check("T16 early voting save", t16, f"got={rows[0].get('early_voting_start_date') if rows else None}")

    # T17: early voting clear via null
    code, body = api("POST", "/api/profile/save", {
        "candidate_name": "Test", "specific_office": "State House", "office_level": "state",
        "party": "D", "location": "HD 39", "state": "FL", "election_date": "2026-11-03",
        "early_voting_start_date": None,
        "candidate_site_url": "https://example.com",
        "candidate_bio_text": "I am a former public school teacher running for State House to fight for education funding and labor protections.",
        "onboarding_complete": 1
    }, sess)
    rows = d1(f"SELECT early_voting_start_date FROM profiles WHERE user_id='{uid}'")
    t17 = code == 200 and rows and rows[0].get('early_voting_start_date') is None
    check("T17 early voting clear", t17, f"got={rows[0].get('early_voting_start_date') if rows else None}")

    # ====== Sam propagation ======
    f.write("\n" + "=" * 78 + "\nSam propagation\n" + "=" * 78 + "\n\n")

    # T18: bio propagates
    body = base_race()
    body["message"] = "Tell me about my background."
    body["conversation_id"] = f"v2p6_t18_{int(time.time()*1000)}"
    text = text_of(chat(body, sess))
    f.write(f"T18 Sam (bio propagation):\n{text}\n\n")
    refs_bio = ("teacher" in text.lower() and ("public school" in text.lower() or "education" in text.lower())) or "labor" in text.lower()
    check("T18 Sam references new bio content", refs_bio, f"refs={refs_bio}")

    # T19: site URL — re-set early voting + content for test
    d1(f"UPDATE profiles SET early_voting_start_date='2026-10-22' WHERE user_id='{uid}'")
    body = base_race()
    body["message"] = "What's my campaign messaging?"
    body["conversation_id"] = f"v2p6_t19_{int(time.time()*1000)}"
    text = text_of(chat(body, sess))
    f.write(f"\nT19 Sam (site propagation):\n{text}\n\n")
    refs_site = "example" in text.lower() or "your site" in text.lower() or "campaign website" in text.lower() or "domain" in text.lower() or "placeholder" in text.lower()
    check("T19 Sam references site content", refs_site)

    # T20: early voting date
    body = base_race()
    body["message"] = "When does early voting start?"
    body["conversation_id"] = f"v2p6_t20_{int(time.time()*1000)}"
    text = text_of(chat(body, sess))
    f.write(f"\nT20 Sam (early voting):\n{text}\n\n")
    states_date = ("october 22" in text.lower() or "10/22" in text or "2026-10-22" in text or "oct 22" in text.lower())
    check("T20 Sam states October 22, 2026", states_date)

    # ====== Regressions ======
    f.write("\n" + "=" * 78 + "\nRegressions\n" + "=" * 78 + "\n\n")

    # T21: profile/save with all v2 P1 fields still works
    code, body = api("POST", "/api/profile/save", {
        "candidate_name": "Test Candidate", "specific_office": "Mayor",
        "office_level": "city", "party": "D", "location": "Test City",
        "state": "FL", "election_date": "2026-11-03",
        "candidate_site_url": "https://example.com",
        "candidate_bio_text": "Bio text.",
        "early_voting_start_date": "2026-10-15",
        "onboarding_complete": 1
    }, sess)
    code2, body2 = api("GET", "/api/profile/load", None, sess)
    p = body2.get("profile") or {}
    t21 = (code == 200 and code2 == 200
           and p.get("candidate_site_url") == "https://example.com"
           and p.get("candidate_bio_text") == "Bio text."
           and p.get("early_voting_start_date") == "2026-10-15")
    check("T21 v2 P1 onboarding profile-save still works", t21)

    # T22: classifier still works
    body = base_race()
    body["message"] = "Thanks Sam!"
    body["conversation_id"] = f"v2p6_t22_{int(time.time()*1000)}"
    chat(body, sess)
    time.sleep(0.4)
    rows = d1(f"SELECT classified_category FROM sam_classification_events WHERE conversation_id = '{body['conversation_id']}'")
    t22 = rows and rows[0].get('classified_category') == 'conversational'
    check("T22 v2 P5 classifier still works (Thanks → conversational)", t22, f"cat={rows[0].get('classified_category') if rows else None}")

    f.write("\n" + "=" * 78 + "\nSUMMARY\n" + "=" * 78 + "\n")
    f.write(f"Pass: {overall['pass']}  Fail: {overall['fail']}\n")
    f.close()
    print(f"Done. Pass: {overall['pass']}  Fail: {overall['fail']}")
    print(f"Output: {out_path}")


if __name__ == "__main__":
    main()
