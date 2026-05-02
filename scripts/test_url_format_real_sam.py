"""Real Sam URL-format verification.

Per Greg's plan:
  T1. Win-totals scenario — Sam should respond with cite-able sources.
      Verify the URLs/domains are in formats the renderer can auto-link.
  T2. Compliance question — Sam should cite dos.fl.gov / fec.gov / etc.
  T3. Sample 3 responses, check URL forms (markdown link / bare / schemed).

The renderer test already proved auto-linking works on every Sam URL
pattern. This test verifies Sam still emits URLs (no regression on
citation patterns) after the prompt update.
"""
import json, re, time, urllib.request, urllib.error

W = "https://candidate-toolbox-secretary2.grgsorrell.workers.dev"


def login():
    req = urllib.request.Request(W + "/auth/beta-login",
        data=json.dumps({"username": "jerry", "password": "Beta#01"}).encode(),
        headers={"Content-Type": "application/json", "User-Agent": "tcb-urlfmt/1.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())["sessionId"]


def chat(body, sess):
    h = {"Content-Type": "application/json", "User-Agent": "tcb-urlfmt/1.0",
         "Authorization": f"Bearer {sess}"}
    req = urllib.request.Request(W, data=json.dumps(body).encode(), headers=h)
    try:
        with urllib.request.urlopen(req, timeout=240) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        return {"error": e.code, "body": e.read().decode(errors="replace")}


def text_of(data):
    return "".join(b.get("text", "") for b in (data.get("content") or [])
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


# Patterns the renderer can auto-link.
URL_PATTERNS = [
    (re.compile(r"\[[^\]]+\]\(https?://[^\s)]+\)"), "markdown link"),
    (re.compile(r"https?://[^\s<>\"']+"), "schemed URL"),
    (re.compile(r"\b(?:[a-z0-9][a-z0-9-]*\.)+(?:gov|com|org|net|edu|us|io|co|info|app)(?:/[^\s<>\"']*)?", re.I), "bare domain"),
]


def url_forms_in(text):
    forms = {}
    for pat, label in URL_PATTERNS:
        matches = pat.findall(text)
        if matches:
            forms[label] = matches[:5]
    return forms


def main():
    out = open("scripts/url_format_output.txt", "w", encoding="utf-8", newline="\n")
    out.write(f"Real Sam URL format — verification\nRun: {time.strftime('%Y-%m-%d %H:%M:%S')}\n"
              + "=" * 78 + "\n\n")

    sess = login()
    overall = {"pass": 0, "fail": 0}

    def show(label, ok, why=""):
        status = "PASS" if ok else "FAIL"
        out.write(f"{label}: {status}{(' — ' + why) if why else ''}\n\n")
        overall["pass" if ok else "fail"] += 1

    # T1: win-totals (Greg's exact scenario) — Sam should cite Ballotpedia /
    # DOE / etc. for retrieval guidance.
    cid = f"urlfmt_T1_{int(time.time()*1000)}"
    body = base_race()
    body["conversation_id"] = cid
    body["message"] = "Can you help me with my win totals? I need the 2024 House District 39 results."
    data = chat(body, sess)
    text = text_of(data)
    forms = url_forms_in(text)
    out.write("=" * 78 + "\nT1 — win-totals scenario\n" + "=" * 78 + "\n\n")
    out.write(f"Sam:\n{text}\n\n")
    out.write(f"URL forms detected: {forms}\n")
    has_any_url = any(forms.values())
    show("T1", has_any_url, f"forms={list(forms.keys())}")

    # T2: contribution-limit (compliance) — Sam should cite dos.fl.gov / fec.gov
    cid = f"urlfmt_T2_{int(time.time()*1000)}"
    body = base_race()
    body["conversation_id"] = cid
    body["message"] = "What's the contribution limit per individual donor for my state house race?"
    data = chat(body, sess)
    text = text_of(data)
    forms = url_forms_in(text)
    out.write("=" * 78 + "\nT2 — contribution-limit\n" + "=" * 78 + "\n\n")
    out.write(f"Sam:\n{text}\n\n")
    out.write(f"URL forms detected: {forms}\n")
    has_any_url = any(forms.values())
    show("T2", has_any_url, f"forms={list(forms.keys())}")

    # T3: filing/qualifying — should cite dos.fl.gov for compliance
    cid = f"urlfmt_T3_{int(time.time()*1000)}"
    body = base_race()
    body["conversation_id"] = cid
    body["message"] = "When does qualifying open for my race?"
    data = chat(body, sess)
    text = text_of(data)
    forms = url_forms_in(text)
    out.write("=" * 78 + "\nT3 — qualifying open\n" + "=" * 78 + "\n\n")
    out.write(f"Sam:\n{text}\n\n")
    out.write(f"URL forms detected: {forms}\n")
    has_any_url = any(forms.values())
    show("T3", has_any_url, f"forms={list(forms.keys())}")

    out.write("=" * 78 + "\nSUMMARY\n" + "=" * 78 + "\n")
    out.write(f"Pass: {overall['pass']}  Fail: {overall['fail']}\n")
    out.close()
    print(f"Done. Pass: {overall['pass']}  Fail: {overall['fail']}")


if __name__ == "__main__":
    main()
