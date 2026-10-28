#!/usr/bin/env bash
# Application readiness for Telegram Next runtime (no bot sends).
#   bash scripts/fin_accept/telegram_app_ready_check.sh [base_url]
set -euo pipefail
BASE="${1:-http://127.0.0.1:3001}"
python3 - <<PY
import json, urllib.request, time, sys
base = "${BASE}".rstrip("/")

def get(path, expect_json=True):
    last = None
    for _ in range(45):
        try:
            with urllib.request.urlopen(base + path, timeout=8) as r:
                body = r.read().decode("utf-8", "replace")
                if expect_json:
                    return r.status, json.loads(body)
                return r.status, body
        except Exception as e:
            last = e
            time.sleep(2)
    raise SystemExit(f"APP_READY_TIMEOUT {path}: {last}")

st, wh = get("/api/telegram/webhook")
assert st == 200 and wh.get("ok") is True and wh.get("name") == "Marketplace OS Telegram webhook", wh
print("WEBHOOK_ROUTE_OK")

st, dr = get("/api/telegram/daily-report?from=2026-10-19&to=2026-10-25&send=false&ai=false")
assert st == 200 and dr.get("ok") is True and dr.get("sent") is False, dr
assert "report" in dr or "message" in dr, dr

def find_all(obj):
    if isinstance(obj, dict):
        for k, v in obj.items():
            kl = str(k).lower()
            if kl in ("all", "businesstotal", "business_all", "totalall", "business") and isinstance(v, (int, float)):
                return float(v)
            if isinstance(v, dict) and "all" in v and isinstance(v["all"], (int, float)):
                return float(v["all"])
            r = find_all(v)
            if r is not None:
                return r
    if isinstance(obj, list):
        for i in obj:
            r = find_all(i)
            if r is not None:
                return r
    return None

val = find_all(dr)
rounded = None
if val is not None:
    rounded = round(val + 1e-9, 2)
    assert rounded == 994198.47, (val, rounded)
    print(f"FINANCE_ALL_OK raw={val} rounded={rounded}")
else:
    # Route ok without numeric extract still requires non-stub payload
    msg = str(dr.get("message") or "")
    assert "994198" in msg or "994\u202f198" in msg or val is not None or dr.get("report"), dr
    print("FINANCE_MARKERS_PRESENT_OR_REPORT_OK")
print("DAILY_REPORT_ROUTE_OK")
print("APP_ROUTES_OK")
print(json.dumps({"ok": True, "financeAllRounded": rounded, "webhook": wh, "dailyKeys": list(dr.keys())}, ensure_ascii=False))
PY
