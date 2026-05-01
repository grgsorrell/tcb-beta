"""Sam v2 Phase 7 — validator failsafe audit (data collection)."""
import json, subprocess, sys

def d1(sql):
    out = subprocess.run(["wrangler.cmd", "d1", "execute", "candidates-toolbox-db",
                          "--remote", "--json", "--command", sql],
                         capture_output=True, text=True, timeout=60)
    if out.returncode != 0: raise RuntimeError(out.stderr)
    return json.loads(out.stdout[out.stdout.find('['):])[0]["results"]


TABLES = [
    'sam_safe_mode_events',
    'sam_blank_response_events',
    'sam_classification_events',
]

print("=" * 70)
print("AUDIT 1 — Total row counts + last-7d distribution")
print("=" * 70)

for t in TABLES:
    total = d1(f"SELECT COUNT(*) AS n FROM {t}")[0]['n']
    last7 = d1(f"SELECT COUNT(*) AS n FROM {t} WHERE created_at > datetime('now','-7 days')")[0]['n']
    print(f"\n{t}: total={total}, last_7d={last7}")
    # Group by action_taken (or category for classification)
    if t == 'sam_classification_events':
        rows = d1(f"SELECT classified_category AS bucket, COUNT(*) AS n FROM {t} GROUP BY bucket ORDER BY n DESC")
    elif t == 'sam_blank_response_events':
        rows = d1(f"SELECT CASE WHEN fallback_used=1 THEN 'fallback_used' WHEN retry_blanked=1 THEN 'retry_blanked' WHEN original_blanked=1 THEN 'recovered_on_retry' ELSE 'other' END AS bucket, COUNT(*) AS n FROM {t} GROUP BY bucket")
    elif t == 'sam_safe_mode_events':
        rows = d1(f"SELECT 'activations' AS bucket, COUNT(*) AS n FROM {t}")
    else:
        rows = d1(f"SELECT action_taken AS bucket, COUNT(*) AS n FROM {t} GROUP BY bucket ORDER BY n DESC")
    for r in rows:
        print(f"  {r.get('bucket', 'n/a')}: {r.get('n', 0)}")

print("\n" + "=" * 70)
print("AUDIT 1 — Schema check per table")
print("=" * 70)

for t in TABLES:
    cols = d1(f"PRAGMA table_info({t})")
    col_names = [c['name'] for c in cols]
    print(f"\n{t}: {col_names}")
    idx = d1(f"PRAGMA index_list({t})")
    idx_names = [i['name'] for i in idx if not i['name'].startswith('sqlite_autoindex')]
    print(f"  indexes: {idx_names}")

print("\n" + "=" * 70)
print("AUDIT 1 — Sample stripped/regenerated events per table")
print("=" * 70)

for t in ['sam_validation_events', 'sam_compliance_validation_events', 'sam_finance_validation_events', 'sam_donation_validation_events', 'sam_opponent_validation_events', 'sam_citation_validation_events']:
    rows = d1(f"SELECT action_taken, original_response_excerpt, final_response_excerpt FROM {t} WHERE action_taken IN ('stripped','regenerated','regenerated_with_citation','regenerated_with_url') ORDER BY created_at DESC LIMIT 2")
    print(f"\n{t}:")
    if not rows:
        print("  (no strip/regen events)")
    for r in rows:
        print(f"  [{r['action_taken']}] orig: {(r.get('original_response_excerpt') or '')[:140]}")
        print(f"     final: {(r.get('final_response_excerpt') or '')[:140]}")
