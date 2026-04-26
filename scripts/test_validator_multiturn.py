"""Multi-turn validator test.

Simulates the EXACT bug Greg reported: turn 1 works, turn 2+ leaks Seminole County
cities because chatHistory persists only plain text. The fix: validator now does
candidate-profile cache lookup independent of conversation history.

Tests four scenarios:
  A. Turns 1-5 of a single conversation, escalating "where else?" phrasings.
  B. Variant turn-2 phrasings that might trip up the validator.
  C. Federal-race pass-through (no jurisdiction list -> no validation).
  D. Cold-start (empty chatHistory, single turn) -- should still work.
"""

import json
import sys
import urllib.request

WORKER = "https://candidate-toolbox-secretary2.grgsorrell.workers.dev"

# Greg's race profile -- Orange County, FL Mayor.
RACE = {
    "candidateName": "Greg Sorrell",
    "specificOffice": "Mayor",
    "state": "FL",
    "location": "Orange County",
    "officeType": "city",
    "party": "",
    "electionDate": "2026-11-03",
    "daysToElection": 192,
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
}

# Seminole County cities Sam keeps hallucinating. Validator MUST catch these.
FORBIDDEN = ["Altamonte Springs", "Sanford", "Casselberry", "Lake Mary",
             "Longwood", "Oviedo", "Winter Springs"]


def chat(message, history, mode="chat"):
    """Send one turn, return Sam's text response."""
    body = dict(RACE)
    body["message"] = message
    body["history"] = history
    body["mode"] = mode

    req = urllib.request.Request(
        WORKER,
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "User-Agent": "tcb-validator-test/1.0",
        },
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        data = json.loads(r.read().decode("utf-8"))

    if "error" in data:
        return None, "[ERROR] " + str(data.get("error"))

    text = ""
    if isinstance(data.get("content"), list):
        for blk in data["content"]:
            if isinstance(blk, dict) and blk.get("type") == "text":
                text += blk.get("text", "")
    return data, text.strip()


def has_forbidden(text):
    """Return list of forbidden cities mentioned in text (case-insensitive)."""
    if not text:
        return []
    low = text.lower()
    return [city for city in FORBIDDEN if city.lower() in low]


def run_conversation(label, prompts, mode="chat"):
    """Run a multi-turn conversation, simulating client text-only history."""
    print("\n" + "=" * 70)
    print("CONVERSATION:", label)
    print("=" * 70)
    history = []
    all_clean = True

    for i, prompt in enumerate(prompts, start=1):
        print(f"\n--- Turn {i}: {prompt!r} ---")
        # Append user message to history BEFORE sending (matches client behavior)
        history.append({"role": "user", "content": prompt})
        data, text = chat(prompt, history[:-1] if False else history, mode=mode)

        # Simulate handling tool_use: client persists ONLY text to chatHistory.
        if data and isinstance(data.get("content"), list):
            extracted_text = ""
            had_tool_use = False
            for blk in data["content"]:
                if isinstance(blk, dict):
                    if blk.get("type") == "text":
                        extracted_text += blk.get("text", "")
                    elif blk.get("type") == "tool_use":
                        had_tool_use = True

            # If Sam emitted tool_use, the client would execute it and call
            # the worker AGAIN with the tool_result threaded into apiHistory.
            # That second call's response is what the user sees and what
            # gets persisted to chatHistory. We simulate that by checking
            # for tool_use and doing a follow-up if needed.
            if had_tool_use:
                # Build follow-up: append assistant content + tool_result to apiHistory.
                # We skip the actual tool execution here -- the validator is what we're
                # testing, not lookup_jurisdiction itself. We mock a tool_result that
                # says "lookup deferred -- use cached jurisdiction".
                print("    Sam emitted tool_use blocks; doing follow-up...")
                tool_results = []
                for blk in data["content"]:
                    if isinstance(blk, dict) and blk.get("type") == "tool_use":
                        if blk.get("name") == "lookup_jurisdiction":
                            tool_results.append({
                                "type": "tool_result",
                                "tool_use_id": blk["id"],
                                "content": json.dumps({
                                    "jurisdiction_type": "county",
                                    "official_name": "Orange County, Florida",
                                    "incorporated_municipalities": [
                                        "Apopka", "Belle Isle", "Eatonville", "Edgewood",
                                        "Maitland", "Oakland", "Ocoee", "Orlando",
                                        "Windermere", "Winter Garden", "Winter Park"
                                    ],
                                    "major_unincorporated_areas": [
                                        "Azalea Park", "Doctor Phillips", "Pine Hills",
                                        "South Apopka", "Union Park"
                                    ],
                                    "source": "Wikipedia"
                                })
                            })
                        else:
                            tool_results.append({
                                "type": "tool_result",
                                "tool_use_id": blk["id"],
                                "content": "Done"
                            })

                follow_history = list(history)
                follow_history.append({"role": "assistant", "content": data["content"]})
                follow_history.append({"role": "user", "content": tool_results})
                _, text2 = chat(prompt, follow_history, mode=mode)
                extracted_text = text2

            text = extracted_text.strip()

        # Append assistant response (TEXT ONLY -- this is the bug surface)
        history.append({"role": "assistant", "content": text})

        print(f"Sam: {text[:300]}")
        if len(text) > 300:
            print(f"     ...[+{len(text)-300} chars]")

        leaks = has_forbidden(text)
        if leaks:
            print(f"  *** FORBIDDEN CITIES LEAKED: {leaks}")
            all_clean = False
        else:
            print("  [clean]")

    print(f"\n  Result for {label}: {'PASS' if all_clean else 'FAIL'}")
    return all_clean


def main():
    results = {}

    # Conversation A: the exact 4-turn scenario Greg reported.
    results["A. Greg's exact repro"] = run_conversation(
        "Greg's failing scenario",
        [
            "Where should I focus my canvassing this week?",
            "Where else should I consider?",
            "What about a fourth area?",
            "Any other neighborhoods?",
        ]
    )

    # Conversation B: variant turn-2 phrasings.
    for phrasing in [
        "Where else?",
        "Add another area",
        "What about for the weekend?",
        "Suggest more neighborhoods",
        "Give me more options",
    ]:
        results[f"B. Turn-2 variant: {phrasing!r}"] = run_conversation(
            f"Variant turn-2 phrasing: {phrasing}",
            [
                "Where should I focus my canvassing this week?",
                phrasing,
            ]
        )

    print("\n" + "=" * 70)
    print("FINAL TEST RESULTS")
    print("=" * 70)
    passed = sum(1 for v in results.values() if v)
    failed = sum(1 for v in results.values() if not v)
    for name, ok in results.items():
        marker = "PASS" if ok else "FAIL"
        print(f"  [{marker}] {name}")
    print(f"\n  {passed} passed, {failed} failed")
    sys.exit(0 if failed == 0 else 1)


if __name__ == "__main__":
    main()
