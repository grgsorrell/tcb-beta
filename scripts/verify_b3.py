"""B3 verification — re-run the generic political news query and dump
the FULL raw response including tool_use queries and web_search_tool_result
content blocks. Lets Greg verify whether Sam's specific claims came from
search results or fabrication."""

import json
import sys
import time
import urllib.request

W = "https://candidate-toolbox-secretary2.grgsorrell.workers.dev"


def login():
    req = urllib.request.Request(
        W + "/auth/beta-login",
        data=json.dumps({"username": "greg", "password": "Beta#01"}).encode(),
        headers={"Content-Type": "application/json", "User-Agent": "tcb-b3v/1.0"}
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())["sessionId"]


def chat(body, session):
    req = urllib.request.Request(W,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json",
                 "User-Agent": "tcb-b3v/1.0",
                 "Authorization": f"Bearer {session}"})
    with urllib.request.urlopen(req, timeout=180) as r:
        return json.loads(r.read())


def main():
    sess = login()
    body = {
        "candidateName": "Stephanie Murphy",
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
        "message": "What are recent news headlines about Florida mayoral races?",
        "conversation_id": f"b3v_{int(time.time()*1000)}"
    }
    data = chat(body, sess)

    out = open("scripts/b3_verify_output.txt", "w", encoding="utf-8", newline="\n")
    out.write("B3 verification — full raw response\n")
    out.write("=" * 78 + "\n\n")
    out.write(f"Q: {body['message']}\n\n")

    if not isinstance(data.get("content"), list):
        out.write(f"Unexpected response shape: {json.dumps(data, indent=2)[:1000]}\n")
        out.close()
        return

    # Pretty-print each content block — full JSON to catch citation metadata
    for i, blk in enumerate(data["content"]):
        block_type = blk.get("type") if isinstance(blk, dict) else type(blk).__name__
        out.write(f"--- Block {i}: type={block_type} ---\n")
        if not isinstance(blk, dict):
            out.write(repr(blk) + "\n\n"); continue
        if blk.get("type") == "text":
            out.write("text content:\n" + blk.get("text", "") + "\n")
            cit = blk.get("citations")
            if cit:
                out.write(f"citations ({len(cit)}):\n")
                for c in cit:
                    out.write(f"  - {json.dumps(c, indent=2)[:1000]}\n")
            other_keys = [k for k in blk.keys() if k not in ('type', 'text', 'citations')]
            if other_keys:
                out.write(f"other fields on block: {other_keys}\n")
                for k in other_keys:
                    out.write(f"  {k}: {json.dumps(blk[k], indent=2)[:500]}\n")
            out.write("\n")
        elif blk.get("type") == "tool_use":
            out.write(f"  name: {blk.get('name')}\n")
            out.write(f"  id:   {blk.get('id')}\n")
            out.write(f"  input: {json.dumps(blk.get('input'), indent=2)}\n\n")
        elif blk.get("type") == "web_search_tool_result":
            out.write(f"  tool_use_id: {blk.get('tool_use_id')}\n")
            content = blk.get("content")
            if isinstance(content, list):
                for j, item in enumerate(content):
                    if isinstance(item, dict):
                        out.write(f"  result[{j}]:\n")
                        out.write(f"    title: {item.get('title')}\n")
                        out.write(f"    url:   {item.get('url')}\n")
                        page_age = item.get("page_age")
                        if page_age: out.write(f"    page_age: {page_age}\n")
                        # Page content excerpt
                        page_content = item.get("encrypted_content") or item.get("page_content") or item.get("content")
                        if isinstance(page_content, str):
                            excerpt = page_content[:1500]
                            out.write(f"    content_excerpt:\n{excerpt}\n")
                            if len(page_content) > 1500:
                                out.write(f"    [...{len(page_content)-1500} more chars]\n")
                        out.write("\n")
                    else:
                        out.write(f"  result[{j}]: {repr(item)[:500]}\n")
            else:
                out.write(f"  content: {json.dumps(content, indent=2)[:2000]}\n")
            out.write("\n")
        else:
            out.write(f"  (full block JSON):\n{json.dumps(blk, indent=2)[:3000]}\n\n")

    # Also print which specific claims should be verifiable
    out.write("=" * 78 + "\n")
    out.write("CLAIMS TO VERIFY in Sam's text against tool_result content:\n")
    out.write("=" * 78 + "\n")
    claims = [
        "Nick Nesta", "Christine Moore", "Apopka",
        "City Councilman", "Orange County Commissioner",
        "62%", "runoff", "defeated"
    ]
    full_text = "".join(b.get("text", "") for b in data["content"]
                        if isinstance(b, dict) and b.get("type") == "text")
    full_results = ""
    for b in data["content"]:
        if isinstance(b, dict) and b.get("type") == "web_search_tool_result":
            content = b.get("content", [])
            if isinstance(content, list):
                for item in content:
                    if isinstance(item, dict):
                        full_results += " " + (item.get("title") or "") + " " + (item.get("url") or "")
                        pc = item.get("encrypted_content") or item.get("page_content") or item.get("content") or ""
                        if isinstance(pc, str):
                            full_results += " " + pc

    for c in claims:
        in_text = c in full_text
        in_results = c.lower() in full_results.lower()
        out.write(f"  {c!r}: in Sam's text={in_text}, in web_search results={in_results}\n")

    out.close()
    with open("scripts/b3_verify_output.txt", "r", encoding="utf-8") as f:
        sys.stdout.buffer.write(f.read().encode("utf-8"))


if __name__ == "__main__":
    main()
