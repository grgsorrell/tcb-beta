"""Schema + index audit per validator table."""
import json, subprocess

def d1(sql):
    out = subprocess.run(["wrangler.cmd", "d1", "execute", "candidates-toolbox-db",
                          "--remote", "--json", "--command", sql],
                         capture_output=True, text=True, timeout=60)
    if out.returncode != 0: raise RuntimeError(out.stderr)
    return json.loads(out.stdout[out.stdout.find('['):])[0]["results"]

REQUIRED_COLS = {'id','conversation_id','workspace_owner_id','user_id','action_taken','original_response_excerpt','final_response_excerpt','created_at'}

TABLES = [
    'sam_validation_events',
    'sam_compliance_validation_events',
    'sam_finance_validation_events',
    'sam_donation_validation_events',
    'sam_opponent_validation_events',
    'sam_citation_validation_events',
    'sam_safe_mode_events',
    'sam_blank_response_events',
    'sam_classification_events',
]

print("=== SCHEMA AUDIT ===\n")
for t in TABLES:
    cols = d1(f"PRAGMA table_info({t})")
    col_names = set(c['name'] for c in cols)
    missing = sorted(REQUIRED_COLS - col_names)
    extras = sorted(col_names - REQUIRED_COLS)
    print(f"{t}:")
    print(f"  cols: {sorted(col_names)}")
    if missing:
        print(f"  MISSING required: {missing}")
    print(f"  extras: {extras}")
    idx = d1(f"PRAGMA index_list({t})")
    idx_names = [i['name'] for i in idx if not i['name'].startswith('sqlite_autoindex')]
    print(f"  indexes: {idx_names}")
    print()
