"""Capture a real RECENT TOOL RESULTS block by:
  1. Running a real chat turn (will fire lookup_jurisdiction)
  2. Loading the resulting row(s) from sam_tool_memory
  3. Formatting via the same logic the worker uses
This is the exact text Haiku will see in the system prompt.
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
    "winNumber": 5000,
    "additionalContext": "",
    "candidateBrief": None,
    "intelContext": {},
    "raceProfile": None,
}


def chat(message, history, conv_id):
    body = dict(RACE)
    body["message"] = message
    body["history"] = history
    body["mode"] = "chat"
    body["conversation_id"] = conv_id
    req = urllib.request.Request(
        WORKER, data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json", "User-Agent": "tcb-sample/1.0"}
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read().decode("utf-8"))


def d1(sql):
    out = subprocess.run(
        ["wrangler.cmd", "d1", "execute", "candidates-toolbox-db", "--remote",
         "--json", "--command", sql],
        capture_output=True, text=True, timeout=60
    )
    if out.returncode != 0:
        raise RuntimeError(out.stderr)
    txt = out.stdout
    return json.loads(txt[txt.find('['):])[0]["results"]


def format_block(rows):
    PER_RESULT = 8000
    TOTAL = 32000
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


def main():
    conv = "sample_" + str(int(time.time()))
    subprocess.run(["wrangler.cmd", "d1", "execute", "candidates-toolbox-db", "--remote",
                    "--command", f"DELETE FROM sam_tool_memory WHERE conversation_id = '{conv}'"],
                   capture_output=True, timeout=60)

    # Turn 1 — fires lookup_jurisdiction
    data = chat("Where should I focus canvassing this week?", [], conv)
    tools = [b for b in data.get("content", []) if b.get("type") == "tool_use"]
    if tools:
        # Mock the tool result for the follow-up so the row gets written
        tool_results = []
        for t in tools:
            if t["name"] == "lookup_jurisdiction":
                tool_results.append({
                    "type": "tool_result",
                    "tool_use_id": t["id"],
                    "content": json.dumps({
                        "jurisdiction_type": "county",
                        "official_name": "Orange County, Florida",
                        "incorporated_municipalities": ["Apopka","Bay Lake","Belle Isle","Eatonville","Edgewood","Lake Buena Vista","Maitland","Oakland","Ocoee","Orlando","Windermere","Winter Garden","Winter Park"],
                        "major_unincorporated_areas": ["Alafaya","Avalon Park","Pine Hills","South Apopka","Union Park"],
                        "source": "Wikipedia"
                    })
                })
        chat("Where should I focus canvassing this week?",
             [{"role": "user", "content": "Where should I focus canvassing this week?"},
              {"role": "assistant", "content": data["content"]},
              {"role": "user", "content": tool_results}], conv)

    rows = d1(f"SELECT tool_name, parameters, result, created_at FROM sam_tool_memory WHERE conversation_id = '{conv}' ORDER BY created_at DESC LIMIT 5")
    print("=" * 70)
    print("EXACT BLOCK INJECTED INTO HAIKU'S SYSTEM PROMPT")
    print("=" * 70)
    print(format_block(rows))
    print("=" * 70)

    # Cleanup
    subprocess.run(["wrangler.cmd", "d1", "execute", "candidates-toolbox-db", "--remote",
                    "--command", f"DELETE FROM sam_tool_memory WHERE conversation_id = '{conv}'"],
                   capture_output=True, timeout=60)


if __name__ == "__main__":
    main()
