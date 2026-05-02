"""Admin dashboard MVP — functional tests 1-15.

Covers:
  T1.  Migration columns exist
  T2.  Greg's is_admin = 1 verified
  T3.  Greg can hit /api/admin/users (200)
  T4.  Shannan hits /api/admin/users → 403 admin_required
  T5.  List shows beta users + others, no @sub.tcb anchors
  T6.  Sort: last_login DESC, NULLs last
  T7.  Greg can hit /api/admin/users/{greg_id} (200)
  T8.  Cost summary non-zero for greg
  T9.  Cost breakdown contains Sam chat / Classifier / Validators
  T10. Disable on Greg → cannot_disable_admin OR cannot_disable_self (Greg is both)
  T11. Disable Shannan via Greg's admin session → success
  T12. Shannan API call after disable → 403 account_disabled
  T13. Re-enable Shannan via Greg → success
  T14. Shannan API call after re-enable → 200
  T15. Audit log shows two rows (disable + enable for shannan)
"""
import json, subprocess, time, urllib.request, urllib.error

W = "https://candidate-toolbox-secretary2.grgsorrell.workers.dev"


def login(username):
    req = urllib.request.Request(W + "/auth/beta-login",
        data=json.dumps({"username": username, "password": "Beta#01"}).encode(),
        headers={"Content-Type": "application/json", "User-Agent": "tcb-admin/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        return {"error": e.code, "body": e.read().decode(errors="replace")}


def api(path, sess, method="GET"):
    h = {"Content-Type": "application/json", "User-Agent": "tcb-admin/1.0"}
    if sess: h["Authorization"] = "Bearer " + sess
    req = urllib.request.Request(W + path, data=b"" if method == "POST" else None,
                                  headers=h, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return {"status": r.status, "body": json.loads(r.read())}
    except urllib.error.HTTPError as e:
        b = {}
        try: b = json.loads(e.read())
        except Exception: pass
        return {"status": e.code, "body": b}


def d1(sql):
    out = subprocess.run(["wrangler.cmd", "d1", "execute", "candidates-toolbox-db",
                          "--remote", "--json", "--command", sql],
                         capture_output=True, text=True, timeout=60)
    if out.returncode != 0: raise RuntimeError(out.stderr)
    if not out.stdout.strip(): return []
    return json.loads(out.stdout[out.stdout.find('['):])[0].get("results", [])


def main():
    out_path = "scripts/admin_dashboard_output.txt"
    f = open(out_path, "w", encoding="utf-8", newline="\n")
    f.write(f"Admin dashboard MVP — functional tests\nRun: {time.strftime('%Y-%m-%d %H:%M:%S')}\n"
            + "=" * 78 + "\n\n")

    overall = {"pass": 0, "fail": 0}
    def show(label, ok, why=""):
        st = "PASS" if ok else "FAIL"
        f.write(f"{label}: {st}{(' — ' + why) if why else ''}\n\n")
        overall["pass" if ok else "fail"] += 1

    # ------------------------------------------------------------------
    # T1 — migration columns exist
    cols = d1("PRAGMA table_info(users)")
    col_names = [c['name'] for c in cols]
    has_admin = 'is_admin' in col_names
    has_disabled = 'is_disabled' in col_names
    audit_tbl = d1("SELECT name FROM sqlite_master WHERE type='table' AND name='admin_audit_log'")
    has_audit = bool(audit_tbl)
    f.write(f"T1 columns: is_admin={has_admin}, is_disabled={has_disabled}, audit_table={has_audit}\n")
    show("T1", has_admin and has_disabled and has_audit)

    # ------------------------------------------------------------------
    # T2 — greg.is_admin=1
    greg_row = d1("SELECT id, username, is_admin, is_disabled FROM users WHERE username='greg'")
    f.write(f"T2 greg row: {greg_row}\n")
    greg_admin = bool(greg_row) and greg_row[0]['is_admin'] == 1
    greg_id = greg_row[0]['id'] if greg_row else None
    show("T2", greg_admin, f"greg_id={greg_id}")

    # ------------------------------------------------------------------
    # T3 — greg login + /api/admin/users 200
    greg_login = login("greg")
    greg_sess = greg_login.get("sessionId") if isinstance(greg_login, dict) else None
    list_r = api("/api/admin/users", greg_sess)
    f.write(f"T3 list status: {list_r['status']}, user count: {len(list_r['body'].get('users', []))}\n")
    show("T3", list_r['status'] == 200 and 'users' in list_r['body'])

    # ------------------------------------------------------------------
    # T4 — shannan login + /api/admin/users 403
    shannan_login = login("shannan")
    shannan_sess = shannan_login.get("sessionId") if isinstance(shannan_login, dict) else None
    list_s = api("/api/admin/users", shannan_sess)
    f.write(f"T4 shannan list status: {list_s['status']}, error: {list_s['body'].get('error')}\n")
    show("T4", list_s['status'] == 403 and list_s['body'].get('error') == 'admin_required')

    # ------------------------------------------------------------------
    # T5 — list shows beta users, no @sub.tcb
    users = list_r['body'].get('users', [])
    sub_tcb = [u for u in users if (u.get('email') or '').endswith('@sub.tcb')]
    has_beta = any(u.get('username') in ('greg','shannan','cjc','jerry') for u in users)
    f.write(f"T5 sub_tcb in list: {len(sub_tcb)}, has_beta_users: {has_beta}\n")
    show("T5", len(sub_tcb) == 0 and has_beta)

    # ------------------------------------------------------------------
    # T6 — sort order
    last_logins = [u.get('last_login') for u in users]
    # NULLs should be at the end
    nones_at_end = True
    seen_none = False
    for v in last_logins:
        if v is None: seen_none = True
        elif seen_none: nones_at_end = False; break
    # Non-null portion descending
    non_null = [v for v in last_logins if v is not None]
    desc_ok = all(non_null[i] >= non_null[i+1] for i in range(len(non_null)-1))
    f.write(f"T6 nones_at_end={nones_at_end}, desc_order={desc_ok}, last_logins={last_logins[:5]}…\n")
    show("T6", nones_at_end and desc_ok)

    # ------------------------------------------------------------------
    # T7 — detail endpoint for greg
    detail_r = api(f"/api/admin/users/{greg_id}", greg_sess)
    f.write(f"T7 detail status: {detail_r['status']}\n")
    show("T7", detail_r['status'] == 200)

    # ------------------------------------------------------------------
    # T8 — cost summary non-zero
    cs = detail_r['body'].get('cost_summary', {})
    f.write(f"T8 cost_summary: {cs}\n")
    show("T8", cs.get('lifetime', 0) > 0)

    # ------------------------------------------------------------------
    # T9 — breakdown contains Sam chat / Classifier / Validators
    bk_lifetime = detail_r['body'].get('breakdown_lifetime', [])
    cats = [r.get('category') for r in bk_lifetime]
    f.write(f"T9 lifetime categories: {cats}\n")
    has_chat = 'Sam chat' in cats
    has_cls = 'Classifier' in cats
    has_val = 'Validators' in cats
    show("T9", has_chat and has_cls and has_val,
         f"sam_chat={has_chat}, classifier={has_cls}, validators={has_val}")

    # ------------------------------------------------------------------
    # T10 — disable on greg refuses (greg is both admin AND self → cannot_disable_self fires first)
    dis_self = api(f"/api/admin/users/{greg_id}/disable", greg_sess, method="POST")
    f.write(f"T10 disable greg→ status={dis_self['status']}, error={dis_self['body'].get('error')}\n")
    err = dis_self['body'].get('error')
    show("T10", dis_self['status'] == 400 and err in ('cannot_disable_admin', 'cannot_disable_self'))

    # ------------------------------------------------------------------
    # T11 — disable shannan via greg.
    # Use the userId returned by the beta-login (session-bound) — the
    # /auth/beta-login flow creates/uses a user keyed on shannan@beta.tcb,
    # which is a different row from shannan's real-email account if she
    # has one. Test must disable the row her session points to.
    shannan_id = shannan_login.get("userId")
    dis_shannan = api(f"/api/admin/users/{shannan_id}/disable", greg_sess, method="POST")
    f.write(f"T11 disable shannan (session-bound id={shannan_id}): "
            f"status={dis_shannan['status']}, body={dis_shannan['body']}\n")
    show("T11", dis_shannan['status'] == 200 and dis_shannan['body'].get('success') == True)

    # ------------------------------------------------------------------
    # T12 — shannan API call after disable → 403
    # 5s wait for D1 read-after-write consistency across colos.
    time.sleep(5)
    after_dis = api("/api/admin/users", shannan_sess)
    body12 = after_dis['body']
    # Could 403 with admin_required (because she's not admin) OR account_disabled.
    # The disabled check runs FIRST in the fetch handler so should hit account_disabled.
    f.write(f"T12 shannan after disable: status={after_dis['status']}, error={body12.get('error')}\n")
    show("T12", after_dis['status'] == 403 and body12.get('error') == 'account_disabled')

    # Test on a non-admin endpoint too — load-all is the canonical authed call.
    after_dis2 = api("/api/data/load-all", shannan_sess)
    f.write(f"T12b shannan /api/data/load-all: status={after_dis2['status']}, error={after_dis2['body'].get('error')}\n")

    # ------------------------------------------------------------------
    # T13 — re-enable shannan
    en_shannan = api(f"/api/admin/users/{shannan_id}/enable", greg_sess, method="POST")
    f.write(f"T13 enable shannan: status={en_shannan['status']}, body={en_shannan['body']}\n")
    show("T13", en_shannan['status'] == 200 and en_shannan['body'].get('success') == True)

    # ------------------------------------------------------------------
    # T14 — shannan API call after re-enable → 200 (or normal not-403)
    time.sleep(1)
    after_en = api("/api/data/load-all", shannan_sess)
    f.write(f"T14 shannan after re-enable: status={after_en['status']}, "
            f"error={after_en['body'].get('error') if isinstance(after_en['body'], dict) else None}\n")
    show("T14", after_en['status'] == 200)

    # ------------------------------------------------------------------
    # T15 — audit log
    audit = d1(f"SELECT action, admin_user_id, target_user_id FROM admin_audit_log WHERE target_user_id = '{shannan_id}' ORDER BY created_at DESC LIMIT 5")
    f.write(f"T15 audit rows: {audit}\n")
    actions = [r['action'] for r in audit]
    has_dis = 'disable_user' in actions
    has_en = 'enable_user' in actions
    correct_admin = all(r['admin_user_id'] == greg_id for r in audit)
    show("T15", has_dis and has_en and correct_admin,
         f"disable={has_dis}, enable={has_en}, admin_match={correct_admin}")

    f.write("=" * 78 + "\nSUMMARY\n" + "=" * 78 + "\n")
    f.write(f"Pass: {overall['pass']}  Fail: {overall['fail']}\n")
    f.close()
    print(f"Done. Pass: {overall['pass']}  Fail: {overall['fail']}")


if __name__ == "__main__":
    main()
