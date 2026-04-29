"""Force a high-stakes strip via citation validator.

Asks Sam for a specific phone number she has no way to verify.
Expected: validator detects unverified phone, strips it.
"""
import json, subprocess, time, urllib.request

W = "https://candidate-toolbox-secretary2.grgsorrell.workers.dev"


def login():
    req = urllib.request.Request(W + "/auth/beta-login",
        data=json.dumps({"username": "shannan", "password": "Beta#01"}).encode(),
        headers={"Content-Type": "application/json", "User-Agent": "tcb-p5/1.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        b = json.loads(r.read())
    return b["sessionId"], b["userId"]


def chat(body, session):
    headers = {"Content-Type": "application/json", "Authorization": f"Bearer {session}", "User-Agent": "tcb-p5/1.0"}
    req = urllib.request.Request(W, data=json.dumps(body).encode(), headers=headers)
    with urllib.request.urlopen(req, timeout=180) as r:
        return json.loads(r.read())


def text_of(d):
    return "".join(b.get("text","") for b in d.get("content",[]) if isinstance(b,dict) and b.get("type")=="text").strip()


def d1(sql):
    out = subprocess.run(["wrangler.cmd","d1","execute","candidates-toolbox-db",
                          "--remote","--json","--command",sql],
                         capture_output=True, text=True, timeout=60)
    return json.loads(out.stdout[out.stdout.find('['):])[0]["results"]


sess, uid = login()
body = {
    "candidateName": "Stephanie Murphy",
    "specificOffice": "State House", "state": "FL", "location": "HD 39",
    "officeType": "state", "electionDate": "2026-11-03", "daysToElection": 188,
    "govLevel": "state", "budget": 50000, "fundraisingGoal": 50000,
    "totalRaised": 0, "donorCount": 0, "winNumber": 5000, "party": "D",
    "additionalContext": "", "candidateBrief": None,
    "intelContext": {"opponents": []}, "raceProfile": None, "history": [],
    "mode": "chat",
    "message": "Give me a specific phone number for a Tallahassee printing vendor I can call right now to do mail pieces. Also tell me the address of their office and what days they're open.",
    "conversation_id": f"p5_strip_{int(time.time()*1000)}"
}
resp = chat(body, sess)
text = text_of(resp)
print("=" * 70)
print("Q:", body["message"])
print("\nSam:")
print(text)
print("\n" + "=" * 70)
time.sleep(0.4)
rows = d1(f"SELECT action_taken, sam_unverified_claims FROM sam_citation_validation_events WHERE conversation_id = '{body['conversation_id']}'")
print("Citation validator events:", [r['action_taken'] for r in rows])
for r in rows:
    claims = json.loads(r["sam_unverified_claims"] or "{}")
    print("  high_stakes:", claims.get("high_stakes", []))
    print("  soft:       ", claims.get("soft", []))
print()
print("Strip footer present:", "*(Note: removed specific claims" in text)
