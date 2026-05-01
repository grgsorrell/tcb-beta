"""Sample stripped/regenerated events per validator."""
import json, subprocess

def d1(sql):
    out = subprocess.run(["wrangler.cmd", "d1", "execute", "candidates-toolbox-db",
                          "--remote", "--json", "--command", sql],
                         capture_output=True, text=True, timeout=60)
    if out.returncode != 0: raise RuntimeError(out.stderr)
    return json.loads(out.stdout[out.stdout.find('['):])[0]["results"]

for t in ['sam_validation_events', 'sam_compliance_validation_events', 'sam_donation_validation_events', 'sam_opponent_validation_events', 'sam_citation_validation_events']:
    print(f"\n=== {t} — sample stripped/regen events ===")
    rows = d1(f"SELECT action_taken, original_response_excerpt, final_response_excerpt FROM {t} WHERE action_taken IN ('stripped','regenerated','regenerated_with_citation','regenerated_with_url') ORDER BY created_at DESC LIMIT 3")
    if not rows:
        print("  (none)")
    for r in rows:
        print(f"\n  [{r['action_taken']}]")
        orig = (r.get('original_response_excerpt') or '')[:200]
        final = (r.get('final_response_excerpt') or '')[:200]
        print(f"  orig:  {orig}")
        print(f"  final: {final}")
